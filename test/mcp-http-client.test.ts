// M19 D4/D5: the Streamable HTTP transport through the protocol core, driven
// by the in-process fake server. Witness assertions read fake.requests — the
// fixture records headers (lowercased by node) and parsed bodies.
import { describe, expect, it } from "vitest";
import { McpClient, McpConnectionError, McpSessionExpiredError } from "../src/mcp/client.js";
import { HttpTransport } from "../src/mcp/http-transport.js";
import { startFakeMcpHttpServer } from "./helpers/mcp-fake-http-server.js";

async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 15));
	}
	return cond();
}

function makeClient(
	url: string,
	opts: { headers?: Record<string, string>; connectTimeoutMs?: number; callTimeoutMs?: number } = {},
) {
	return new McpClient(new HttpTransport({ url, headers: opts.headers ?? {} }), {
		name: "fake-http",
		clientVersion: "test",
		connectTimeoutMs: opts.connectTimeoutMs ?? 3000,
		callTimeoutMs: opts.callTimeoutMs ?? 3000,
	});
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

describe("HttpTransport + McpClient", () => {
	it("handshakes over JSON: session + negotiated version ride the initialized notification", async () => {
		const fake = await startFakeMcpHttpServer();
		const client = makeClient(fake.url);
		try {
			await client.connect();
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["echo"]);
			const result = await client.callTool("echo", { text: "hi" });
			expect(textOf(result)).toBe("pong:hi");

			const initialized = fake.requests.find((r) => r.body?.method === "notifications/initialized");
			expect(initialized?.headers["mcp-session-id"]).toBe("sess-1");
			expect(initialized?.headers["mcp-protocol-version"]).toBe("2025-06-18");
			const call = fake.requests.find((r) => r.body?.method === "tools/call");
			expect(call?.headers["mcp-session-id"]).toBe("sess-1");
			expect(call?.headers.accept).toContain("text/event-stream");
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("initialize answered over SSE: the session header is read before the body, and the NEGOTIATED version is echoed", async () => {
		const fake = await startFakeMcpHttpServer({ initializeMode: "sse", protocolVersion: "2025-03-26" });
		const client = makeClient(fake.url);
		try {
			await client.connect();
			await client.listTools();
			const initialized = fake.requests.find((r) => r.body?.method === "notifications/initialized");
			expect(initialized?.headers["mcp-session-id"]).toBe("sess-1");
			expect(initialized?.headers["mcp-protocol-version"]).toBe("2025-03-26");
			const list = fake.requests.find((r) => r.body?.method === "tools/list");
			expect(list?.headers["mcp-protocol-version"]).toBe("2025-03-26");
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("session header rides notification POSTs (cancelled) and DELETE; close resolves after DELETE", async () => {
		const fake = await startFakeMcpHttpServer({ callMode: "slow" });
		const client = makeClient(fake.url);
		await client.connect();
		const controller = new AbortController();
		const call = client.callTool("echo", { text: "x" }, controller.signal);
		await waitUntil(() => fake.requests.some((r) => r.body?.method === "tools/call"));
		controller.abort();
		await expect(call).rejects.toThrow(/aborted/);
		expect(
			await waitUntil(() => fake.requests.some((r) => r.body?.method === "notifications/cancelled")),
		).toBe(true);
		const cancelled = fake.requests.find((r) => r.body?.method === "notifications/cancelled");
		expect(cancelled?.headers["mcp-session-id"]).toBe("sess-1");
		expect(cancelled?.headers["mcp-protocol-version"]).toBe("2025-06-18");

		await client.close();
		expect(fake.state.deleted).toBe(1);
		const del = fake.requests.find((r) => r.method === "DELETE");
		expect(del?.headers["mcp-session-id"]).toBe("sess-1");
		expect(del?.headers["mcp-protocol-version"]).toBe("2025-06-18");
		await fake.close();
	});

	it("answers server requests on the response stream (ping); unknown methods get -32601", async () => {
		const pingFake = await startFakeMcpHttpServer({ callMode: "ssePing" });
		const pingClient = makeClient(pingFake.url);
		try {
			await pingClient.connect();
			const result = await pingClient.callTool("echo", { text: "x" });
			expect(textOf(result)).toBe("pong:x");
			expect(await waitUntil(() => pingFake.requests.some((r) => r.body?.id === 9001))).toBe(true);
			const answer = pingFake.requests.find((r) => r.body?.id === 9001);
			expect(answer?.body?.result).toEqual({});
		} finally {
			await pingClient.close();
			await pingFake.close();
		}

		const rootsFake = await startFakeMcpHttpServer({ callMode: "sseUnknownRequest" });
		const rootsClient = makeClient(rootsFake.url);
		try {
			await rootsClient.connect();
			await rootsClient.callTool("echo", { text: "x" });
			expect(await waitUntil(() => rootsFake.requests.some((r) => r.body?.id === 9002))).toBe(true);
			const answer = rootsFake.requests.find((r) => r.body?.id === 9002);
			expect((answer?.body?.error as { code?: number } | undefined)?.code).toBe(-32601);
		} finally {
			await rootsClient.close();
			await rootsFake.close();
		}
	});

	it("404 with a live session is McpSessionExpiredError + death (the manager may re-initialize)", async () => {
		const fake = await startFakeMcpHttpServer({ expireSessionOnce: true });
		const client = makeClient(fake.url);
		let dead = false;
		client.onDead = () => {
			dead = true;
		};
		try {
			await client.connect();
			await expect(client.callTool("echo", { text: "x" })).rejects.toBeInstanceOf(McpSessionExpiredError);
			expect(await waitUntil(() => dead)).toBe(true);
			expect(client.isConnected).toBe(false);
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("401 at initialize: death with the token hint, still an McpConnectionError", async () => {
		const fake = await startFakeMcpHttpServer({ failInitialize: 401 });
		const client = makeClient(fake.url);
		try {
			const err = await client.connect().then(
				() => undefined,
				(e: unknown) => e as McpConnectionError,
			);
			expect(err).toBeInstanceOf(McpConnectionError);
			expect(err?.message).toMatch(/401/);
			expect(err?.message).toMatch(/check the server token/);
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("5xx is request-level: the error surfaces, the connection survives", async () => {
		const fake = await startFakeMcpHttpServer();
		const client = makeClient(fake.url);
		try {
			await client.connect();
			fake.options.callMode = "500";
			await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/HTTP 500/);
			expect(client.isConnected).toBe(true);
			fake.options.callMode = undefined;
			const result = await client.callTool("echo", { text: "again" });
			expect(textOf(result)).toBe("pong:again");
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("refuses redirects: the target is never contacted (token could ride the URL)", async () => {
		const fake = await startFakeMcpHttpServer();
		fake.options.redirectTo = `${fake.url}?elsewhere`;
		const client = makeClient(fake.url);
		try {
			await expect(client.connect()).rejects.toBeInstanceOf(McpConnectionError);
			expect(fake.requests).toHaveLength(1); // only the refused initialize POST
			expect(fake.requests[0]?.url).toBe("/mcp");
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("a slow call times out without killing the connection", async () => {
		const fake = await startFakeMcpHttpServer({ callMode: "slow" });
		const client = makeClient(fake.url, { callTimeoutMs: 250 });
		try {
			await client.connect();
			await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/timed out/);
			expect(client.isConnected).toBe(true);
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("SSE final event without a trailing blank line is flushed (tolerant EOF)", async () => {
		const fake = await startFakeMcpHttpServer({ callMode: "sseNoFinalNewline" });
		const client = makeClient(fake.url);
		try {
			await client.connect();
			const result = await client.callTool("echo", { text: "eof" });
			expect(textOf(result)).toBe("pong:eof");
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("a stream that closes without a reply rejects just that request; the connection survives", async () => {
		const fake = await startFakeMcpHttpServer({ callMode: "closeEarly" });
		const client = makeClient(fake.url);
		try {
			await client.connect();
			await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/ended without a reply/);
			expect(client.isConnected).toBe(true);
			fake.options.callMode = undefined;
			const result = await client.callTool("echo", { text: "next" });
			expect(textOf(result)).toBe("pong:next");
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("a non-JSON body leaves the request unanswered (request-level), not a death", async () => {
		const fake = await startFakeMcpHttpServer({ callMode: "badType" });
		const client = makeClient(fake.url);
		try {
			await client.connect();
			await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/ended without a reply/);
			expect(client.isConnected).toBe(true);
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("close()/forceKill() never let a trailing transport death reach onDead", async () => {
		const fake = await startFakeMcpHttpServer();
		const client = makeClient(fake.url);
		await client.connect();
		let dead = false;
		client.onDead = () => {
			dead = true;
		};
		await client.close();
		await new Promise((r) => setTimeout(r, 100));
		expect(dead).toBe(false);
		await fake.close();
	});

	it("invalid JSON inside the SSE stream is skipped; the real reply still lands", async () => {
		const fake = await startFakeMcpHttpServer();
		fake.options.onCall = (req, res, helpers) => {
			helpers.sseHead(res);
			res.write("data: not-json\n\n");
			helpers.sseEvent(res, {
				jsonrpc: "2.0",
				id: req.body?.id,
				result: { content: [{ type: "text", text: "survived" }] },
			});
			res.end();
			return true;
		};
		const client = makeClient(fake.url);
		try {
			await client.connect();
			const result = await client.callTool("echo", { text: "x" });
			expect(textOf(result)).toBe("survived");
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("DELETE failures (405) are ignored: close resolves anyway", async () => {
		const fake = await startFakeMcpHttpServer({ deleteStatus: 405 });
		const client = makeClient(fake.url);
		await client.connect();
		await client.close();
		expect(fake.state.deleted).toBe(1);
		await fake.close();
	});

	it("forceKill during close abandons the DELETE; close still resolves promptly", async () => {
		const fake = await startFakeMcpHttpServer({ deleteDelayMs: 1500 });
		const client = makeClient(fake.url);
		await client.connect();
		const started = Date.now();
		const closing = client.close();
		expect(await waitUntil(() => fake.state.deleted === 1)).toBe(true);
		client.forceKill();
		await closing;
		expect(Date.now() - started).toBeLessThan(1000); // abandoned, not awaited to 1500ms
		await fake.close();
	});

	it("concurrent calls: a ping inside A's stream lands while B is pending", async () => {
		const fake = await startFakeMcpHttpServer();
		fake.options.onCall = (req, res, helpers) => {
			const text = String((req.body?.params?.arguments as Record<string, unknown> | undefined)?.text ?? "");
			if (text === "a") {
				helpers.sseHead(res);
				helpers.sseEvent(res, { jsonrpc: "2.0", id: 9101, method: "ping", params: {} });
				setTimeout(() => {
					helpers.sseEvent(res, {
						jsonrpc: "2.0",
						id: req.body?.id,
						result: { content: [{ type: "text", text: "A" }] },
					});
					res.end();
				}, 120);
				return true;
			}
			helpers.sendJson(res, 200, {
				jsonrpc: "2.0",
				id: req.body?.id,
				result: { content: [{ type: "text", text: "B" }] },
			});
			return true;
		};
		const client = makeClient(fake.url);
		try {
			await client.connect();
			const a = client.callTool("echo", { text: "a" });
			const b = await client.callTool("echo", { text: "b" });
			expect(textOf(b)).toBe("B");
			const aResult = await a;
			expect(textOf(aResult)).toBe("A");
			expect(await waitUntil(() => fake.requests.some((r) => r.body?.id === 9101))).toBe(true);
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("secrets (URL path token + header value) are redacted from errors and diagnostics", async () => {
		const fake = await startFakeMcpHttpServer({ callMode: "500echo" });
		const url = `${fake.url}/token=SECRET_TOKEN`;
		const client = makeClient(url, { headers: { Authorization: "Bearer SECRET_HEADER" } });
		try {
			await client.connect();
			const err = (await client.callTool("echo", { text: "x" }).then(
				() => undefined,
				(e: unknown) => e as Error,
			)) as Error;
			expect(err.message).toContain("«redacted»");
			expect(err.message).not.toContain("SECRET_TOKEN");
			expect(err.message).not.toContain("SECRET_HEADER");
		} finally {
			await client.close();
			await fake.close();
		}
	});
});
