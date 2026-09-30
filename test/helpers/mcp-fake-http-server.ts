// Fake in-process MCP server speaking Streamable HTTP (M19 D8 fixture).
// Records every request (method/url/headers/body) for witness assertions and
// serves the modes the http tests need. Tests mutate `options` live (e.g.
// flip `expireSessionOnce`) — the handlers read it per request.
//
// Usage: const fake = await startFakeMcpHttpServer({ callMode: "sse" });
//        fake.url, fake.requests, fake.state, fake.options, fake.close()
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

export interface FakeHttpRequest {
	method: string | undefined;
	url: string | undefined;
	headers: IncomingHttpHeaders;
	body: FakeMessage | undefined;
	bodyText: string;
}

interface FakeMessage {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: { name?: string; arguments?: Record<string, unknown>; [key: string]: unknown };
	result?: unknown;
	error?: unknown;
}

export interface FakeHttpHelpers {
	sendJson(res: ServerResponse, status: number, msg: unknown, extraHeaders?: Record<string, string>): void;
	sseHead(res: ServerResponse, extraHeaders?: Record<string, string>): void;
	sseEvent(res: ServerResponse, msg: unknown): void;
	state: { initializeCount: number; deleted: number; sessionId: string };
	requests: FakeHttpRequest[];
}

export interface FakeHttpOptions {
	sessionId?: string;
	protocolVersion?: string;
	sessionHeader?: boolean;
	deleteStatus?: number;
	deleteDelayMs?: number;
	redirectTo?: string;
	failInitialize?: 401;
	initializeMode?: "sse" | "slow";
	tools?: unknown[];
	expireSession?: boolean;
	expireSessionOnce?: boolean;
	callMode?:
		| "sse"
		| "ssePing"
		| "sseUnknownRequest"
		| "sseNoFinalNewline"
		| "closeEarly"
		| "slow"
		| "500"
		| "500echo"
		| "badType"
		| "isError";
	onCall?: (
		req: FakeHttpRequest,
		res: ServerResponse,
		helpers: FakeHttpHelpers,
	) => boolean | undefined | Promise<boolean | undefined>;
	[key: string]: unknown;
}

export interface FakeHttpServer {
	url: string;
	requests: FakeHttpRequest[];
	state: { initializeCount: number; deleted: number; sessionId: string };
	options: FakeHttpOptions;
	close(): Promise<void>;
}

export async function startFakeMcpHttpServer(options: FakeHttpOptions = {}): Promise<FakeHttpServer> {
	const requests: FakeHttpRequest[] = [];
	const state = { initializeCount: 0, deleted: 0, sessionId: options.sessionId ?? "sess-1" };

	const sendJson = (
		res: ServerResponse,
		status: number,
		msg: unknown,
		extraHeaders: Record<string, string> = {},
	): void => {
		res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
		res.end(JSON.stringify(msg));
	};
	const sseHead = (res: ServerResponse, extraHeaders: Record<string, string> = {}): void => {
		res.writeHead(200, { "content-type": "text/event-stream", ...extraHeaders });
	};
	const sseEvent = (res: ServerResponse, msg: unknown): void => {
		res.write(`data: ${JSON.stringify(msg)}\n\n`);
	};

	const handle = async (req: FakeHttpRequest, res: ServerResponse): Promise<void> => {
		const msg = req.body;

		if (req.method === "DELETE") {
			state.deleted += 1;
			const respond = (): void => {
				try {
					if (options.deleteStatus !== undefined) res.writeHead(options.deleteStatus).end();
					else res.writeHead(200).end();
				} catch {
					// the client may have abandoned the DELETE (forceKill) — socket gone
				}
			};
			if (typeof options.deleteDelayMs === "number") {
				const timer = setTimeout(respond, options.deleteDelayMs);
				timer.unref?.();
			} else {
				respond();
			}
			return;
		}

		if (options.redirectTo !== undefined) {
			res.writeHead(307, { location: options.redirectTo }).end();
			return;
		}

		if (msg?.method === "initialize") {
			state.initializeCount += 1;
			if (options.failInitialize === 401) {
				sendJson(res, 401, { error: "invalid token" });
				return;
			}
			const result = {
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					protocolVersion: options.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "fake-http", version: "0" },
				},
			};
			const headers: Record<string, string> =
				options.sessionHeader === false ? {} : { "mcp-session-id": state.sessionId };
			if (options.initializeMode === "sse") {
				sseHead(res, headers);
				sseEvent(res, result);
				res.end();
				return;
			}
			if (options.initializeMode === "slow") return; // never answers
			sendJson(res, 200, result, headers);
			return;
		}

		if (typeof msg?.method === "string" && msg.method.startsWith("notifications/")) {
			res.writeHead(202).end();
			return;
		}

		if (msg?.method === "tools/list") {
			const tools = options.tools ?? [
				{
					name: "echo",
					description: "echo tool",
					inputSchema: { type: "object", properties: { text: { type: "string" } } },
				},
			];
			sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools } });
			return;
		}

		if (msg?.method === "tools/call") {
			if (options.onCall !== undefined) {
				const handled = await options.onCall(req, res, { sendJson, sseHead, sseEvent, state, requests });
				if (handled !== false) return;
			}
			if (options.expireSessionOnce === true) {
				options.expireSessionOnce = false;
				res
					.writeHead(404, { "content-type": "application/json" })
					.end(JSON.stringify({ error: "session gone" }));
				return;
			}
			if (options.expireSession === true) {
				res
					.writeHead(404, { "content-type": "application/json" })
					.end(JSON.stringify({ error: "session gone" }));
				return;
			}
			const callArgs = (msg.params?.arguments ?? {}) as Record<string, unknown>;
			const reply = {
				jsonrpc: "2.0",
				id: msg.id,
				result: { content: [{ type: "text", text: `pong:${String(callArgs.text ?? "")}` }] },
			};
			switch (options.callMode) {
				case "sse":
					sseHead(res);
					sseEvent(res, reply);
					res.end();
					return;
				case "ssePing":
					// interleaves a server request (ping) before the reply
					sseHead(res);
					sseEvent(res, { jsonrpc: "2.0", id: 9001, method: "ping", params: {} });
					sseEvent(res, reply);
					res.end();
					return;
				case "sseUnknownRequest":
					sseHead(res);
					sseEvent(res, { jsonrpc: "2.0", id: 9002, method: "roots/list", params: {} });
					sseEvent(res, reply);
					res.end();
					return;
				case "sseNoFinalNewline":
					sseHead(res);
					// final event deliberately missing the trailing blank line
					res.write(`data: ${JSON.stringify(reply)}`);
					res.end();
					return;
				case "closeEarly":
					sseHead(res);
					sseEvent(res, { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
					res.end();
					return;
				case "slow":
					return; // never answers (caller times out / aborts)
				case "500":
					res.writeHead(500, { "content-type": "text/plain" }).end("boom");
					return;
				case "500echo":
					res
						.writeHead(500, { "content-type": "text/plain" })
						.end(`boom auth=${String(req.headers.authorization ?? "")} path=${String(req.url ?? "")}`);
					return;
				case "badType":
					res.writeHead(200, { "content-type": "text/plain" }).end("not json at all");
					return;
				case "isError":
					sendJson(res, 200, {
						jsonrpc: "2.0",
						id: msg.id,
						result: { content: [{ type: "text", text: "tool blew up" }], isError: true },
					});
					return;
				default:
					sendJson(res, 200, reply);
					return;
			}
		}

		// Responses to server requests (e.g. the ping answer) arrive as POSTs
		// with an id but no method.
		if (msg?.id !== undefined && msg?.method === undefined) {
			res.writeHead(202).end();
			return;
		}

		res.writeHead(500, { "content-type": "text/plain" }).end("unhandled");
	};

	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const bodyText = Buffer.concat(chunks).toString("utf-8");
		let body: FakeMessage | undefined;
		try {
			const parsed: unknown = JSON.parse(bodyText);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				body = parsed as FakeMessage;
			}
		} catch {
			body = undefined;
		}
		const record: FakeHttpRequest = {
			method: req.method,
			url: req.url,
			headers: req.headers,
			body,
			bodyText,
		};
		requests.push(record);
		try {
			await handle(record, res);
		} catch (err) {
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end(String(err));
			else res.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = address !== null && typeof address === "object" ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		requests,
		state,
		options,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				// keep-alive idle sockets would otherwise hold close() for seconds
				server.closeAllConnections();
			}),
	};
}
