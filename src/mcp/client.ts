/**
 * MCP protocol core (M19 D1, docs/m19-mcp-http-design.md).
 *
 * Owns the pending table, request/notify, timeouts, abort, the initialize
 * handshake, tools/list cursor pagination (10-page cap) and tools/call
 * mapping. The wire lives behind McpTransport: stdio-transport.ts carries
 * the M18 NDJSON/process logic verbatim; http-transport.ts is M19's
 * Streamable HTTP addition. The closed flag HERE is the authority:
 * close()/forceKill() set it first, so a transport-level death racing the
 * close is ignored (D1 invariant), and transport.send no-ops after close.
 *
 * Version negotiation is deliberately lenient (design R2): a server that
 * answers initialize with a different protocolVersion is accepted.
 */
import type { McpTransport } from "./transport.js";

/** Protocol version imp requests (latest spec revision at design time). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Page cap for tools/list cursor pagination (z.ai has_more lesson). */
export const TOOLS_LIST_PAGE_CAP = 10;

export const CONNECT_TIMEOUT_MS = 45_000; // npx cold start downloads
export const CALL_TIMEOUT_MS = 120_000; // vision-style slow tools

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: unknown;
}

/** One MCP content block — typed loosely; only `text` is consumed in v1. */
export interface McpContentBlock {
	type: string;
	text?: string;
}

export interface McpCallResult {
	content: McpContentBlock[];
	isError?: boolean;
}

interface PendingEntry {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	/** Removes the abort listener when the entry settles — the loop reuses
	 * one signal across every tool call in a run, so listeners must not
	 * accumulate (review P3-8). */
	detach?: () => void;
}

export interface McpClientOptions {
	name: string;
	/** clientInfo.version in the initialize handshake. */
	clientVersion: string;
	connectTimeoutMs?: number;
	callTimeoutMs?: number;
}

/** Connection-level failure with the transport's diagnostics attached. */
export class McpConnectionError extends Error {
	constructor(
		message: string,
		public readonly detail: string,
	) {
		super(message);
		this.name = "McpConnectionError";
	}
}

/** A 404 on a session-bearing HTTP request (M19 D4): the session is gone.
 *  Distinct type so the manager can bypass the reconnect cooldown — a
 *  session that expires right after connect must not hit "on cooldown". */
export class McpSessionExpiredError extends McpConnectionError {
	constructor(message: string, detail: string) {
		super(message, detail);
		this.name = "McpSessionExpiredError";
	}
}

export class McpClient {
	private nextId = 1;
	private pending = new Map<number, PendingEntry>();
	private closed = false;
	private started = false;
	private connected = false;

	constructor(
		private readonly transport: McpTransport,
		private readonly options: McpClientOptions,
	) {}

	/** Set by the manager: fired when the connection dies unexpectedly. */
	onDead?: (reason: string) => void;

	get isConnected(): boolean {
		return this.connected && !this.closed;
	}

	/** Transport start + initialize handshake + initialized notification. */
	async connect(): Promise<void> {
		if (this.started) throw new Error("McpClient.connect called twice");
		this.started = true;
		await this.transport.start({
			onMessage: (msg) => this.handleMessage(msg),
			onRequestError: (id, error) => {
				this.deletePending(id)?.reject(error);
			},
			onDeath: (reason) => this.die(reason),
		});
		try {
			const result = (await this.request(
				"initialize",
				{
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "imp", version: this.options.clientVersion },
				},
				this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
			)) as { protocolVersion?: string; serverInfo?: { name?: string } };
			// Lenient negotiation (design R2): accept any version back. Record it
			// so every subsequent request echoes the negotiated value (M19 D4).
			const negotiated =
				typeof result?.protocolVersion === "string" && result.protocolVersion !== ""
					? result.protocolVersion
					: MCP_PROTOCOL_VERSION;
			this.transport.setProtocolVersion(negotiated);
			this.notify("notifications/initialized", {});
			this.connected = true;
		} catch (err) {
			// A handshake that timed out may also ignore SIGTERM: run the full
			// graceful transport sequence, then surface the original failure.
			this.markClosed(new McpConnectionError("connection closed", this.transport.getDiagnostics()));
			await this.transport.close();
			if (err instanceof McpConnectionError) throw err;
			const message = err instanceof Error ? err.message : String(err);
			throw new McpConnectionError(message, this.transport.getDiagnostics());
		}
	}

	/** Paginated tools/list (cursor loop, page cap). `capped` is true when a
	 * server kept returning a cursor past the page cap — the caller notes
	 * the truncation instead of silently dropping pages (design §3). */
	async listTools(): Promise<{ tools: McpToolInfo[]; capped: boolean }> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < TOOLS_LIST_PAGE_CAP; page++) {
			const result = (await this.request(
				"tools/list",
				cursor === undefined ? {} : { cursor },
				this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
			)) as { tools?: McpToolInfo[]; nextCursor?: string };
			for (const tool of result?.tools ?? []) {
				if (tool !== null && typeof tool === "object" && typeof tool.name === "string") {
					tools.push(tool);
				}
			}
			cursor = result?.nextCursor;
			if (cursor === undefined || cursor === "") return { tools, capped: false };
		}
		return { tools, capped: true }; // page cap reached (design §3)
	}

	/** One tools/call. Abort rejects immediately; the server gets a
	 *  notifications/cancelled best-effort (never awaited). */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		if (!this.isConnected) {
			throw new McpConnectionError("connection is not open", this.transport.getDiagnostics());
		}
		const result = (await this.request(
			"tools/call",
			{ name, arguments: args },
			this.options.callTimeoutMs ?? CALL_TIMEOUT_MS,
			signal,
		)) as McpCallResult;
		return {
			content: Array.isArray(result?.content) ? result.content : [],
			isError: result?.isError === true,
		};
	}

	/** Graceful close: reject pending, then the transport's sequence (stdio
	 *  resolves immediately; http awaits its bounded DELETE, M19 D4). */
	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.markClosed(new McpConnectionError("connection closed", this.transport.getDiagnostics()));
		return this.transport.close();
	}

	/** Synchronous best-effort teardown for the double-Ctrl+C force path. */
	forceKill(): void {
		if (this.closed) return;
		this.markClosed(new McpConnectionError("connection closed", this.transport.getDiagnostics()));
		this.transport.forceKill();
	}

	getDiagnostics(): string {
		return this.transport.getDiagnostics();
	}

	// --- internals ---------------------------------------------------------

	/** Set closed + reject everything pending with one error. */
	private markClosed(err: McpConnectionError): void {
		this.closed = true;
		this.connected = false;
		for (const id of [...this.pending.keys()]) {
			this.deletePending(id)?.reject(err);
		}
	}

	/** Unexpected death: mark closed, reject everything, notify the manager. */
	private die(reason: string): void {
		if (this.closed) return;
		this.markClosed(new McpConnectionError(reason, this.transport.getDiagnostics()));
		try {
			this.onDead?.(reason);
		} catch {
			// manager hooks must never take the client down
		}
	}

	private handleMessage(msg: Record<string, unknown>): void {
		// Server REQUEST (id + method): answer ping, reject the rest.
		if (msg.id !== undefined && typeof msg.method === "string") {
			if (msg.method === "ping") {
				this.transport.send({ jsonrpc: "2.0", id: msg.id, result: {} });
			} else {
				this.transport.send({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32601, message: `imp does not support "${msg.method}" (v1)` },
				});
			}
			return;
		}
		// RESPONSE to one of ours.
		if (msg.id !== undefined && typeof msg.id === "number") {
			const entry = this.deletePending(msg.id);
			if (entry === undefined) return; // late response to an aborted call
			const error = msg.error as { code?: number; message?: string } | undefined;
			if (error !== undefined && error !== null) {
				entry.reject(new Error(`MCP error ${error.code ?? "?"}: ${error.message ?? "unknown error"}`));
			} else {
				entry.resolve(msg.result);
			}
			return;
		}
		// Notification (method only) — v1 ignores server notifications.
	}

	/** Remove a pending entry and detach its listeners; undefined when the
	 * entry already settled (late response after abort/timeout). */
	private deletePending(id: number): PendingEntry | undefined {
		const entry = this.pending.get(id);
		if (entry === undefined) return undefined;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.detach?.();
		return entry;
	}

	private request(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.closed) {
				reject(new McpConnectionError("connection is closed", this.transport.getDiagnostics()));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				const entry = this.deletePending(id);
				if (entry !== undefined) {
					entry.reject(new Error(`MCP "${method}" timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);
			const entry: PendingEntry = { resolve, reject, timer };
			if (signal !== undefined) {
				const onAbort = () => {
					const pendingEntry = this.deletePending(id);
					if (pendingEntry === undefined) return;
					this.notify("notifications/cancelled", { requestId: id, reason: "client aborted" });
					reject(new Error(`MCP "${method}" aborted`));
				};
				if (signal.aborted) {
					clearTimeout(timer);
					reject(new Error(`MCP "${method}" aborted`));
					this.notify("notifications/cancelled", { requestId: id, reason: "client aborted" });
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				entry.detach = () => signal.removeEventListener("abort", onAbort);
				// late response after abort: no pending entry → ignored above
			}
			this.pending.set(id, entry);
			this.transport.send({ jsonrpc: "2.0", id, method, params }, signal);
		});
	}

	private notify(method: string, params: unknown): void {
		this.transport.send({ jsonrpc: "2.0", method, params });
	}
}
