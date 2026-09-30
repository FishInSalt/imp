/**
 * MCP transport interface (M19 D1, docs/m19-mcp-http-design.md).
 *
 * The protocol core (src/mcp/client.ts) owns the pending table, timeouts,
 * aborts, the initialize handshake, pagination and result mapping. A
 * transport owns framing and the wire lifecycle: the child process + NDJSON
 * for stdio (stdio-transport.ts, moved verbatim from the M18 client), HTTP
 * exchanges for M19's Streamable HTTP (http-transport.ts).
 *
 * Settlement rule (design review blocker 1): every request a transport
 * accepts must settle exactly one way — a JSON-RPC response via onMessage,
 * or a terminal onRequestError(id). onDeath is reserved for connection-fatal
 * conditions (process exit, session loss, fatal framing) and rejects every
 * pending request through the core.
 */
export interface TransportEvents {
	/** One parsed JSON-RPC object (request, response, or notification). */
	onMessage(msg: Record<string, unknown>): void;
	/** Request-level failure: rejects exactly this pending id, nothing else. */
	onRequestError(id: number, error: Error): void;
	/** Connection-fatal: the core rejects every pending request and dies. */
	onDeath(reason: string): void;
}

export interface McpTransport {
	readonly kind: "stdio" | "http";
	/** Begin serving events. stdio spawns here; http validates its URL (no IO). */
	start(events: TransportEvents): Promise<void>;
	/** Serialize + send one JSON-RPC message. `signal` lets a transport abort
	 *  its in-flight exchange when the caller aborts (http); stdio ignores it.
	 *  No-op after close. */
	send(msg: Record<string, unknown>, signal?: AbortSignal): void;
	/** Record the version the server negotiated in initialize so subsequent
	 *  requests can echo it back (MCP-Protocol-Version, M19 D4). stdio: no-op. */
	setProtocolVersion(version: string): void;
	/** Graceful close (stdio: signal sequence — resolves immediately;
	 *  http: stream aborts + DELETE, bounded). */
	close(): Promise<void>;
	/** Synchronous best-effort teardown (double-Ctrl+C force path). */
	forceKill(): void;
	/** Human-readable tail for failure messages (stderr tail / HTTP status). */
	getDiagnostics(): string;
	isOpen(): boolean;
}
