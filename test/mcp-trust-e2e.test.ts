// test/mcp-trust-e2e.test.ts — M19 batch 0 (F1): project-tier mcp config
// rides the M8 trust gate, end-to-end through bin/imp.js (dist). A local
// dummy provider (ANTHROPIC_BASE_URL → 401) keeps the run hermetic; the fake
// stdio MCP server writes a pid file on startup — its absence/presence is the
// witness that refused directories never spawn (and that the --trust control
// would have spawned, so the negative case is not just a missing path).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, "../bin/imp.js");
const SERVER = path.join(import.meta.dirname, "helpers", "mcp-fake-server.mjs");

let provider: Server;
let providerUrl = "";
const sandboxes: string[] = [];

beforeAll(async () => {
	provider = createServer((_req, res) => {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "dummy" } }));
	});
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => provider.close(() => resolve()));
	for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

/** Sandbox repo (cwd) + separate HOME; the project-tier .mcp.json server writes pidFile. */
function makeSandbox(): { dir: string; home: string; pidFile: string } {
	const base = mkdtempSync(path.join(tmpdir(), "imp-mcp-trust-"));
	sandboxes.push(base);
	const dir = path.join(base, "repo");
	const home = path.join(base, "home");
	mkdirSync(dir, { recursive: true });
	mkdirSync(home, { recursive: true });
	const pidFile = path.join(dir, "server.pid");
	writeFileSync(
		path.join(dir, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				fake: {
					command: process.execPath,
					args: [SERVER, "ok"],
					env: { FAKE_MCP_PIDFILE: pidFile },
				},
			},
		}),
		"utf-8",
	);
	return { dir, home, pidFile };
}

/** Run print-mode imp in the sandbox repo; the dummy provider makes it fail fast. */
async function runImp(dir: string, home: string, trustFlag: "--trust" | "--no-trust"): Promise<string> {
	try {
		const out = await run(process.execPath, [BIN, "-p", "hi", trustFlag], {
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				ANTHROPIC_API_KEY: "dummy-key-for-mcp-trust",
				ANTHROPIC_BASE_URL: providerUrl,
			},
			timeout: 60_000,
		});
		return out.stdout + out.stderr;
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string };
		return (e.stdout ?? "") + (e.stderr ?? "");
	}
}

describe("M19 batch 0: project mcp config behind the M8 trust gate (e2e)", () => {
	it("--no-trust: the project's .mcp.json never spawns its server, with a teaching note", async () => {
		const { dir, home, pidFile } = makeSandbox();
		const output = await runImp(dir, home, "--no-trust");
		expect(output).toContain("project config skipped");
		expect(output).not.toContain("tools ready");
		// Any spawn would have happened during the run (connectAll at setup);
		// give a hypothetical orphan a moment anyway before ruling it out.
		await new Promise((r) => setTimeout(r, 1000));
		expect(existsSync(pidFile)).toBe(false);
	}, 90_000);

	it("--trust control: the same config DOES spawn (pid witness) — the gate is the only difference", async () => {
		const { dir, home, pidFile } = makeSandbox();
		const output = await runImp(dir, home, "--trust");
		expect(output).not.toContain("project config skipped");
		expect(await waitUntil(() => existsSync(pidFile), 8000)).toBe(true);
	}, 90_000);
});
