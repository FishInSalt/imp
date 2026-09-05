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

/** The [y/N] contract: only an explicit y/yes (case-insensitive) approves. */
function isYes(answer: string): boolean {
	return /^y(?:es)?$/i.test(answer.trim());
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
	/** Current prompt string ("+ "/"> ") — restored after a confirm question. */
	private prompt = "> ";
	/** Queued [y/N] questions (api.confirm's tty side). Concurrent gated
	 *  children can ask before the first is answered — FIFO keeps each answer
	 *  bound to its own question. */
	private pendingAsks: Array<{ question: string; resolve: (approved: boolean) => void }> = [];

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
		rl.on("line", (line: string) => {
			if (this.pendingAsks.length > 0) {
				this.settleAsk(isYes(line));
				return;
			}
			this.options.onLine(line);
		});
		// Terminal mode: readline captures \x03 and emits SIGINT on the interface.
		rl.on("SIGINT", () => {
			if (this.pendingAsks.length > 0) {
				// Ctrl+C answers the question with "no" — a declined confirm is a
				// block, not an interrupt; the run itself keeps going.
				this.settleAsk(false);
				return;
			}
			this.options.onInterrupt();
		});
		// Non-TTY / `kill -INT` case; idempotent through the caller's state machine.
		const onProcessSigint = () => this.options.onInterrupt();
		this.onProcessSigint = onProcessSigint;
		process.on("SIGINT", onProcessSigint);
		// EOF / pipe end: buffered lines are delivered before "close" (readline guarantees it).
		rl.on("close", () => {
			while (this.pendingAsks.length > 0) this.settleAsk(false); // EOF answers "no"
			if (!this.closed) this.options.onEof();
		});
		if (this.options.interactive) rl.prompt();
	}

	/** Prompt becomes "+ " while a run/compaction is active, "> " when idle. */
	setActive(active: boolean): void {
		if (this.rl === null || !this.options.interactive) return;
		this.prompt = active ? "+ " : "> ";
		this.rl.setPrompt(this.prompt);
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

	/** One-line [y/N] question on the live interface (api.confirm's tty side).
	 * While pending, input lines answer the question instead of reaching
	 * onLine — a "y" typed at a prompt must never leak into the queue as
	 * steering text. Empty, EOF, and anything but y/yes resolve false. */
	ask(question: string): Promise<boolean> {
		if (this.rl === null || this.closed) return Promise.resolve(false);
		const rl = this.rl;
		return new Promise<boolean>((resolve) => {
			const wasIdle = this.pendingAsks.length === 0;
			this.pendingAsks.push({ question, resolve });
			if (wasIdle) {
				rl.setPrompt(question);
				rl.prompt(true);
			}
		});
	}

	/** Resolve the oldest pending question, then show the next (if queued). */
	private settleAsk(approved: boolean): void {
		const oldest = this.pendingAsks.shift();
		if (oldest === undefined) return;
		const next = this.pendingAsks[0];
		if (next !== undefined) {
			this.rl?.setPrompt(next.question);
			this.rl?.prompt(true);
		} else {
			this.restorePrompt();
		}
		oldest.resolve(approved);
	}

	/** Back to the machine's prompt ("+ "/"> ") after a question was answered. */
	private restorePrompt(): void {
		if (this.rl === null || !this.options.interactive || this.closed) return;
		this.rl.setPrompt(this.prompt);
		this.rl.prompt(true);
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
