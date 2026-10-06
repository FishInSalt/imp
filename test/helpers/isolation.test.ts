import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliFixture, NETWORK_PRELOAD, startRejectingProvider } from "./cli-fixture.js";

const run = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

describe("offline Node preload", () => {
	it("also guards Vitest's own fetch and records swallowed failures", async () => {
		const { takeBlockedAttempts } = createRequire(import.meta.url)(NETWORK_PRELOAD) as {
			takeBlockedAttempts(): string[];
		};
		const log = process.env.INK_TEST_NETWORK_LOG;
		delete process.env.INK_TEST_NETWORK_LOG;
		try {
			expect(() => fetch("https://example.com")).toThrow("Blocked nonlocal");
			expect(takeBlockedAttempts()).toEqual(["Blocked nonlocal test network request (fetch): example.com"]);
		} finally {
			// This request is the guard's explicit negative control, not a test leak.
			takeBlockedAttempts();
			if (log !== undefined) process.env.INK_TEST_NETWORK_LOG = log;
		}
	});

	it.each([
		["fetch", 'await fetch("https://api.anthropic.com/v1/messages")'],
		[
			"fetch+explicit-exit",
			'try { await fetch("https://example.com"); } catch {} console.log("caught"); process.exit(0)',
		],
		[
			"fetch+later-exit-listener",
			'try { await fetch("https://example.com"); } catch {} process.on("exit", () => process.exitCode = 0); console.log("caught"); process.exit(0)',
		],
		[
			"fetch+later-exit-listener-natural",
			'try { await fetch("https://example.com"); } catch {} process.on("exit", () => process.exitCode = 0)',
		],
		["http", 'const http = await import("node:http"); http.get("http://example.com")'],
		["https", 'const https = await import("node:https"); https.get("https://example.com")'],
		["tcp", 'const net = await import("node:net"); net.connect(443, "203.0.113.1")'],
		["tls", 'const tls = await import("node:tls"); tls.connect({host:"example.com", port:443})'],
		[
			"udp",
			'const dgram = await import("node:dgram"); dgram.createSocket("udp4").send("x", 53, "203.0.113.1")',
		],
		["dns", 'const dns = await import("node:dns/promises"); await dns.lookup("example.com")'],
		[
			"resolver",
			'const dns = await import("node:dns"); new dns.Resolver().resolve4("example.com", () => {})',
		],
	])("blocks %s before transmission, even when its error is caught", async (_name, code) => {
		const failure = await run(
			process.execPath,
			[
				"--require",
				NETWORK_PRELOAD,
				"--input-type=module",
				"-e",
				`try { ${code}; } catch {} console.log("caught");`,
			],
			{
				env: { PATH: path.dirname(process.execPath) },
				timeout: 5000,
			},
		).then(
			() => null,
			(error: unknown) => error as { code?: number; stdout?: string; stderr?: string; killed?: boolean },
		);
		expect(failure?.code).toBe(1);
		expect(failure?.killed ?? false).toBe(false);
		expect(failure?.stdout).toBe("caught\n");
		expect(failure?.stderr).toContain("Blocked nonlocal test network request");
	});

	it.each([
		["TCP null path", 'net.connect({ host: "203.0.113.1", port: 443, path: null })'],
		["TCP empty path", 'net.connect({ host: "203.0.113.1", port: 443, path: "" })'],
		["TCP false path", 'net.connect({ host: "203.0.113.1", port: 443, path: false })'],
		["TCP zero path", 'net.connect({ host: "203.0.113.1", port: 443, path: 0 })'],
		["TCP numeric-string port", 'net.connect("443", "203.0.113.1")'],
		["TLS null path", 'tls.connect({ host: "203.0.113.1", port: 443, path: null })'],
		["TCP localhost lookup", 'net.connect({host:"localhost", port:443, lookup})'],
		["TLS localhost lookup", 'tls.connect({host:"localhost", port:443, lookup})'],
		["HTTP localhost lookup", 'http.get({host:"localhost", port:80, lookup})'],
		["HTTPS localhost lookup", 'https.get({host:"localhost", port:443, lookup})'],
		["HTTP agent lookup", 'http.get("http://localhost", {agent: new http.Agent({lookup})})'],
		["HTTPS agent lookup", 'https.get("https://localhost", {agent: new https.Agent({lookup})})'],
	])("rejects %s before lookup or native connect (recording stubs only)", async (_name, expression) => {
		// Install the recording stubs BEFORE loading the guard in an isolated
		// process. Even a guard regression cannot transmit a nonlocal packet.
		const failure = await run(
			process.execPath,
			[
				"--input-type=commonjs",
				"-e",
				`
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
let nativeCalls = 0;
let lookupCalls = 0;
net.Socket.prototype.connect = tls.connect = function () {
 nativeCalls++;
 throw new Error("Native recording stub reached");
};
const lookup = (_host, _options, callback) => {
 lookupCalls++;
 callback(null, "203.0.113.1", 4);
};
require(${JSON.stringify(NETWORK_PRELOAD)});
let message;
try { ${expression}; } catch (error) { message = error.message; }
console.log(JSON.stringify({ nativeCalls, lookupCalls, message }));
`,
			],
			{ env: {}, timeout: 5000 },
		).then(
			() => null,
			(error: unknown) => error as { code?: number; stdout?: string; stderr?: string },
		);
		expect(failure?.code).toBe(1);
		const recorded = JSON.parse(failure?.stdout ?? "{}");
		expect(recorded.nativeCalls).toBe(0);
		expect(recorded.lookupCalls).toBe(0);
		expect(recorded.message).toContain("Blocked nonlocal");
	});

	it.each([
		["send", "udp4", "create", false],
		["sendOffset", "udp4", "constructor", true],
		["connect", "udp4", "create", false],
		["connect", "udp4", "constructor", true],
		["send", "udp6", "create", true],
		["connect", "udp6", "constructor", false],
	])(
		"blocks UDP %s %s %s custom lookup results (async=%s), with native recording stubs",
		async (operation, type, factory, asynchronous) => {
			const failure = await run(
				process.execPath,
				[
					"--input-type=commonjs",
					"-e",
					`
const dgram = require("node:dgram");
const UDP = process.binding("udp_wrap").UDP;
const local = ${JSON.stringify(type === "udp4" ? "127.0.0.1" : "::1")};
const nativeCalls = [];
const binds = [];
for (const method of ["send", "send6", "connect", "connect6"]) {
 UDP.prototype[method] = function (...args) {
  nativeCalls.push({method});
  return method.startsWith("send") ? 2 : 0;
 };
}
for (const method of ["bind", "bind6"]) {
 const original = UDP.prototype[method];
 UDP.prototype[method] = function (address, ...args) {
  if (address !== local) throw new Error("Recording guard forbids nonlocal bind: " + address);
  binds.push(address);
  return original.call(this, address, ...args);
 };
}
require(${JSON.stringify(NETWORK_PRELOAD)});
let poisoned = false;
let poisonedLookups = 0;
const options = {
 type: ${JSON.stringify(type)},
 lookup(_host, family, callback) {
  if (poisoned) poisonedLookups++;
  const deliver = () => callback(null, poisoned ? "203.0.113.1" : local, family);
  ${asynchronous ? "setImmediate(deliver);" : "deliver();"}
 },
};
const socket = ${factory === "create" ? "dgram.createSocket(options)" : "new dgram.Socket(options)"};
(async () => {
 await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.bind(0, local, resolve); // The only native network action: local bind.
 });
 poisoned = true;
 const message = await new Promise(resolve => {
  const done = error => resolve(error?.message ?? "unexpected success");
  ${operation === "connect" ? "socket.connect(53, local, done);" : operation === "sendOffset" ? 'socket.send(Buffer.from("x"), 0, 1, 53, local, done);' : 'socket.send("x", 53, local, done);'}
 });
 await new Promise(resolve => socket.close(resolve));
 console.log(JSON.stringify({nativeCalls, binds, poisonedLookups, message}));
})().catch(error => { console.error(error); process.exitCode = 2; });
`,
				],
				{ env: {}, timeout: 5000 },
			).then(
				() => null,
				(error: unknown) => error as { code?: number; stdout?: string; stderr?: string; killed?: boolean },
			);
			expect(failure?.code).toBe(1);
			expect(failure?.killed ?? false).toBe(false);
			const recorded = JSON.parse(failure?.stdout ?? "{}");
			expect(recorded.nativeCalls).toEqual([]);
			expect(recorded.binds).toEqual([type === "udp4" ? "127.0.0.1" : "::1"]);
			expect(recorded.poisonedLookups).toBe(1);
			expect(recorded.message).toBe("Blocked nonlocal test network request (udp lookup): 203.0.113.1");
		},
	);

	it("allows local UDP send and connect with controlled default lookup", async () => {
		const { stdout } = await run(
			process.execPath,
			[
				"--require",
				NETWORK_PRELOAD,
				"--input-type=commonjs",
				"-e",
				`
const dgram = require("node:dgram");
const receiver = dgram.createSocket("udp4");
const sender = new dgram.Socket("udp4");
(async () => {
 await new Promise(resolve => receiver.bind(0, "127.0.0.1", resolve));
 await new Promise(resolve => sender.bind(0, "127.0.0.1", resolve));
 const messages = [];
 receiver.on("message", message => messages.push(message.toString()));
 const received = () => new Promise(resolve => receiver.once("message", resolve));
 const first = received();
 await new Promise((resolve, reject) => sender.send("send", receiver.address().port, "127.0.0.1", error => error ? reject(error) : resolve()));
 await first;
 await new Promise((resolve, reject) => sender.connect(receiver.address().port, "127.0.0.1", error => error ? reject(error) : resolve()));
 const second = received();
 await new Promise((resolve, reject) => sender.send("connected", error => error ? reject(error) : resolve()));
 await second;
 await Promise.all([new Promise(resolve => sender.close(resolve)), new Promise(resolve => receiver.close(resolve))]);
 console.log(JSON.stringify(messages));
})().catch(error => { console.error(error); process.exitCode = 2; });
`,
			],
			{ env: {}, timeout: 5000 },
		);
		expect(JSON.parse(stdout)).toEqual(["send", "connected"]);
	});

	it("blocks a local HTTP redirect to a nonlocal provider", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(302, { location: "https://api.anthropic.com/v1/messages" });
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("Missing test address");
			const failure = await run(
				process.execPath,
				[
					"--require",
					NETWORK_PRELOAD,
					"--input-type=module",
					"-e",
					`try { await fetch("http://127.0.0.1:${address.port}"); } catch {}`,
				],
				{
					env: {},
					timeout: 5000,
				},
			).then(
				() => null,
				(error: unknown) => error as { code?: number; stderr?: string },
			);
			expect(failure?.code).toBe(1);
			expect(failure?.stderr).toContain("Blocked nonlocal");
			expect(failure?.stderr).toContain("api.anthropic.com");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("allows loopback HTTP/fetch and Unix sockets in a spawned Node process", async () => {
		const server = createServer((_request, response) => response.end("local"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("Missing test address");
			const { stdout } = await run(
				process.execPath,
				[
					"--require",
					NETWORK_PRELOAD,
					"--input-type=module",
					"-e",
					`
const url = "http://127.0.0.1:${address.port}";
console.log(await (await fetch(url)).text());
const http = await import("node:http");
await new Promise((resolve, reject) => http.get(url, r => { r.resume(); r.on("end", resolve); }).on("error", reject));
const net = await import("node:net");
// A nonexistent local socket is allowed through to the OS, not rejected by the guard.
await new Promise(resolve => net.connect("/tmp/ink-no-such-test-socket").on("error", e => { console.log(e.code); resolve(); }));
`,
				],
				{ env: {}, timeout: 5000 },
			);
			expect(stdout).toBe("local\nENOENT\n");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("copied Ink installation", () => {
	it("fails fixture cleanup when a subprocess swallowed a blocked request", async () => {
		const fixture = createCliFixture();
		const failure = await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				'try { await fetch("https://example.com"); } catch {} process.on("exit", () => process.exitCode = 0); process.exit(0)',
			],
			{
				cwd: fixture.cwd,
				env: fixture.env(),
				timeout: 5000,
			},
		).then(
			() => null,
			(error: unknown) => error as { code?: number; stderr?: string },
		);
		expect(failure?.code).toBe(1);
		expect(failure?.stderr).toContain("Blocked nonlocal");
		expect(() => fixture.cleanup()).toThrow("Blocked nonlocal");
		expect(existsSync(fixture.root)).toBe(false);
	});

	it("does not inherit caller state, keys, model or loader/proxy configuration", async () => {
		for (const [key, value] of Object.entries({
			HOME: "/developer/home",
			IMP_MODEL: "old-model",
			IMP_AUTH_PATH: "/developer/old-auth.json",
			IMP_SETTINGS_PATH: "/developer/old-settings.json",
			INK_MODEL: "caller-model",
			INK_AUTH_PATH: "/developer/auth.json",
			ANTHROPIC_API_KEY: "not-a-test-key",
			ANTHROPIC_BASE_URL: "https://example.com",
			HTTPS_PROXY: "https://example.com",
			NODE_OPTIONS: "--require /developer/preload.cjs",
		}))
			vi.stubEnv(key, value);
		const fixture = createCliFixture();
		try {
			const env = fixture.env();
			expect(() => fixture.env({ INK_CATALOG_BASE_URL: "https://pi.dev" })).toThrow("explicit local");
			expect(env.HOME).toBe(fixture.home);
			expect(env.INK_MODEL).toBe("claude-sonnet-4-5");
			for (const key of ["INK_AUTH_PATH", "INK_SETTINGS_PATH", "INK_CATALOG_PATH", "XDG_CACHE_HOME"]) {
				expect(env[key]?.startsWith(`${fixture.root}/`)).toBe(true);
			}
			expect(env.INK_CATALOG_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			for (const key of [
				"IMP_MODEL",
				"IMP_AUTH_PATH",
				"IMP_SETTINGS_PATH",
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_BASE_URL",
				"HTTPS_PROXY",
			]) {
				expect(env[key]).toBeUndefined();
			}
			expect(env.NODE_OPTIONS).toContain(NETWORK_PRELOAD);
			expect(existsSync(path.join(fixture.install, ".env"))).toBe(false);
			expect(realpathSync(fixture.bin)).toBe(fixture.bin);
			const { stdout } = await run(process.execPath, [fixture.bin, "--version"], {
				cwd: fixture.cwd,
				env,
				timeout: 5000,
			});
			expect(stdout.trim()).toBe("Ink 0.2.1");
		} finally {
			fixture.cleanup();
		}
	});

	it("loads only explicitly controlled installation dotenv without bypassing production loading", async () => {
		const fixture = createCliFixture({
			dotenv: "INK_FIXTURE_DOTENV=controlled\nINK_MODEL=wrong-dotenv-model\n",
		});
		const provider = await startRejectingProvider();
		try {
			const marker = path.join(fixture.cwd, "env.json");
			const extension = path.join(fixture.cwd, "probe.mjs");
			writeFileSync(
				extension,
				`import { writeFileSync } from "node:fs";
export default function(api) {
 api.on("run_start", () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({dotenv:process.env.INK_FIXTURE_DOTENV, model:process.env.INK_MODEL})));
}`,
			);
			const failure = await run(process.execPath, [fixture.bin, "-p", "hi", "-e", extension], {
				cwd: fixture.cwd,
				env: fixture.env({ ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: provider.url }),
				timeout: 5000,
			}).then(
				() => null,
				(error: unknown) => error as { code?: number; stderr?: string },
			);
			expect(failure?.code).toBe(1);
			expect(failure?.stderr).toContain("401");
			expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
				dotenv: "controlled",
				model: "claude-sonnet-4-5",
			});
			expect(provider.requests).toEqual(["/v1/messages"]);
		} finally {
			await provider.close();
			fixture.cleanup();
		}
	});
});
