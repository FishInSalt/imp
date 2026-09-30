// M19 D4 manager semantics for http servers: startup-failure retry at run
// boundaries, and the review-blocker-2 pin — a 404 session expiry must
// BYPASS the reconnect cooldown (with a 60s cooldown, success proves it).
import { describe, expect, it } from "vitest";
import type { McpHttpServerConfig } from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";
import { startFakeMcpHttpServer } from "./helpers/mcp-fake-http-server.js";

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 15));
	}
	return cond();
}

function httpConfig(url: string, name = "fake"): McpHttpServerConfig {
	return { kind: "http", name, url, headers: {}, disabled: false };
}

function makeManager(servers: McpHttpServerConfig[], notes: string[], cooldownMs: number): McpManager {
	return new McpManager({
		servers,
		cwd: process.cwd(),
		version: "test",
		renderer: { note: (t: string) => notes.push(t), error: (t: string) => notes.push(t) } as never,
		reconnectCooldownMs: cooldownMs,
		connectTimeoutMs: 2000,
		callTimeoutMs: 2000,
	});
}

describe("McpManager over http", () => {
	it("startup failure marks failed; the run-boundary retry recovers once the server heals", async () => {
		const fake = await startFakeMcpHttpServer({ failInitialize: 401 });
		const notes: string[] = [];
		const manager = makeManager([httpConfig(fake.url)], notes, 10);
		try {
			manager.connectAll();
			expect(await waitUntil(() => manager.statusLines()[0]?.status === "failed")).toBe(true);
			expect(manager.statusLines()[0]?.error).toMatch(/401/);
			fake.options.failInitialize = undefined;
			await new Promise((r) => setTimeout(r, 30)); // past the 10ms cooldown
			manager.onRunStart();
			expect(await waitUntil(() => manager.statusLines()[0]?.status === "connected")).toBe(true);
			expect(fake.state.initializeCount).toBe(2);
			manager.onRunEnd();
		} finally {
			await manager.close();
			await fake.close();
		}
	});

	it("session expiry (404) bypasses a 60s cooldown and retries the call once", async () => {
		const fake = await startFakeMcpHttpServer();
		const notes: string[] = [];
		const manager = makeManager([httpConfig(fake.url)], notes, 60_000);
		try {
			manager.connectAll();
			expect(await waitUntil(() => manager.statusLines()[0]?.status === "connected")).toBe(true);

			fake.options.expireSessionOnce = true;
			const started = Date.now();
			const result = await manager.callTool("fake", "echo", { text: "x" }, new AbortController().signal);
			const elapsed = Date.now() - started;
			expect(result.output).toBe("pong:x");
			expect(fake.state.initializeCount).toBe(2);
			// A non-bypass reconnect would have been refused by the 60s cooldown
			// ("on cooldown after a recent failure") — ordering proves the bypass.
			expect(elapsed).toBeLessThan(5000);
			expect(manager.statusLines()[0]?.status).toBe("connected");
		} finally {
			await manager.close();
			await fake.close();
		}
	});
});
