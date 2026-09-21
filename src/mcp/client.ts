/**
 * Minimal MCP stdio client (M18, docs/m18-mcp-design.md §3).
 *
 * Hand-rolled JSON-RPC 2.0 over newline-delimited JSON on the server's
 * stdout (D3: no runtime deps — the v1 protocol surface is initialize /
 * tools/list / tools/call plus two notifications). One line = one message;
 * stray non-JSON lines are skipped; a >10MB line kills the connection
 * (defensive, design R3).
 *
 * Version negotiation is deliberately lenient (design R2): a server that
 * answers initialize with a different protocolVersion is accepted — the
 * strict "disconnect on mismatch" reading buys nothing for a tools-only
 * client. The wire shapes are stable across MCP revisions.
 */
import { type ChildProcess, spawn } from "node:child_process";

/** Cap for one NDJSON line (design R3). */
const MAX_LINE_BYTES = 10 * 1024 * 1024;
/** Ring-buffer tail kept for /mcp failure diagnosis. */
const STDERR_TAIL_CHARS = 2048;
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
}

export interface McpClientOptions {
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** clientInfo.version in the initialize handshake. */
	clientVersion: string;
	connectTimeoutMs?: number;
	callTimeoutMs?: number;
}

/** Connection-level failure with the stderr tail attached for diagnosis. */
export class McpConnectionError extends Error {
	constructor(
		message: string,
		public readonly stderrTail: string,
	) {
		super(message);
		this.name = "McpConnectionError";
	}
}

export class McpClient {
	private proc: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingEntry>();
	private stdoutBuf = "";
	private stderrTail = "";
	private closed = false;
	private connected = false;

	constructor(private readonly options: McpClientOptions) {}

	/** Set by the manager: fired when the server process dies unexpectedly. */
	onDead?: (reason: string) => void;

	get isConnected(): boolean {
		return this.connected && !this.closed;
	}

	/** Spawn + initialize handshake + initialized notification. */
	async connect(): Promise<void> {
		if (this.proc !== null) throw new Error("McpClient.connect called twice");
		const proc = spawn(this.options.command, this.options.args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...this.options.env },
			cwd: this.options.cwd,
		});
		this.proc = proc;
		proc.on("error", (err) => this.die(`spawn failed: ${err.message}`));
		proc.on("exit", (code, signal) => {
			if (!this.closed) this.die(`server exited (code ${code ?? "?"}${signal ? ` ${signal}` : ""})`);
		});
		proc.stdout?.on("data", (chunk: Buffer) => this.feedStdout(chunk));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_CHARS);
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
			// Lenient negotiation (design R2): accept any version back.
			void result?.protocolVersion;
			this.notify("notifications/initialized", {});
			this.connected = true;
		} catch (err) {
			this.shutdown("SIGTERM");
			if (err instanceof McpConnectionError) throw err;
			const message = err instanceof Error ? err.message : String(err);
			throw new McpConnectionError(message, this.stderrTail.trim());
		}
	}

	/** Paginated tools/list (cursor loop, page cap). */
	async listTools(): Promise<McpToolInfo[]> {
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
			if (cursor === undefined || cursor === "") return tools;
		}
		return tools; // page cap reached (design §3): keep what we have
	}

	/** One tools/call. Abort rejects immediately; the server gets a
	 *  notifications/cancelled best-effort (never awaited). */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
		if (!this.isConnected) {
			throw new McpConnectionError("connection is not open", this.stderrTail.trim());
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

	/** Graceful close: stdin.end → 3s → SIGTERM → 2s → SIGKILL. */
	close(): void {
		this.shutdown("graceful");
	}

	/** Synchronous best-effort kill for the double-Ctrl+C force path. */
	forceKill(): void {
		this.shutdown("SIGTERM");
	}

	getStderrTail(): string {
		return this.stderrTail.trim();
	}

	// --- internals ---------------------------------------------------------

	private feedStdout(chunk: Buffer): void {
		this.stdoutBuf += chunk.toString("utf-8");
		if (this.stdoutBuf.length > MAX_LINE_BYTES) {
			this.die("server wrote a line over 10MB — connection dropped (design R3)");
			return;
		}
		let nl = this.stdoutBuf.indexOf("\n");
		while (nl >= 0) {
			const line = this.stdoutBuf.slice(0, nl);
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (line.trim() !== "") this.handleLine(line);
			if (this.closed) return;
			nl = this.stdoutBuf.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let msg: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
			msg = parsed as Record<string, unknown>;
		} catch {
			return; // stray non-JSON line (design §3): skip
		}
		// Server REQUEST (id + method): answer ping, reject the rest.
		if (msg.id !== undefined && typeof msg.method === "string") {
			if (msg.method === "ping") {
				this.write({ jsonrpc: "2.0", id: msg.id, result: {} });
			} else {
				this.write({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32601, message: `imp does not support "${msg.method}" (v1)` },
				});
			}
			return;
		}
		// RESPONSE to one of ours.
		if (msg.id !== undefined && typeof msg.id === "number") {
			const entry = this.pending.get(msg.id);
			if (entry === undefined) return; // late response to an aborted call
			this.pending.delete(msg.id);
			clearTimeout(entry.timer);
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

	private request(
		method: string,
		params: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.closed) {
				reject(new McpConnectionError("connection is closed", this.stderrTail.trim()));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			if (signal !== undefined) {
				const onAbort = () => {
					const entry = this.pending.get(id);
					if (entry === undefined) return;
					this.pending.delete(id);
					clearTimeout(entry.timer);
					this.notify("notifications/cancelled", { requestId: id, reason: "client aborted" });
					reject(new Error(`MCP "${method}" aborted`));
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				// late response after abort: no pending entry → ignored above
			}
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(message: Record<string, unknown>): void {
		if (this.proc?.stdin?.writable !== true) return;
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	/** Unexpected death: reject everything pending, notify the manager. */
	private die(reason: string): void {
		if (this.closed) return;
		this.connected = false;
		this.closed = true;
		const err = new McpConnectionError(reason, this.stderrTail.trim());
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(err);
		}
		this.pending.clear();
		this.proc?.kill("SIGTERM");
		try {
			this.onDead?.(reason);
		} catch {
			// manager hooks must never take the client down
		}
	}

	private shutdown(mode: "graceful" | "SIGTERM"): void {
		if (this.closed) return;
		this.closed = true;
		this.connected = false;
		const err = new McpConnectionError("connection closed", this.stderrTail.trim());
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(err);
		}
		this.pending.clear();
		const proc = this.proc;
		if (proc === null) return;
		if (mode === "graceful") {
			proc.stdin?.end();
			const term = setTimeout(() => proc.kill("SIGTERM"), 3000);
			const kill = setTimeout(() => proc.kill("SIGKILL"), 5000);
			term.unref?.();
			kill.unref?.();
		} else {
			proc.stdin?.end();
			proc.kill("SIGTERM");
		}
	}
}
