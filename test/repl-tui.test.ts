import { describe, expect, it } from "vitest";
import { TuiShell } from "../src/repl/shell.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { StdinBuffer, type Terminal } from "../src/tui.js";

// ── fakes ────────────────────────────────────────────────────────────────

/** The pi-tui Terminal contract, captured: writes logged, input injectable. */
class FakeTerminal implements Terminal {
	private buffer: StdinBuffer | null = null;
	private readonly columnCount: number;
	private readonly rowCount: number;
	readonly writes: string[] = [];

	constructor(columnCount = 80, rowCount = 24) {
		this.columnCount = columnCount;
		this.rowCount = rowCount;
	}

	start(onInput: (data: string) => void, _onResize: () => void): void {
		// The production terminal splits stdin bursts into per-key sequences
		// before TUI.handleInput — reuse the real splitter (escape-aware).
		const buffer = new StdinBuffer();
		buffer.on("data", (sequence: string) => onInput(sequence));
		this.buffer = buffer;
	}

	stop(): void {
		this.buffer = null;
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

	/** Inject keystrokes — split into per-key sequences like real stdin. */
	data(text: string): void {
		this.buffer?.process(text);
	}

	/** Everything written since `mark`, ANSI/control-stripped, as lines. */
	frameSince(mark: number): string {
		return stripAnsi(this.writes.slice(mark).join(""));
	}
}

/** Remove escape sequences, cursor markers, and lone \r the TUI emits. */
function stripAnsi(text: string): string {
	return text
		.replaceAll("\x1b_pi:c\x07", "") // hardware-cursor marker
		.replace(new RegExp("\\u001b\\[[0-9;?]*[A-Za-z]", "g"), "")
		.replace(new RegExp("\\u001b[()][A-B0-9]", "g"), "")
		.replaceAll("\\r\\n", "\n")
		.replaceAll("\r", "");
}

/** Settle TUI renders (requestRender is nextTick / 16ms-min-interval based). */
async function settle(extraMs = 25): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, extraMs));
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeShell(options?: { onLine?: (l: string) => void }) {
	const terminal = new FakeTerminal();
	const transcript = new TranscriptSink();
	const events: string[] = [];
	const shell = new TuiShell({
		transcript,
		terminal,
		onLine: (line) => {
			events.push(`line:${line}`);
			options?.onLine?.(line);
		},
		onInterrupt: () => events.push("interrupt"),
		onEof: () => events.push("eof"),
	});
	return { terminal, transcript, shell, events };
}

// ── TranscriptSink: the Renderer byte contract ────────────────────────────

describe("TranscriptSink", () => {
	it("accumulates streaming deltas across chunk boundaries and completes lines on \\n", () => {
		const sink = new TranscriptSink();
		sink.feed("hel");
		sink.feed("lo\n");
		sink.feed("wor");
		sink.feed("ld");
		expect(sink.completedLines()).toEqual(["hello"]);
		expect(sink.render(80)).toEqual(["hello", "world"]); // current line included
	});

	it("\\r\\x1b[2K rewrites the current line (spinner contract), erase-only leaves it empty", () => {
		const sink = new TranscriptSink();
		sink.feed("⠋ Thinking…");
		sink.feed("\r\x1b[2K⠙ Thinking… 1s");
		expect(sink.render(80)).toEqual(["⠙ Thinking… 1s"]);
		sink.feed("\r\x1b[2K"); // stopSpinner's erase
		// An erased line contributes nothing — no blank gap in the transcript
		expect(sink.render(80)).toEqual([]);
		expect(sink.completedLines()).toEqual([]);
	});

	it("a reset marker split across chunks is held, not written as text", () => {
		const sink = new TranscriptSink();
		sink.feed("⠋ a");
		sink.feed("\r");
		sink.feed("\x1b[2K");
		sink.feed("⠙ b\n");
		expect(sink.completedLines()).toEqual(["⠙ b"]);
	});

	it("a lone \\r that is not followed by the erase sequence stays content", () => {
		const sink = new TranscriptSink();
		sink.feed("a\rb\n");
		expect(sink.completedLines()).toEqual(["a\rb"]);
	});

	it("onUpdate fires once per changing feed for the TUI to requestRender", () => {
		const sink = new TranscriptSink();
		let calls = 0;
		sink.onUpdate = () => {
			calls += 1;
		};
		sink.feed("x\n");
		sink.feed("y\n");
		expect(calls).toBe(2);
		sink.feed("\r\x1b[2Kz"); // one rewrite, one call
		expect(calls).toBe(3);
	});
});

// ── TuiShell: the readline-era semantics on the pi-tui shell ─────────────

describe("TuiShell", () => {
	it("shows the idle marker; a submitted line routes to onLine exactly once", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle();
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).toContain("> ");
		terminal.data("hello\r");
		await settle();
		expect(events).toEqual(["line:hello"]);
		shell.close();
	});

	it('marker switches "> " ↔ "+ " with setActive; clearPending wipes editor text once', async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("draft");
		await settle(0);
		shell.setActive(true);
		let mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).toContain("+ ");
		expect(shell.clearPending()).toBe(true); // had text
		expect(shell.clearPending()).toBe(false); // now empty
		shell.setActive(false);
		mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).toContain("> ");
		shell.close();
	});

	it("records submitted lines as history, newest first, empties excluded", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("one\r");
		terminal.data("two\r");
		terminal.data("\r"); // empty submit: an event, but no history entry
		await settle();
		expect(shell.getHistory()).toEqual(["two", "one"]);
		shell.close();
	});

	it("ask FIFO: lines answer pending questions first; y/yes only; next question shows", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const first = shell.ask("proceed? [y/N] ");
		const second = shell.ask("also? [y/N] ");
		let mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).toContain("proceed? [y/N] ");
		terminal.data("y\r"); // answers the FIRST question
		await settle();
		await expect(first).resolves.toBe(true);
		mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).toContain("also? [y/N] "); // FIFO: second now visible
		terminal.data("nope\r");
		await settle();
		await expect(second).resolves.toBe(false);
		expect(shell.getHistory()).toEqual([]); // answers never leak into history
		shell.close();
	});

	it("Ctrl+C declines a pending ask (a block, not an interrupt)", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const question = shell.ask("proceed? [y/N] ");
		await settle(0);
		terminal.data("\x03");
		await settle();
		await expect(question).resolves.toBe(false);
		expect(events).toEqual([]); // no interrupt event
		shell.close();
	});

	it("Ctrl+C without an ask is an interrupt; EOF (Ctrl+D) on an empty editor", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("\x03");
		await settle();
		terminal.data("\x04");
		await settle();
		expect(events).toEqual(["interrupt", "eof"]);
		shell.close();
	});

	it("Ctrl+D with a pending ask declines it and signals EOF (drain semantics)", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const q1 = shell.ask("q1 ");
		const q2 = shell.ask("q2 ");
		await settle(0);
		terminal.data("\x04");
		await settle();
		await expect(q1).resolves.toBe(false);
		await expect(q2).resolves.toBe(false);
		expect(events).toEqual(["eof"]);
		shell.close();
	});

	it("the transcript sink renders into the frame (Renderer bytes hosted)", async () => {
		const { terminal, transcript, shell } = makeShell();
		shell.start();
		await settle(0);
		transcript.feed("▪ session abc — note line\n");
		await settle();
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).toContain("▪ session abc — note line");
		shell.close();
	});

	it("close() settles pending asks as declines and stops the terminal", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const question = shell.ask("proceed? [y/N] ");
		await settle(0);
		shell.close();
		await expect(question).resolves.toBe(false);
		expect(terminal.writes.length).toBe(terminal.writes.length); // stopped: no further renders
		const before = terminal.writes.length;
		terminal.data("y\r"); // input no longer routed
		await settle(0);
		expect(terminal.writes.length).toBe(before);
	});
});
