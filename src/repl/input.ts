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
	/** The readline stream hit EOF/close — no prompt() may run after this. */
	private streamClosed = false;
	private onProcessSigint: (() => void) | null = null;
	/** Current prompt string ("+ "/"> ") — restored after a confirm question. */
	private prompt = "> ";
	/** Queued [y/N] questions (api.confirm's tty side). Concurrent gated
	 *  children can ask before the first is answered — FIFO keeps each answer
	 *  bound to its own question. */
	/** FIFO questions — yes/no confirms and text prompts (/login keys). */
	private pendingAsks: Array<
		| { kind: "yesno"; question: string; resolve: (approved: boolean) => void }
		| { kind: "text"; question: string; resolve: (answer: string | null) => void }
	> = [];

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
				this.settleAsk(line === "" ? null : line);
				return;
			}
			this.options.onLine(line);
		});
		// Terminal mode: readline captures \x03 and emits SIGINT on the interface.
		rl.on("SIGINT", () => {
			if (this.pendingAsks.length > 0) {
				// Ctrl+C cancels the question — a declined confirm is a block,
				// not an interrupt; the run itself keeps going.
				this.settleAsk(null);
				return;
			}
			this.options.onInterrupt();
		});
		// Non-TTY / `kill -INT` case; idempotent through the caller's state machine.
		// Pending questions are drained as declines first: the run is being
		// aborted, they are moot, and a queued question would silently swallow
		// the user's next typed line as its answer.
		const onProcessSigint = () => {
			this.drainAsks();
			this.options.onInterrupt();
		};
		this.onProcessSigint = onProcessSigint;
		process.on("SIGINT", onProcessSigint);
		// EOF / pipe end: buffered lines are delivered before "close" (readline guarantees it).
		rl.on("close", () => {
			// FIRST, before draining: no prompt() may run on a closed interface
			this.streamClosed = true;
			while (this.pendingAsks.length > 0) this.settleAsk(null); // EOF cancels
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
		// streamClosed: the input already hit EOF — a queued question can never
		// be answered (no lines will ever arrive), so decline immediately. The
		// close handler drains asks queued BEFORE it; this guards the ones that
		// arrive after, while the in-flight run keeps producing tool gates.
		if (this.rl === null || this.closed || this.streamClosed) return Promise.resolve(false);
		const rl = this.rl;
		return new Promise<boolean>((resolve) => {
			const wasIdle = this.pendingAsks.length === 0;
			this.pendingAsks.push({ kind: "yesno", question, resolve });
			if (wasIdle) {
				rl.setPrompt(question);
				rl.prompt(true);
			}
		});
	}

	/** Text question (/login's api-key prompt). The readline shell echoes
	 *  the typed line — same as pi's dialog, which does not mask either. */
	secret(question: string): Promise<string | null> {
		if (this.rl === null || this.closed || this.streamClosed) return Promise.resolve(null);
		const rl = this.rl;
		return new Promise<string | null>((resolve) => {
			const wasIdle = this.pendingAsks.length === 0;
			this.pendingAsks.push({ kind: "text", question, resolve });
			if (wasIdle) {
				rl.setPrompt(question);
				rl.prompt(true);
			}
		});
	}

	/** Resolve the oldest pending question, then show the next (if queued).
	 * Resolves FIRST: rendering the next question touches a readline interface
	 * that may already be closed (EOF drain) — a thrown ERR_USE_AFTER_CLOSE must
	 * never strand the awaiting gate. */
	private settleAsk(value: string | null): void {
		const oldest = this.pendingAsks.shift();
		if (oldest === undefined) return;
		if (oldest.kind === "yesno") oldest.resolve(value !== null && isYes(value));
		else oldest.resolve(value !== null && value.trim() !== "" ? value : null); // blank = cancel
		const next = this.pendingAsks[0];
		if (next !== undefined) {
			this.setPromptIfLive(next.question);
		} else {
			this.restorePrompt();
		}
	}

	/** Decline every pending question without rendering anything (abort paths). */
	private drainAsks(): void {
		while (this.pendingAsks.length > 0) {
			const oldest = this.pendingAsks.shift();
			if (oldest === undefined) continue;
			if (oldest.kind === "yesno") oldest.resolve(false);
			else oldest.resolve(null);
		}
	}

	/** setPrompt+prompt guarded against a closed stream (EOF already fired). */
	private setPromptIfLive(question: string): void {
		if (this.streamClosed) return;
		this.rl?.setPrompt(question);
		this.rl?.prompt(true);
	}

	/** Back to the machine's prompt ("+ "/"> ") after a question was answered. */
	private restorePrompt(): void {
		if (this.rl === null || !this.options.interactive || this.closed || this.streamClosed) return;
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
