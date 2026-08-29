import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { Writable } from "node:stream";

export interface ReplOutput {
	write(text: string): void;
	isTTY?: boolean;
	columns?: number;
}

export interface ReplInputOptions {
	input: Readable; // default process.stdin
	output: ReplOutput; // default process.stdout
	/** stdin && stdout are TTYs — enables prompts, echo, and history. */
	interactive: boolean;
	onLine(line: string): void;
	onInterrupt(): void;
	onEof(): void;
}

/**
 * Wraps a ReplOutput in a real Writable: readline needs an EventEmitter
 * (output.on("resize")) in terminal mode; all bytes still flow to the
 * ReplOutput untouched.
 */
/** Attachable TTY metadata (readline reads output.isTTY/output.columns). */
type TtyWritable = Writable & { isTTY?: boolean; columns?: number };

/** Runtime-only readline properties: public but not in @types/node (design §13.1). */
interface RlRuntime {
	line: string;
	history: string[];
}

function proxyOutput(output: ReplOutput): Writable {
	const proxy = new Writable({
		write(chunk, _encoding, callback) {
			output.write(String(chunk));
			callback();
		},
	}) as TtyWritable;
	proxy.isTTY = output.isTTY;
	if (output.columns !== undefined) proxy.columns = output.columns;
	return proxy;
}

/**
 * The only module that touches node:readline. One persistent "line" handler
 * routes by state in the caller (repl.ts) — there is no nextLine() polling,
 * so line events always have exactly one consumer.
 */
export class ReplInput {
	private readonly options: ReplInputOptions;
	private rl: readline.Interface | null = null;
	private closed = false;
	private onProcessSigint: (() => void) | null = null;

	constructor(options: ReplInputOptions) {
		this.options = options;
	}

	start(): void {
		if (this.rl !== null || this.closed) return;
		const rl = readline.createInterface({
			input: this.options.input,
			output: proxyOutput(this.options.output),
			terminal: this.options.interactive,
			prompt: "> ",
			historySize: 100, // readline skips empties + consecutive dups (interactive only)
		});
		this.rl = rl;
		rl.on("line", (line: string) => this.options.onLine(line));
		// Terminal mode: readline captures \x03 and emits SIGINT on the interface.
		rl.on("SIGINT", () => this.options.onInterrupt());
		// Non-TTY / `kill -INT` case; idempotent through the caller's state machine.
		const onProcessSigint = () => this.options.onInterrupt();
		this.onProcessSigint = onProcessSigint;
		process.on("SIGINT", onProcessSigint);
		// EOF / pipe end: buffered lines are delivered before "close" (readline guarantees it).
		rl.on("close", () => {
			if (!this.closed) this.options.onEof();
		});
		if (this.options.interactive) rl.prompt();
	}

	/** Prompt becomes "+ " while a run/compaction is active, "> " when idle. */
	setActive(active: boolean): void {
		if (this.rl === null || !this.options.interactive) return;
		this.rl.setPrompt(active ? "+ " : "> ");
		this.rl.prompt(true);
	}

	refresh(): void {
		if (this.rl === null || !this.options.interactive) return;
		this.rl.prompt(true);
	}

	/** Wipes typed-but-unsubmitted text. Returns true when text was discarded. */
	clearPending(): boolean {
		if (this.rl === null) return false;
		const rl = this.rl as unknown as RlRuntime;
		const had = rl.line !== "";
		rl.line = "";
		if (this.options.interactive) this.rl.prompt(true);
		return had;
	}

	/** History so far (newest first, as readline keeps it). Interactive only. */
	getHistory(): readonly string[] {
		return this.rl ? (this.rl as unknown as RlRuntime).history : [];
	}

	close(): void {
		if (this.closed) return;
		this.closed = true; // rl.close() would re-fire "close" → onEof
		if (this.onProcessSigint !== null) process.off("SIGINT", this.onProcessSigint);
		this.onProcessSigint = null;
		this.rl?.close();
	}
}
