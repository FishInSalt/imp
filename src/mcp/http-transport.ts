/**
 * Streamable HTTP transport (M19 D4/D5, docs/design/m19-mcp-http-design.md).
 *
 * One POST per JSON-RPC message; responses arrive as application/json or
 * text/event-stream (the stream may interleave the reply with server
 * requests/notifications — all of it flows to the core through onMessage).
 * Mcp-Session-Id is captured from ANY response (before the body is
 * consumed, so an SSE'd initialize cannot race it) and echoed on every
 * later request + DELETE; the negotiated protocol version is echoed in
 * MCP-Protocol-Version after initialize (the core calls setProtocolVersion).
 *
 * Failure taxonomy (D4): a 404 on a session-bearing request is
 * McpSessionExpiredError + death (the manager re-initializes bypassing the
 * cooldown); other non-2xx reject just that request (onRequestError);
 * network errors, redirects (redirect:"error" — the token may live in the
 * URL, so a followed redirect could leak it) and fatal framing are death.
 *
 * Secret hygiene (D5): every string produced here runs through redact() —
 * header values plus the URL's userinfo/path/query are replaced with
 * «redacted»; the raw request URL never appears in messages.
 */
import { McpConnectionError, McpSessionExpiredError } from "./client.js";
import { parseSse } from "./sse.js";
import type { McpTransport, TransportEvents } from "./transport.js";

export interface HttpTransportOptions {
	url: string;
	headers: Record<string, string>;
}

const DELETE_TIMEOUT_MS = 3000;
const SNIPPET_BYTES = 2048;

export class HttpTransport implements McpTransport {
	readonly kind = "http" as const;
	private events: TransportEvents | null = null;
	private closed = false;
	private sessionId: string | null = null;
	private protocolVersion: string | null = null;
	private diagnostics = "";
	private readonly controllers = new Set<AbortController>();
	/** The DELETE issued by close(); forceKill() aborts it (M19 D4 abandon rule). */
	private deleteController: AbortController | null = null;
	/** Outgoing secrets scrubbed from every string this transport produces. */
	private readonly secrets: string[];

	constructor(private readonly options: HttpTransportOptions) {
		const secrets = new Set<string>();
		for (const value of Object.values(options.headers)) {
			if (value !== "") secrets.add(value);
		}
		try {
			const parsed = new URL(options.url);
			if (parsed.pathname !== "" && parsed.pathname !== "/") secrets.add(parsed.pathname);
			if (parsed.search !== "") secrets.add(parsed.search);
			if (parsed.username !== "") secrets.add(parsed.username);
			if (parsed.password !== "") secrets.add(parsed.password);
		} catch {
			// config already validated the URL; nothing to scrub beyond headers
		}
		this.secrets = [...secrets].sort((a, b) => b.length - a.length);
	}

	async start(events: TransportEvents): Promise<void> {
		this.events = events;
	}

	send(msg: Record<string, unknown>, signal?: AbortSignal): void {
		if (this.closed) return;
		void this.exchange(msg, signal);
	}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const controller of [...this.controllers]) controller.abort();
		const session = this.sessionId;
		this.sessionId = null;
		if (session === null) return;
		const headers: Record<string, string> = { ...this.options.headers, "mcp-session-id": session };
		if (this.protocolVersion !== null) headers["mcp-protocol-version"] = this.protocolVersion;
		const controller = new AbortController();
		this.deleteController = controller;
		const timer = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
		timer.unref?.();
		try {
			await fetch(this.options.url, {
				method: "DELETE",
				headers,
				redirect: "error",
				signal: controller.signal,
			});
		} catch {
			// server does not support DELETE / already gone / forceKill abandoned it (D4)
		} finally {
			clearTimeout(timer);
			this.deleteController = null;
		}
	}

	forceKill(): void {
		this.closed = true;
		for (const controller of [...this.controllers]) controller.abort();
		this.deleteController?.abort();
	}

	getDiagnostics(): string {
		return this.diagnostics;
	}

	isOpen(): boolean {
		return !this.closed;
	}

	// --- internals ---------------------------------------------------------

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { ...this.options.headers };
		if (this.sessionId !== null) headers["mcp-session-id"] = this.sessionId;
		if (this.protocolVersion !== null) headers["mcp-protocol-version"] = this.protocolVersion;
		return headers;
	}

	private async exchange(msg: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		const id = typeof msg.id === "number" ? msg.id : undefined;
		const controller = new AbortController();
		this.controllers.add(controller);
		const onAbort = (): void => controller.abort();
		if (signal !== undefined) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			const res = await fetch(this.options.url, {
				method: "POST",
				headers: {
					...this.headers(),
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify(msg),
				redirect: "error",
				signal: controller.signal,
			});
			// The session id can arrive on ANY response and must be taken
			// before the body is consumed (D4/D5 timing rule).
			const session = res.headers.get("mcp-session-id");
			const hadSession = this.sessionId !== null;
			if (session !== null && session !== "") this.sessionId = session;

			if (!res.ok) {
				const snippet = await readSnippet(res);
				const raw = `HTTP ${res.status}${res.statusText !== "" ? ` ${res.statusText}` : ""}${
					snippet !== "" ? `: ${snippet}` : ""
				}`;
				this.diagnostics = this.redact(raw);
				if (id === undefined) return; // notification failure: diagnostics only
				if (res.status === 404 && hadSession && session === null) {
					this.sessionId = null;
					this.events?.onRequestError(
						id,
						new McpSessionExpiredError("MCP session expired (HTTP 404)", this.diagnostics),
					);
					this.death("MCP session expired (HTTP 404) — re-initializing");
					return;
				}
				this.events?.onRequestError(
					id,
					new McpConnectionError(this.describe(raw, res.status), this.diagnostics),
				);
				return;
			}

			if (id === undefined) {
				void res.body?.cancel().catch(() => {});
				return;
			}

			let settled = false;
			const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
			if (contentType.includes("text/event-stream")) {
				for await (const ev of parseSse(res.body as AsyncIterable<Uint8Array>)) {
					const parsed = this.parseMessage(ev.data);
					if (parsed === undefined) continue;
					this.events?.onMessage(parsed);
					if (isResponseFor(parsed, id)) settled = true;
				}
			} else {
				const text = await res.text();
				const parsed = this.parseMessage(text);
				if (parsed !== undefined) {
					this.events?.onMessage(parsed);
					if (isResponseFor(parsed, id)) settled = true;
				}
			}
			if (!settled) {
				this.events?.onRequestError(
					id,
					new McpConnectionError("MCP response stream ended without a reply", this.diagnostics),
				);
			}
		} catch (err) {
			// close()/forceKill()/caller abort: the core already settled the
			// request (or is tearing down) — not a death to report.
			if (this.closed || signal?.aborted === true) return;
			const message = err instanceof Error ? err.message : String(err);
			this.death(message);
		} finally {
			this.controllers.delete(controller);
			if (signal !== undefined) signal.removeEventListener("abort", onAbort);
		}
	}

	private parseMessage(text: string): Record<string, unknown> | undefined {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.diagnostics = this.redact("invalid JSON in MCP response");
			return undefined;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			this.diagnostics = this.redact("non-object MCP payload");
			return undefined;
		}
		return parsed as Record<string, unknown>;
	}

	/** 401/403 get the token hint (OAuth is out of scope for M19). */
	private describe(raw: string, status: number): string {
		const detail = this.redact(raw);
		if (status === 401 || status === 403) {
			return `MCP request failed (${detail} — authentication rejected; check the server token; OAuth is not supported yet)`;
		}
		return `MCP request failed (${detail})`;
	}

	private death(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		const scrubbed = this.redact(reason);
		this.diagnostics = scrubbed;
		for (const controller of [...this.controllers]) controller.abort();
		try {
			this.events?.onDeath(scrubbed);
		} catch {
			// death handlers must never take the transport down
		}
	}

	private redact(text: string): string {
		let out = text;
		for (const secret of this.secrets) out = out.split(secret).join("«redacted»");
		return out;
	}
}

function isResponseFor(msg: Record<string, unknown>, id: number): boolean {
	return typeof msg.id === "number" && msg.id === id;
}

/** Read at most SNIPPET_BYTES of an error body, then drop the rest. */
async function readSnippet(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < SNIPPET_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) {
				chunks.push(value);
				total += value.byteLength;
			}
		}
	} catch {
		// best effort — diagnostics only
	} finally {
		void reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
		.subarray(0, SNIPPET_BYTES)
		.toString("utf-8")
		.replace(/\s+/g, " ")
		.trim();
}
