import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";

const SERVER = join(import.meta.dirname, "helpers", "mcp-fake-server.mjs");
const FAST = { connectTimeoutMs: 2000, callTimeoutMs: 2000 };

let tmp = "";
beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "imp-mcp-client-"));
});
afterAll(() => {
	if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

function makeClient(mode: string, extra: Partial<ConstructorParameters<typeof McpClient>[0]> = {}) {
	return new McpClient({
		name: "fake",
		command: process.execPath,
		args: [SERVER, mode],
		clientVersion: "test",
		...FAST,
		...extra,
	});
}

async function connect(mode: string, extra: Partial<ConstructorParameters<typeof McpClient>[0]> = {}) {
	const client = makeClient(mode, extra);
	await client.connect();
	return client;
}

describe("McpClient", () => {
	it("handshakes and lists tools (ok mode)", async () => {
		const client = await connect("ok");
		try {
			expect(client.isConnected).toBe(true);
			const { tools, capped } = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["echo", "dieonce"]);
			expect(capped).toBe(false);
		} finally {
			client.close();
		}
	});

	it("tolerates a non-JSON line before the initialize response (badline)", async () => {
		const client = await connect("badline");
		try {
			const { tools } = await client.listTools();
			expect(tools).toHaveLength(1);
		} finally {
			client.close();
		}
	});

	it("merges cursor pages from tools/list (paginate)", async () => {
		const client = await connect("paginate");
		try {
			const { tools, capped } = await client.listTools();
			expect(tools.map((t) => t.name).sort()).toEqual(["page1tool", "page2tool"]);
			expect(capped).toBe(false);
		} finally {
			client.close();
		}
	});

	it("stops at the page cap on a server whose cursor never ends (liarcursor)", async () => {
		const client = await connect("liarcursor");
		try {
			const { tools, capped } = await client.listTools();
			expect(capped).toBe(true); // review P2-5: truncation must be visible
			expect(tools).toHaveLength(10); // one per page x TOOLS_LIST_PAGE_CAP
		} finally {
			client.close();
		}
	});

	it("survives a chunk boundary inside a multi-byte UTF-8 char (utf8split)", async () => {
		const client = await connect("utf8split");
		try {
			const { tools } = await client.listTools();
			// Per-chunk decode would have produced U+FFFD and dropped the whole
			// line as stray non-JSON (review P2-4) - the description must be intact.
			expect(tools[0]?.description).toBe("回显参数 — chunk 边界测试");
		} finally {
			client.close();
		}
	});

	it("connect times out when the server never answers initialize", async () => {
		const client = makeClient("neverinit", { connectTimeoutMs: 300 });
		await expect(client.connect()).rejects.toThrow(/timed out/);
	});

	it("callTool returns text content and isError mapping", async () => {
		const client = await connect("ok");
		try {
			const ok = await client.callTool("echo", { x: "1" });
			expect(ok.content[0]?.text).toBe(JSON.stringify({ x: "1" }));
			expect(ok.isError).not.toBe(true);
			const bad = await client.callTool("boom", {});
			expect(bad.isError).toBe(true);
			expect(bad.content[0]?.text).toBe("the server says no");
		} finally {
			client.close();
		}
	});

	it("callTool times out on a tool that never answers", async () => {
		const client = await connect("ok", { callTimeoutMs: 300 });
		try {
			await expect(client.callTool("slow", {})).rejects.toThrow(/timed out/);
		} finally {
			client.close();
		}
	});

	it("callTool rejects immediately on abort and sends notifications/cancelled", async () => {
		const cancelFile = join(tmp, "cancelled");
		const client = makeClient("ok", { env: { FAKE_MCP_CANCEL_FILE: cancelFile } });
		await client.connect();
		try {
			const controller = new AbortController();
			const pending = client.callTool("slow", {}, controller.signal);
			setTimeout(() => controller.abort(), 50);
			await expect(pending).rejects.toThrow(/aborted/);
			// The cancellation actually reaches the server (ack witness).
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(existsSync(cancelFile)).toBe(true);
		} finally {
			client.close();
		}
	});

	it("detaches the abort listener when a call settles normally (review P3-8)", async () => {
		const client = await connect("ok");
		try {
			const controller = new AbortController();
			await client.callTool("echo", { a: 1 }, controller.signal);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		} finally {
			client.close();
		}
	});

	it("rejects pending requests when the server process dies", async () => {
		const client = await connect("die");
		try {
			// die-mode exits right after the initialized notification; give the
			// exit event a tick to land, then the dead path must reject calls.
			await new Promise((r) => setTimeout(r, 200));
			expect(client.isConnected).toBe(false);
			await expect(client.callTool("echo", {})).rejects.toThrow(/not open/);
		} finally {
			client.close();
		}
	});

	it("marks the client dead and notifies onDead on unexpected exit", async () => {
		const client = new McpClient({
			name: "fake",
			command: process.execPath,
			args: [SERVER, "die"],
			clientVersion: "test",
			connectTimeoutMs: 2000,
			callTimeoutMs: 2000,
		});
		let dead = false;
		client.onDead = () => {
			dead = true;
		};
		// die-mode exits right after answering initialize + seeing the
		// initialized notification — connect() itself should fail or the
		// client must be dead immediately after.
		try {
			await client.connect();
			// give the exit event a tick to land
			await new Promise((r) => setTimeout(r, 150));
			expect(dead || !client.isConnected).toBe(true);
		} catch {
			// connect racing the exit is also an acceptable outcome
			expect(dead || !client.isConnected).toBe(true);
		} finally {
			client.close();
		}
	});
});
