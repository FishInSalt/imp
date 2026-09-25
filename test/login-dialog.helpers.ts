// #login-dialog: shared TUI test fixtures — FakeTerminal, settle, stripAnsi
// (extracted from repl-tui.test.ts verbatim; import-only, no test cases).
import { StdinBuffer, type Terminal } from "../src/tui.js";

export async function settle(extraMs = 30): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, extraMs));
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function stripAnsi(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch !== "\x1b") {
			if (ch !== "\r" && ch !== "\x07") out += ch;
			continue;
		}
		const next = text[i + 1];
		if (next === "[") {
			// CSI: parameters/intermediates until the final letter
			i += 2;
			while (i < text.length && !/[A-Za-z]/.test(text[i] ?? "")) i++;
		} else if (next === "]") {
			// OSC: skip to BEL or ST
			i += 2;
			while (i < text.length && text[i] !== "\x07" && text[i] !== "\x1b") i++;
			if (text[i] === "\x1b" && text[i + 1] === "\\") i++;
		} else {
			i += 1; // two-character escape
		}
	}
	return out;
}

export class FakeTerminal implements Terminal {
	private buffer: StdinBuffer | null = null;
	private rawInput: ((data: string) => void) | null = null;
	private columnCount: number;
	private readonly rowCount: number;
	private onResize: (() => void) | null = null;
	readonly writes: string[] = [];

	constructor(columnCount = 80, rowCount = 24) {
		this.columnCount = columnCount;
		this.rowCount = rowCount;
	}

	/** Simulate SIGWINCH: the width changes and the TUI's resize hook
	 *  (bound to requestRender) fires. */
	resize(columns: number): void {
		this.columnCount = columns;
		this.onResize?.();
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		// Production splits stdin bursts into per-key sequences and re-wraps
		// paste events (terminal.ts binds both) — mirror it exactly.
		const buffer = new StdinBuffer();
		buffer.on("data", (sequence: string) => onInput(sequence));
		buffer.on("paste", (content: string) => onInput(`\x1b[200~${content}\x1b[201~`));
		this.buffer = buffer;
		this.rawInput = onInput;
		this.onResize = onResize;
	}

	stop(): void {
		this.buffer = null;
		this.rawInput = null;
		this.onResize = null;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.columnCount;
	}

	get rows(): number {
		return this.rowCount;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	/** Inject keystrokes through the real splitter (like stdin bursts). */
	data(text: string): void {
		this.buffer?.process(text);
	}

	/** Inject bytes past the splitter straight into the TUI handler —
	 *  observable even after stop(), which is what close() tests need. */
	rawData(text: string): void {
		this.rawInput?.(text);
	}

	/** Everything written since `mark`, ANSI/control-stripped. */
	frameSince(mark: number): string {
		// Write-boundary safe (debt clearance): joining raw writes could glue
		// the tail of one frame to the head of the next into a phantom line —
		// a boundary break is inserted when neither side ends a line. NOTE:
		// the inserted \n is synthetic — assertions must never match text
		// ACROSS a write boundary (same logical line split over two writes
		// would read as two lines here; no current TUI write does that).
		let out = "";
		for (const write of this.writes.slice(mark)) {
			const text = stripAnsi(write);
			if (out !== "" && !out.endsWith("\n") && !text.startsWith("\n")) out += "\n";
			out += text;
		}
		return out;
	}
}
