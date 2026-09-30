/**
 * stdio transport — the M18 wire behavior moved behind McpTransport
 * (M19 D1, docs/m19-mcp-http-design.md). One line = one JSON-RPC message on
 * the server's stdout; stray non-JSON lines are skipped; a >10MB line kills
 * the connection (design R3); stderr keeps a 2KB ring for /mcp diagnosis.
 *
 * The core's closed flag is the authority for send guards; this class keeps
 * its own closed flag so close()/forceKill() suppress a self-reported death
 * from the exit/error listeners (the M19 D1 invariant).
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { McpTransport, TransportEvents } from "./transport.js";

/** Cap for one NDJSON line (design R3). */
const MAX_LINE_BYTES = 10 * 1024 * 1024;
/** Ring-buffer tail kept for failure diagnosis. */
const STDERR_TAIL_CHARS = 2048;

export interface StdioTransportOptions {
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export class StdioTransport implements McpTransport {
	readonly kind = "stdio" as const;
	private proc: ChildProcess | null = null;
	private events: TransportEvents | null = null;
	/** Raw byte buffer — lines split on 0x0A and decoded only when complete,
	 *  so a multi-byte UTF-8 char straddling a chunk boundary cannot corrupt
	 *  a line (review P2-4). Length is bytes (the 10MB guard means bytes). */
	private stdoutBuf: Buffer = Buffer.alloc(0);
	private stderrTail = "";
	private closed = false;

	constructor(private readonly options: StdioTransportOptions) {}

	async start(events: TransportEvents): Promise<void> {
		if (this.proc !== null) throw new Error("StdioTransport.start called twice");
		this.events = events;
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
	}

	send(msg: Record<string, unknown>, _signal?: AbortSignal): void {
		if (this.proc?.stdin?.writable !== true) return;
		this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	setProtocolVersion(_version: string): void {
		// stdio does not carry HTTP's MCP-Protocol-Version header (M19 D4).
	}

	async close(): Promise<void> {
		this.shutdown("graceful");
	}

	forceKill(): void {
		this.shutdown("SIGTERM");
	}

	getDiagnostics(): string {
		return this.stderrTail.trim();
	}

	isOpen(): boolean {
		return !this.closed;
	}

	// --- internals (moved from client.ts unchanged) ------------------------

	private feedStdout(chunk: Buffer): void {
		this.stdoutBuf = this.stdoutBuf.length === 0 ? chunk : Buffer.concat([this.stdoutBuf, chunk]);
		if (this.stdoutBuf.length > MAX_LINE_BYTES) {
			this.die("server wrote a line over 10MB — connection dropped (design R3)");
			return;
		}
		let nl = this.stdoutBuf.indexOf(0x0a);
		while (nl >= 0) {
			const line = this.stdoutBuf.subarray(0, nl).toString("utf-8");
			this.stdoutBuf = this.stdoutBuf.subarray(nl + 1);
			if (line.trim() !== "") this.handleLine(line);
			if (this.closed) return;
			nl = this.stdoutBuf.indexOf(0x0a);
		}
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return; // stray non-JSON line (design §3): skip
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
		this.events?.onMessage(parsed as Record<string, unknown>);
	}

	/** Unexpected death: kill the child, then notify the core (which rejects
	 *  everything pending and forwards to the manager). */
	private die(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.proc?.kill("SIGTERM");
		try {
			this.events?.onDeath(reason);
		} catch {
			// death handlers must never take the transport down
		}
	}

	/** Graceful close: stdin.end → 3s → SIGTERM → 2s → SIGKILL. */
	private shutdown(mode: "graceful" | "SIGTERM"): void {
		if (this.closed) return;
		this.closed = true;
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
