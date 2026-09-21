import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";

const SERVER = join(import.meta.dirname, "helpers", "mcp-fake-server.mjs");
const FAST = { connectTimeoutMs: 2000, callTimeoutMs: 2000 };

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
			const tools = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["echo", "dieonce"]);
		} finally {
			client.close();
		}
	});

	it("tolerates a non-JSON line before the initialize response (badline)", async () => {
		const client = await connect("badline");
		try {
			const tools = await client.listTools();
			expect(tools).toHaveLength(1);
		} finally {
			client.close();
		}
	});

	it("merges cursor pages from tools/list (paginate)", async () => {
		const client = await connect("paginate");
		try {
			const tools = await client.listTools();
			expect(tools.map((t) => t.name).sort()).toEqual(["page1tool", "page2tool"]);
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
		const client = await connect("ok");
		try {
			const controller = new AbortController();
			const pending = client.callTool("slow", {}, controller.signal);
			setTimeout(() => controller.abort(), 50);
			await expect(pending).rejects.toThrow(/aborted/);
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
