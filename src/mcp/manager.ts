/**
 * MCP server orchestration (M18, docs/m18-mcp-design.md §5).
 *
 * Owns one McpClient + bridged tool set per configured server and keeps the
 * shared runner.tools array current. Two self-review rules shape it:
 *
 * 1. Late registration waits for run boundaries. The loop's wire request
 *    reads the live tools array every turn (loop.ts:154) but execution goes
 *    through a toolMap snapshot built once per run (:126) — a tool pushed
 *    mid-run would be SENT to the model and then fail "unknown tool". So:
 *    busy ⇒ park in pendingSync, flush at onRunEnd/onRunStart.
 * 2. Reconnect has two trigger paths. Startup failures (tools never
 *    registered — the call trigger cannot fire) retry at run boundaries
 *    (cap 3, 30s cooldown); mid-session death (tools registered, client
 *    dead) retries on the next tool call through callTool's ensure route,
 *    single-flight.
 */

import type { Tool } from "../core/tools/types.js";
import type { Renderer } from "../render.js";
import { bridgeTool, mapCallResult } from "./bridge.js";
import { McpClient, McpConnectionError } from "./client.js";
import type { McpServerConfig } from "./config.js";

/** Run-boundary retry budget for startup-failed servers. */
const STARTUP_RETRY_CAP = 3;
/** Shared cooldown for both reconnect paths. */
const RECONNECT_COOLDOWN_MS = 30_000;

export type McpServerStatus = "disabled" | "connecting" | "connected" | "failed" | "disconnected";

interface ServerState {
	config: McpServerConfig;
	status: McpServerStatus;
	client: McpClient | null;
	tools: Tool[];
	/** Names this server currently owns in the shared array. */
	registeredNames: Set<string>;
	error: string | null;
	/** Run-boundary retry counter (startup-failure path). */
	attempts: number;
	lastAttemptAt: number;
	/** Single-flight reconnect promise (call-triggered path). */
	reconnecting: Promise<void> | null;
	/** Tools landed mid-run; flush at the next boundary. */
	pendingSync: boolean;
}

export interface McpManagerOptions {
	servers: readonly McpServerConfig[];
	/** Default cwd for stdio servers without their own (pi server-manager:265). */
	cwd: string;
	/** clientInfo.version for the initialize handshake. */
	version: string;
	renderer: Renderer;
	/** Test seams for the timeout knobs. */
	connectTimeoutMs?: number;
	callTimeoutMs?: number;
	/** Test seam: reconnect cooldown (default 30s — tests run in milliseconds). */
	reconnectCooldownMs?: number;
}

export class McpManager {
	private readonly states = new Map<string, ServerState>();
	private shared: Tool[] | null = null;
	private busy = false;
	private closed = false;

	constructor(private readonly options: McpManagerOptions) {
		for (const config of options.servers) {
			this.states.set(config.name, {
				config,
				// Non-disabled servers start "connecting": connectAll() runs right
				// after construction. This also keeps onRunStart's failed-retry
				// loop away from servers that have never actually attempted — the
				// startup-failure path only ever sees status "failed" set by a
				// REAL connect attempt (self-review P1 fix depends on this).
				status: config.disabled ? "disabled" : "connecting",
				client: null,
				tools: [],
				registeredNames: new Set(),
				error: null,
				attempts: 0,
				lastAttemptAt: 0,
				reconnecting: null,
				pendingSync: false,
			});
		}
	}

	/** Bind the live tools array (runner.tools — splice in place, never replace). */
	attachToolsArray(tools: Tool[]): void {
		this.shared = tools;
	}

	/** Fire-and-forget initial connections (never blocks startup). */
	connectAll(): void {
		for (const state of this.states.values()) {
			if (state.config.disabled) continue;
			void this.connectServer(state);
		}
	}

	/** Run boundary (start): mark busy, flush pending, retry startup-failures
	 *  within budget+cooldown. Called BEFORE runner.runTurn so flushed tools
	 *  join THIS run's toolMap. */
	onRunStart(): void {
		this.busy = true;
		this.flushPending();
		const now = Date.now();
		for (const state of this.states.values()) {
			if (state.status !== "failed") continue;
			if (state.attempts >= STARTUP_RETRY_CAP) continue;
			if (now - state.lastAttemptAt < (this.options.reconnectCooldownMs ?? RECONNECT_COOLDOWN_MS)) continue;
			void this.connectServer(state);
		}
	}

	/** Run boundary (end): clear busy, flush anything that landed mid-run. */
	onRunEnd(): void {
		this.busy = false;
		this.flushPending();
	}

	/** Status snapshot for /mcp. */
	statusLines(): { name: string; status: McpServerStatus; tools: number; error: string | null }[] {
		return [...this.states.values()].map((s) => ({
			name: s.config.name,
			status: s.status,
			tools: s.status === "connected" ? s.tools.length : 0,
			error: s.error,
		}));
	}

	/** Route for bridged tools' execute: reconnect-aware callTool. A
	 *  connection that dies MID-CALL (the exit event races the request —
	 *  ensureClient saw a live client) gets exactly one reconnect+retry;
	 *  timeouts and aborts propagate untouched (they are not deaths). */
	async callTool(serverName: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal) {
		const state = this.states.get(serverName);
		if (state === undefined) throw new Error(`unknown MCP server "${serverName}"`);
		let client = await this.ensureClient(state);
		try {
			return mapCallResult(await client.callTool(toolName, args, signal));
		} catch (err) {
			if (!(err instanceof McpConnectionError) || signal.aborted || this.closed) throw err;
			client = await this.ensureClient(state); // single-flight reconnect
			return mapCallResult(await client.callTool(toolName, args, signal));
		}
	}

	/** Graceful close (gracefulExit path). */
	close(): void {
		this.closed = true;
		for (const state of this.states.values()) state.client?.close();
	}

	/** Synchronous best-effort kill (double-Ctrl+C force path). */
	forceKill(): void {
		this.closed = true;
		for (const state of this.states.values()) state.client?.forceKill();
	}

	get isClosed(): boolean {
		return this.closed;
	}

	// --- internals ---------------------------------------------------------

	/** Mid-session death: keep stale tools registered (their execute reroutes
	 *  through callTool → ensureClient), just record the state. */
	private markDead(state: ServerState, reason: string): void {
		if (state.status === "connected") {
			state.status = "disconnected";
			state.error = reason;
		}
	}

	private async connectServer(state: ServerState): Promise<void> {
		state.status = "connecting";
		state.error = null;
		state.lastAttemptAt = Date.now();
		const client = new McpClient({
			name: state.config.name,
			command: state.config.command,
			args: state.config.args,
			env: state.config.env,
			cwd: state.config.cwd ?? this.options.cwd,
			clientVersion: this.options.version,
			connectTimeoutMs: this.options.connectTimeoutMs,
			callTimeoutMs: this.options.callTimeoutMs,
		});
		client.onDead = (reason) => this.markDead(state, reason);
		state.client = client;
		try {
			await client.connect();
			const infos = await client.listTools();
			state.tools = this.bridgeAll(state, infos);
			state.status = "connected";
			state.attempts = 0;
			this.applyTools(state);
			if (state.tools.length > 0) {
				this.options.renderer.note(`▪ mcp ${state.config.name}: ${state.tools.length} tools ready`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A connected client whose listTools failed must not leak — close
			// before dropping the reference (no-op if the client died itself).
			client.close();
			state.status = "failed";
			state.error = message;
			state.attempts++;
			state.client = null;
		}
	}

	/** Bridge every server tool, skipping names that cannot register. */
	private bridgeAll(state: ServerState, infos: import("./client.js").McpToolInfo[]): Tool[] {
		const tools: Tool[] = [];
		for (const info of infos) {
			const { tool, error } = bridgeTool(state.config.name, info, (args, signal) =>
				this.callTool(state.config.name, info.name, args, signal),
			);
			if (tool !== undefined) tools.push(tool);
			else this.options.renderer.note(error ?? "mcp: tool skipped");
		}
		return tools;
	}

	/** Splice this server's tools into the shared array (or park pending). */
	private applyTools(state: ServerState): void {
		if (this.shared === null) return;
		if (this.busy) {
			state.pendingSync = true;
			return;
		}
		this.syncNow(state);
	}

	private flushPending(): void {
		if (this.shared === null) return;
		for (const state of this.states.values()) {
			if (state.pendingSync) this.syncNow(state);
		}
	}

	/** Replace this server's registered names with its current tool set.
	 *  Conflicts (another tool already owns the name — builtin, extension,
	 *  another server) skip with a note, matching the extension contract. */
	private syncNow(state: ServerState): void {
		state.pendingSync = false;
		const shared = this.shared;
		if (shared === null) return;
		if (state.registeredNames.size > 0) {
			const mine = state.registeredNames;
			for (let i = shared.length - 1; i >= 0; i--) {
				const tool = shared[i];
				if (tool !== undefined && mine.has(tool.name)) shared.splice(i, 1);
			}
		}
		const taken = new Set(shared.map((t) => t.name));
		state.registeredNames = new Set();
		for (const tool of state.tools) {
			if (taken.has(tool.name)) {
				this.options.renderer.note(`imp: mcp ${state.config.name} tool "${tool.name}" conflicts — skipped`);
				continue;
			}
			shared.push(tool);
			taken.add(tool.name);
			state.registeredNames.add(tool.name);
		}
	}

	/** Call-triggered reconnect (single-flight, cooldown). */
	private async ensureClient(state: ServerState): Promise<McpClient> {
		if (state.client?.isConnected) return state.client;
		if (this.closed) throw new Error("imp is shutting down");
		if (state.reconnecting !== null) {
			await state.reconnecting;
		} else if (
			Date.now() - state.lastAttemptAt >=
			(this.options.reconnectCooldownMs ?? RECONNECT_COOLDOWN_MS)
		) {
			state.reconnecting = this.connectServer(state).finally(() => {
				state.reconnecting = null;
			});
			await state.reconnecting;
		}
		if (state.client?.isConnected) return state.client;
		throw new Error(
			state.error !== null
				? `MCP server "${state.config.name}" unavailable (${state.error})`
				: `MCP server "${state.config.name}" unavailable (on cooldown after a recent failure — retry shortly)`,
		);
	}
}
