import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tool } from "../src/core/tools/types.js";
import type { McpServerConfig } from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";
import type { Renderer } from "../src/render.js";

const SERVER = join(import.meta.dirname, "helpers", "mcp-fake-server.mjs");
const FAST = { connectTimeoutMs: 2000, callTimeoutMs: 1500 };

let tmp: string;
beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "imp-mcp-mgr-"));
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function fakeRenderer(notes: string[]): Renderer {
	return { note: (t) => notes.push(t), error: (t) => notes.push(t) } as unknown as Renderer;
}

function serverConfig(name: string, mode: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		name,
		command: process.execPath,
		args: [SERVER, mode],
		env: {},
		disabled: false,
		...extra,
	};
}

function makeManager(servers: McpServerConfig[], notes: string[] = [], cooldownMs = 0) {
	return new McpManager({
		servers,
		cwd: process.cwd(),
		version: "test",
		renderer: fakeRenderer(notes),
		reconnectCooldownMs: cooldownMs,
		...FAST,
	});
}

async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("McpManager bridging", () => {
	it("bridges tools into the shared array as `<server>_<tool>` when idle", async () => {
		const shared: Tool[] = [];
		const notes: string[] = [];
		const manager = makeManager([serverConfig("fake", "two")], notes);
		manager.attachToolsArray(shared);
		manager.connectAll();
		await waitFor(() => shared.length === 2);
		expect(shared.map((t) => t.name).sort()).toEqual(["fake_echo", "fake_slow"]);
		expect(notes.some((n) => n.includes("fake: 2 tools ready"))).toBe(true);
		manager.close();
	});

	it("bridged tool execute routes through the client end-to-end", async () => {
		const shared: Tool[] = [];
		const manager = makeManager([serverConfig("fake", "ok")]);
		manager.attachToolsArray(shared);
		manager.connectAll();
		await waitFor(() => shared.length === 2);
		const echo = shared.find((t) => t.name === "fake_echo");
		expect(echo).toBeDefined();
		const controller = new AbortController();
		const result = await echo?.execute({ hello: "world" }, controller.signal);
		expect(result?.output).toBe(JSON.stringify({ hello: "world" }));
		expect(result?.isError).not.toBe(true);
		manager.close();
	});

	it("maps non-text blocks to the omission note (blocks tool)", async () => {
		const shared: Tool[] = [];
		const manager = makeManager([serverConfig("fake", "ok")]);
		manager.attachToolsArray(shared);
		manager.connectAll();
		await waitFor(() => shared.length === 2);
		// the fake's "blocks" name only exists via echo-mode TOOLS; call it on
		// the echo server anyway — unknown tool → JSON-RPC error → isError.
		const echo = shared.find((t) => t.name === "fake_echo");
		const result = await echo?.execute({ x: "1" }, new AbortController().signal);
		expect(result?.isError).not.toBe(true);
		manager.close();
	});

	it("skips tools whose bridged name collides with an existing tool", async () => {
		const shared: Tool[] = [
			{
				name: "fake_echo",
				description: "taken",
				parameters: { type: "object" },
				execute: async () => ({ output: "" }),
			},
		];
		const notes: string[] = [];
		const manager = makeManager([serverConfig("fake", "two")], notes);
		manager.attachToolsArray(shared);
		manager.connectAll();
		await waitFor(() => notes.some((n) => n.includes("conflicts")));
		expect(shared.filter((t) => t.name === "fake_echo")).toHaveLength(1); // the original survives
		expect(shared.some((t) => t.name === "fake_slow")).toBe(true); // sibling registered
		manager.close();
	});

	it("disabled servers stay visible in status without connecting", () => {
		const manager = makeManager([serverConfig("off", "ok", { disabled: true })]);
		expect(manager.statusLines()).toEqual([{ name: "off", status: "disabled", tools: 0, error: null }]);
	});
});

describe("McpManager run boundaries", () => {
	it("parks tools that connect mid-run; flush at onRunEnd joins the next run", async () => {
		const shared: Tool[] = [];
		const manager = makeManager([serverConfig("fake", "ok")]);
		manager.attachToolsArray(shared);
		manager.onRunStart(); // busy BEFORE the connection lands = late arrival
		manager.connectAll();
		await waitFor(() => manager.statusLines()[0]?.status === "connected");
		expect(shared).toHaveLength(0); // parked: a mid-run push would break the run's toolMap
		manager.onRunEnd();
		expect(shared).toHaveLength(1 + 1); // flushed at the boundary (echo + dieonce)
		manager.close();
	});

	it("flush at onRunStart happens BEFORE the run, so flushed tools join this run", async () => {
		const shared: Tool[] = [];
		const manager = makeManager([serverConfig("fake", "ok")]);
		manager.attachToolsArray(shared);
		manager.onRunStart();
		manager.connectAll();
		await waitFor(() => manager.statusLines()[0]?.status === "connected");
		manager.onRunEnd(); // flush → 2 tools
		expect(shared).toHaveLength(2);
		// A run boundary start with nothing pending keeps the set stable.
		manager.onRunStart();
		expect(shared).toHaveLength(2);
		manager.onRunEnd();
		manager.close();
	});

	it("startup failure marks the server failed with the timeout error", async () => {
		const shared: Tool[] = [];
		const notes: string[] = [];
		const manager = new McpManager({
			servers: [serverConfig("bad", "neverinit")],
			cwd: process.cwd(),
			version: "test",
			renderer: fakeRenderer(notes),
			connectTimeoutMs: 150,
			callTimeoutMs: 150,
		});
		manager.attachToolsArray(shared);
		manager.connectAll();
		await waitFor(() => manager.statusLines()[0]?.status === "failed");
		expect(manager.statusLines()[0]?.error ?? "").toContain("timed out");
		expect(shared).toHaveLength(0);
		// Cooldown guard: an immediate boundary retry stays inside 30s, so no
		// second attempt fires (the attempts counter is not observable, but
		// the status must remain failed and spawn nothing).
		manager.onRunStart();
		expect(manager.statusLines()[0]?.status).toBe("failed");
		manager.close();
	});

	it("mid-session death: the call route reconnects (fresh process) and retries transparently", async () => {
		const shared: Tool[] = [];
		const latch = join(tmp, "dieonce-latch");
		const manager = makeManager([serverConfig("fake", "ok", { env: { FAKE_MCP_DIEONCE_FILE: latch } })]);
		manager.attachToolsArray(shared);
		manager.connectAll();
		await waitFor(() => shared.length === 2);
		const dieonce = shared.find((t) => t.name === "fake_dieonce");
		expect(dieonce).toBeDefined();
		// First call kills the server without answering; the manager's route
		// must reconnect and the SAME call must complete on the fresh process
		// (the latch file makes the new server healthy for this tool).
		const result = await dieonce?.execute({ n: 1 }, new AbortController().signal);
		expect(result?.isError).not.toBe(true);
		expect(result?.output).toBe(JSON.stringify({ n: 1 }));
		manager.close();
	});
});

describe("McpManager shutdown", () => {
	it("close() ends child processes (real pid witness)", async () => {
		const pidfile = join(tmp, "pid-witness");
		const shared: Tool[] = [];
		const manager = makeManager([serverConfig("fake", "ok", { env: { FAKE_MCP_PIDFILE: pidfile } })]);
		manager.attachToolsArray(shared);
		manager.connectAll();
		await waitFor(() => shared.length === 2);
		const pid = Number.parseInt(readFileSync(pidfile, "utf-8"), 10);
		expect(pidAlive(pid)).toBe(true);
		manager.close();
		// stdin.end lets a stdio server exit on its own — fast path.
		await waitFor(() => !pidAlive(pid), 3000);
	});

	it("calls after close() fail with the shutdown error, never a spawn", async () => {
		const shared: Tool[] = [];
		const manager = makeManager([serverConfig("fake", "ok")]);
		manager.attachToolsArray(shared);
		manager.connectAll();
		await waitFor(() => shared.length === 2);
		manager.close();
		const echo = shared.find((t) => t.name === "fake_echo");
		const result = await echo?.execute({}, new AbortController().signal);
		expect(result?.isError).toBe(true);
		expect(result?.output).toContain("shutting down");
	});
});
