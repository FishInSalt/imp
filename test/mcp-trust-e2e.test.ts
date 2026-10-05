// test/mcp-trust-e2e.test.ts — M19 batch 0 (F1): project-tier mcp config
// rides the M8 trust gate, end-to-end through fixture bin/ink.js (dist). A local
// dummy provider (ANTHROPIC_BASE_URL → 401) keeps the run hermetic; the fake
// stdio MCP server writes a pid file on startup — its absence/presence is the
// witness that refused directories never spawn (and that the --trust control
// would have spawned, so the negative case is not just a missing path).
import { execFile } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CliFixture, createCliFixture, startRejectingProvider } from "./helpers/cli-fixture.js";

const run = promisify(execFile);
const SERVER = path.join(import.meta.dirname, "helpers", "mcp-fake-server.mjs");
let provider: Awaited<ReturnType<typeof startRejectingProvider>>;
const sandboxes: CliFixture[] = [];

beforeAll(async () => {
	provider = await startRejectingProvider();
});

afterAll(async () => {
	await provider.close();
	for (const fixture of sandboxes) fixture.cleanup();
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
function makeSandbox(): { fixture: CliFixture; pidFile: string } {
	const fixture = createCliFixture();
	sandboxes.push(fixture);
	const dir = fixture.cwd;
	const server = path.join(dir, "mcp-fake-server.mjs");
	cpSync(SERVER, server);
	const pidFile = path.join(dir, "server.pid");
	writeFileSync(
		path.join(dir, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				fake: {
					command: process.execPath,
					args: [server, "ok"],
					env: { FAKE_MCP_PIDFILE: pidFile },
				},
			},
		}),
		"utf-8",
	);
	return { fixture, pidFile };
}

/** Run print-mode Ink in the sandbox repo; only the local provider may reject. */
async function runInk(fixture: CliFixture, trustFlag: "--trust" | "--no-trust"): Promise<string> {
	const before = provider.requests.length;
	const failure = await run(process.execPath, [fixture.bin, "-p", "hi", trustFlag], {
		cwd: fixture.cwd,
		env: fixture.env({
			ANTHROPIC_API_KEY: "fixture-key",
			ANTHROPIC_BASE_URL: provider.url,
		}),
		timeout: 10_000,
	}).then(
		() => null,
		(error: unknown) => error as { code?: number; killed?: boolean; stdout?: string; stderr?: string },
	);
	expect(failure?.code).toBe(1);
	expect(failure?.killed ?? false).toBe(false);
	expect(failure?.stderr).toContain("401");
	expect(failure?.stderr).not.toContain("Blocked nonlocal");
	expect(provider.requests.slice(before)).toEqual(["/v1/messages"]);
	return (failure?.stdout ?? "") + (failure?.stderr ?? "");
}

describe("M19 batch 0: project mcp config behind the M8 trust gate (e2e)", () => {
	it("--no-trust: the project's .mcp.json never spawns its server, with a teaching note", async () => {
		const { fixture, pidFile } = makeSandbox();
		const output = await runInk(fixture, "--no-trust");
		expect(output).toContain("project config skipped");
		expect(output).not.toContain("tools ready");
		// Any spawn would have happened during the run (connectAll at setup);
		// give a hypothetical orphan a moment anyway before ruling it out.
		await new Promise((r) => setTimeout(r, 1000));
		expect(existsSync(pidFile)).toBe(false);
	}, 90_000);

	it("--trust control: the same config DOES spawn (pid witness) — the gate is the only difference", async () => {
		const { fixture, pidFile } = makeSandbox();
		const output = await runInk(fixture, "--trust");
		expect(output).not.toContain("project config skipped");
		expect(await waitUntil(() => existsSync(pidFile), 8000)).toBe(true);
	}, 90_000);
});
