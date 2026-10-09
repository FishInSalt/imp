import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

export const NETWORK_PRELOAD = path.join(import.meta.dirname, "network-blocker.cjs");
const repoRoot = path.resolve(import.meta.dirname, "../..");

export interface CliFixture {
	root: string;
	install: string;
	bin: string;
	cwd: string;
	home: string;
	env(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	cleanup(): void;
}

/** Copy the built installation, never its private .env or mutable source links. */
export function createCliFixture(options: { model?: string | null; dotenv?: string } = {}): CliFixture {
	const launcher = path.join(repoRoot, "bin/ink.js");
	if (!existsSync(launcher) || !existsSync(path.join(repoRoot, "dist/cli.js"))) {
		throw new Error("CLI fixture requires bin/ink.js and a fresh build: run npm run build first");
	}
	// Fixture root created outside test context (callers own lifecycle via
	// the returned cleanup()); plain mkdtemp — the §A2 sweep backstops leaks.
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ink-cli-fixture-")));
	const install = path.join(root, "install");
	const cwd = path.join(root, "cwd");
	const home = path.join(root, "home");
	for (const dir of [
		path.join(install, "bin"),
		cwd,
		home,
		path.join(root, "cache"),
		path.join(root, "tmp"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
	cpSync(path.join(repoRoot, "dist"), path.join(install, "dist"), { recursive: true });
	cpSync(launcher, path.join(install, "bin/ink.js"));
	cpSync(path.join(repoRoot, "package.json"), path.join(install, "package.json"));
	// Reuse installed dependencies read-only. No install scripts or package fetches.
	symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(install, "node_modules"), "dir");
	if (options.dotenv !== undefined) writeFileSync(path.join(install, ".env"), options.dotenv);
	const state = path.join(home, ".ink");
	const model = options.model === undefined ? "claude-sonnet-4-5" : options.model;
	return {
		root,
		install,
		cwd,
		home,
		bin: path.join(install, "bin/ink.js"),
		env(overrides = {}) {
			// Deliberate allowlist: no inherited keys, provider URLs, IMP_*, INK_*,
			// proxy settings, loader flags or developer resource paths.
			const env: NodeJS.ProcessEnv = {
				PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
				HOME: home,
				TMPDIR: path.join(root, "tmp"),
				XDG_CACHE_HOME: path.join(root, "cache"),
				XDG_CONFIG_HOME: path.join(root, "config"),
				XDG_DATA_HOME: path.join(root, "data"),
				XDG_STATE_HOME: path.join(root, "state"),
				INK_AUTH_PATH: path.join(state, "auth.json"),
				INK_SETTINGS_PATH: path.join(state, "settings.json"),
				INK_CATALOG_PATH: path.join(state, "models-catalog.json"),
				INK_CATALOG_BASE_URL: process.env.INK_CATALOG_BASE_URL,
				INK_MODEL: model ?? undefined,
				NO_COLOR: "1",
				...overrides,
				// These cannot be accidentally dropped by a test's env override.
				INK_TEST_NETWORK_LOG: path.join(root, "blocked-network.log"),
				NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
			};
			const catalogUrl = env.INK_CATALOG_BASE_URL;
			if (!catalogUrl || new URL(catalogUrl).hostname !== "127.0.0.1") {
				throw new Error("CLI fixture requires an explicit local INK_CATALOG_BASE_URL");
			}
			for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
			return env;
		},
		cleanup: () => {
			const log = path.join(root, "blocked-network.log");
			const blocked = existsSync(log) ? readFileSync(log, "utf8") : "";
			rmSync(root, { recursive: true, force: true });
			if (blocked !== "") throw new Error(blocked);
		},
	};
}

/** Reject a provider call locally, after startup/run_start, without retries. */
export async function startRejectingProvider(): Promise<{
	url: string;
	requests: string[];
	close(): Promise<void>;
}> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		request.resume();
		response.writeHead(401, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				type: "error",
				error: { type: "authentication_error", message: "fixture rejection" },
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Missing local provider address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}

/** Collect a piped interactive CLI and wait for real exit, including kill cleanup. */
export async function collectCliOutput(
	child: ChildProcessWithoutNullStreams,
	input: string,
): Promise<{
	stdout: string;
	stderr: string;
	code: number | null;
}> {
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	// A failed spawn can close stdin before the write is delivered.
	child.stdin.on("error", () => {});
	const result = new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 10_000);
		timer.unref();
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
	child.stdin.end(input);
	const code = await result;
	if (timedOut) throw new Error(`Fixture CLI did not exit within 10000ms: ${stderr}`);
	if (stderr.includes("Blocked nonlocal")) throw new Error(stderr);
	return { stdout, stderr, code };
}
