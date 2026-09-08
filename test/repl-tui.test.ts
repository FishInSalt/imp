import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { renderMdPrompt } from "../src/core/commands-md.js";
import type { AssistantMessage, UserMessage } from "../src/core/messages.js";
import { detectBinary } from "../src/core/tools/bin-detect.js";
import type { Tool } from "../src/core/tools/types.js";
import type { RegisteredExtensionCommand } from "../src/extensions/types.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { runRepl, TtyConfirm } from "../src/repl/repl.js";
import { type AutocompleteOptions, TuiShell } from "../src/repl/shell.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner, type Runner } from "../src/runner.js";
import {
	type AutocompleteSlashCommand,
	resolveShell,
	StdinBuffer,
	type Terminal,
	visibleWidth,
} from "../src/tui.js";
import {
	assistant,
	gate,
	gatedTool,
	type ScriptStep,
	scriptedProvider,
	ticks,
	waitUntil,
} from "./helpers/fakes.js";

// ── fakes ────────────────────────────────────────────────────────────────

/**
 * The pi-tui Terminal contract, captured: writes logged, input injectable
 * both through the real splitter and (post-stop) through the raw handler.
 */
class FakeTerminal implements Terminal {
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

/** Remove escape sequences (CSI/OSC/APC), cursor markers, and \r —
 *  hand-rolled scanner: no regex, so nothing trips lint, and OSC-8
 *  hyperlinks are skipped to their BEL/ST terminator. */
function stripAnsi(text: string): string {
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

/** Settle TUI renders: nextTick + the 16ms minimum render interval. */
async function settle(extraMs = 30): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, extraMs));
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeShell(options?: {
	onLine?: (l: string) => void;
	autocomplete?: AutocompleteOptions;
	historyPath?: string;
}) {
	const terminal = new FakeTerminal();
	const transcript = new TranscriptSink();
	const events: string[] = [];
	const shell = new TuiShell({
		transcript,
		terminal,
		autocomplete: options?.autocomplete,
		historyPath: options?.historyPath,
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

	it("\\r\\x1b[2K rewrites the current line (spinner contract), erase-only leaves nothing", () => {
		const sink = new TranscriptSink();
		sink.feed("⠋ Thinking…");
		sink.feed("\r\x1b[2K⠙ Thinking… 1s");
		expect(sink.render(80)).toEqual(["⠙ Thinking… 1s"]);
		sink.feed("\r\x1b[2K"); // stopSpinner's erase
		// An erased line contributes nothing — no blank gap in the transcript
		expect(sink.render(80)).toEqual([]);
		expect(sink.completedLines()).toEqual([]);
	});

	it("a reset marker is recognized MID-chunk, not only at chunk heads (merge safety)", () => {
		const sink = new TranscriptSink();
		sink.feed("a\r\x1b[2Kb\n");
		expect(sink.completedLines()).toEqual(["b"]); // terminal would show "b"
		sink.feed("\r\x1b[2Kabc\r\x1b[2Kdef\n");
		expect(sink.completedLines()).toEqual(["b", "def"]);
	});

	it("a trailing \\r is held back — a split marker still resolves; a lone \\r stays content", () => {
		const sink = new TranscriptSink();
		sink.feed("abc");
		sink.feed("\r"); // may be a marker head or content — undecided
		sink.feed("\x1b[2Kdef\n"); // it was a marker
		expect(sink.completedLines()).toEqual(["def"]);
		const lone = new TranscriptSink();
		lone.feed("a\rb\n");
		expect(lone.completedLines()).toEqual(["a\rb"]);
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

	// ── width contract (M9 review P0: pi-tui throws on over-wide lines) ──

	it("wraps every rendered line to the viewport width — no line exceeds it", () => {
		const sink = new TranscriptSink();
		sink.feed(`${"x".repeat(200)}\n`);
		sink.feed("done\n");
		const rendered = sink.render(80);
		expect(rendered.length).toBeGreaterThan(2); // it wrapped, not truncated away
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	it("wraps a realistic Renderer stream (bash tool-start + ⎿ summary + paragraph)", () => {
		const sink = new TranscriptSink();
		sink.feed("\r\x1b[2K● bash ");
		sink.feed(`{"command":"${"e".repeat(130)}}`);
		sink.feed("\n");
		sink.feed(`  ⎿  ${"r".repeat(90)} (+3 lines)\n`);
		sink.feed(`${"p".repeat(143)}\n`);
		for (const line of sink.render(80)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	it("CJK content wraps by columns, not characters", () => {
		const sink = new TranscriptSink();
		sink.feed(`${"汉".repeat(100)}\n`);
		for (const line of sink.render(80)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	it("resize rewraps: a width change rebuilds the cache", () => {
		const sink = new TranscriptSink();
		sink.feed(`${"y".repeat(100)}\n`);
		const wide = sink.render(120);
		expect(wide).toHaveLength(1);
		const narrow = sink.render(50);
		expect(narrow.length).toBeGreaterThan(1);
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
	});
});

// ── TuiShell: the readline-era semantics on the pi-tui shell ─────────────

describe("TuiShell", () => {
	it("idle: the hint row sits above the editor box; a submitted line routes to onLine exactly once", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle();
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		const frame = terminal.frameSince(mark);
		expect(frame).toContain("(/ for commands"); // hint marks the input area
		expect(frame).toMatch(/^\(\/ for commands/m); // flush-left: Text padding is (0,0), not pi-tui's (1,1) default
		terminal.data("hello\r");
		await settle();
		expect(events).toEqual(["line:hello"]);
		shell.close();
	});

	it("setActive toggles the hint row (the idle cue); clearPending wipes editor text once", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("draft");
		await settle(0);
		shell.setActive(true);
		let mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).not.toContain("(/ for commands"); // hidden while active
		expect(shell.clearPending()).toBe(true); // had text
		expect(shell.clearPending()).toBe(false); // now empty
		shell.setActive(false);
		mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).toContain("(/ for commands"); // back when idle
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

	it("up-arrow recalls the last submission (editor history is fed)", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("one\r");
		terminal.data("two\r");
		await settle();
		terminal.data("\x1b[A"); // Up
		await settle(0);
		terminal.data("\r"); // submits the recalled text
		await settle();
		expect(events).toEqual(["line:one", "line:two", "line:two"]);
		shell.close();
	});

	it("ask FIFO: lines answer pending questions first; y/yes only; exactly one visible", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const first = shell.ask("proceed? [y/N] ");
		const second = shell.ask("also? [y/N] ");
		await settle();
		expect(terminal.frameSince(0)).toContain("proceed? [y/N] ");
		expect(terminal.frameSince(0)).not.toContain("also?"); // one at a time
		terminal.data("y\r"); // answers the FIRST question
		await settle();
		await expect(first).resolves.toBe(true);
		await settle();
		expect(terminal.frameSince(0)).toContain("also? [y/N] "); // FIFO: second now visible
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
		expect(events).toEqual([]); // positive control: no interrupt event
		terminal.data("\x03"); // and plain Ctrl+C DOES interrupt (same shell)
		await settle();
		expect(events).toEqual(["interrupt"]);
		shell.close();
	});

	it("kitty key-RELEASE sequences never count as a second press (P0)", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("\x03"); // press
		terminal.rawData("\x1b[99;5:3u"); // release sequence (kitty CSI-u)
		await settle();
		expect(events).toEqual(["interrupt"]); // exactly one, not two
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

	it("Ctrl+D with a typed draft stays an editing key — no EOF, text kept (with or without an ask)", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const question = shell.ask("proceed? [y/N] ");
		await settle(0);
		terminal.data("y"); // typed draft answering the ask
		await settle(0);
		terminal.data("\x04"); // must NOT drain+EOF while a draft exists
		await settle();
		expect(events).toEqual([]);
		expect(shell.clearPending()).toBe(true); // draft survived
		terminal.data("\x7f"); // backspace the draft away
		await settle(0);
		terminal.data("\x04"); // now empty: decline + EOF
		await settle();
		await expect(question).resolves.toBe(false);
		expect(events).toEqual(["eof"]);
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

	it("the transcript renders into the frame WITHOUT forceRender (natural repaint pipeline)", async () => {
		const { terminal, transcript, shell } = makeShell();
		shell.start();
		await settle(0);
		const mark = terminal.writes.length;
		transcript.feed("▪ session abc — note line\n");
		await settle(); // no forceRender: the sink's onUpdate must paint it
		expect(terminal.frameSince(mark)).toContain("▪ session abc — note line");
		shell.close();
	});

	it("an ask appears without forceRender; setActive repaints on its own", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		let mark = terminal.writes.length;
		const question = shell.ask("proceed? [y/N] ");
		await settle();
		expect(terminal.frameSince(mark)).toContain("proceed? [y/N] ");
		mark = terminal.writes.length;
		shell.setActive(true);
		await settle();
		expect(terminal.frameSince(mark)).not.toContain("(/ for commands"); // hidden while active
		terminal.data("n\r");
		await settle();
		await expect(question).resolves.toBe(false);
		shell.close();
	});

	it("a wide transcript line renders wrapped — no crash, width honored", async () => {
		const { terminal, transcript, shell } = makeShell();
		shell.start();
		await settle(0);
		transcript.feed(`${"w".repeat(160)}\n`);
		await settle();
		expect(terminal.writes.length).toBeGreaterThan(0); // the TUI kept rendering
		shell.close();
	});

	it("close() settles pending asks, stops the terminal, and routes no further input", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const question = shell.ask("proceed? [y/N] ");
		await settle(0);
		shell.close();
		await expect(question).resolves.toBe(false);
		await settle(80); // past the deferred terminal stop
		const writesAtClose = terminal.writes.length;
		const eventsAtClose = [...events];
		terminal.rawData("y\r"); // bytes past stop: the raw handler, if any
		terminal.rawData("\x03");
		await settle(0);
		expect(terminal.writes.length).toBe(writesAtClose); // nothing painted
		expect(events).toEqual(eventsAtClose); // no line/interrupt leaked to the machine
	});

	it("the final frame before exit is painted — graceful-exit notes are not lost (P1)", async () => {
		const { terminal, transcript, shell } = makeShell();
		shell.start();
		await settle(0);
		transcript.feed("▪ session abc — saved, resume with: imp -r abc\n");
		shell.close(); // same-tick close, exactly like gracefulExit → finish()
		await settle(80); // deferred stop must let the pending paint land first
		expect(terminal.frameSince(0)).toContain("resume with: imp -r abc");
	});

	it("SIGINT (kill -INT) and stdin-end handlers are registered on start", async () => {
		const onSpy = vi.spyOn(process, "on");
		const stdinSpy = vi.spyOn(process.stdin, "on");
		const { shell } = makeShell();
		shell.start();
		await settle(0);
		expect(onSpy.mock.calls.some(([event]) => (event as string) === "SIGINT")).toBe(true);
		expect(stdinSpy.mock.calls.some(([event]) => (event as string) === "end")).toBe(true);
		onSpy.mockRestore();
		stdinSpy.mockRestore();
		shell.close();
	});
});

// ── TuiShell.select: the M9 phase-2 item picker ─────────────────────────

describe("TuiShell selector", () => {
	it("renders title and items (first row preselected); Enter confirms index 0", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "pick a model",
			items: [
				{ label: "alpha", description: "first" },
				{ label: "beta", description: "second" },
			],
		});
		await settle();
		const frame = terminal.frameSince(0);
		expect(frame).toContain("pick a model");
		expect(frame).toContain("alpha");
		expect(frame).toContain("beta");
		expect(frame).toContain("→ alpha"); // row 0 carries the selection marker
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("Down moves the selection; Enter confirms the moved-to index", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({ items: [{ label: "alpha" }, { label: "beta" }, { label: "gamma" }] });
		await settle();
		terminal.data("\x1b[B"); // Down
		await settle();
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).toContain("→ beta"); // marker moved
		expect(terminal.frameSince(mark)).not.toContain("→ alpha");
		terminal.data("\x1b[B"); // Down again → gamma
		terminal.data("\r"); // confirm
		await settle();
		await expect(chosen).resolves.toBe(2);
		shell.close();
	});

	it("Esc and Ctrl+C cancel to null — the machine interrupt never fires", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const viaEsc = shell.select({ items: [{ label: "alpha" }, { label: "beta" }] });
		await settle();
		terminal.data("\x1b"); // Esc
		await expect(viaEsc).resolves.toBeNull();
		const viaCtrlC = shell.select({ items: [{ label: "alpha" }, { label: "beta" }] });
		await settle();
		terminal.data("\x03");
		await expect(viaCtrlC).resolves.toBeNull();
		expect(events).toEqual([]); // positive control: no interrupt leaked out
		shell.close();
	});

	it("Ctrl+D is swallowed while a selector is open; close() settles it to null", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({ items: [{ label: "alpha" }] });
		await settle();
		terminal.data("\x04");
		await settle();
		expect(events).toEqual([]); // no eof — the selector outranks EOF
		shell.close();
		await expect(chosen).resolves.toBeNull();
	});

	it("after resolution the ask region is empty and keys reach the editor again", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({ title: "pick", items: [{ label: "alpha" }, { label: "beta" }] });
		await settle();
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		await settle();
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		const frame = terminal.frameSince(mark);
		expect(frame).not.toContain("pick");
		expect(frame).not.toContain("alpha");
		expect(frame).not.toContain("beta"); // the ask region is empty again
		terminal.data("hello\r");
		await settle();
		expect(events).toEqual(["line:hello"]); // the editor owns keys again
		shell.close();
	});

	it("an empty item list resolves to null without mounting anything", async () => {
		const { shell } = makeShell();
		shell.start();
		await settle(0);
		await expect(shell.select({ items: [] })).resolves.toBeNull();
		shell.close();
	});
});

// ── resolveShell: the documented escape hatch ────────────────────────────

describe("resolveShell", () => {
	it("defaults to the tui shell; IMP_REPL=legacy selects the readline path", async () => {
		const { resolveShell: rs } = await import("../src/tui.js");
		vi.stubEnv("IMP_REPL", "legacy");
		expect(rs()).toBe("legacy");
		vi.stubEnv("IMP_REPL", "");
		expect(rs()).toBe("tui");
		vi.unstubAllEnvs();
	});
});

// ── footer: the bottom status line ───────────────────────────────────────

describe("TuiShell footer", () => {
	it("setFooter paints a dim status line below the editor and updates in place", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setFooter("glm-5.3 · abc12345 · ↑1.2k ↓567");
		await settle(); // natural repaint — no forceRender
		expect(terminal.frameSince(0)).toContain("glm-5.3 · abc12345 · ↑1.2k ↓567");
		shell.setFooter("switched-model · abc12345");
		await settle();
		expect(terminal.frameSince(0)).toContain("switched-model · abc12345");
		shell.close();
	});

	it('setFooter("") blanks the row without breaking the layout', async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setFooter("something");
		shell.setFooter("");
		await settle();
		expect(terminal.frameSince(0)).not.toContain("something");
		expect(terminal.frameSince(0)).toContain("(/ for commands"); // layout intact
		shell.close();
	});
});

// ── queue visual: the M10 queue line ────────────────────────────────────

describe("TuiShell queue line (setQueue)", () => {
	it("paints a dim 'N queued · next:' row between the ask region and the marker", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setQueue(1, "queued A");
		await settle();
		const raw = terminal.writes.join("");
		expect(raw).toContain("\x1b[2m1 queued · next: queued A"); // dim is really emitted
		// placement: one full repaint, then read layout order out of that window
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		const frame = terminal.frameSince(mark);
		expect(frame).toContain("1 queued · next: queued A");
		expect(frame.indexOf("1 queued · next: queued A")).toBeLessThan(frame.indexOf("(/ for commands")); // above the hint
		// an update repaints in place
		shell.setQueue(2, "queued B");
		await settle();
		expect(terminal.frameSince(0)).toContain("2 queued · next: queued B");
		shell.close();
	});

	it("count 0 (or a null preview) collapses the row to zero lines", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setQueue(1, "queued A");
		await settle();
		expect(terminal.frameSince(0)).toContain("1 queued · next: queued A");
		shell.setQueue(0, null);
		await settle();
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).not.toContain("queued · next:");
		shell.close();
	});
});

// ── M9-2 review regressions ──────────────────────────────────────────────

describe("M9-2 review regressions", () => {
	it("Ctrl+C interrupts again after a picker resolved — selector state cleared", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const pick = shell.select({ items: [{ label: "a" }, { label: "b" }] });
		await settle(0);
		terminal.data("\r"); // pick row 0 — resolves and unmounts
		await expect(pick).resolves.toBe(0);
		terminal.data("\x03"); // mutation pin: without `selector = null` this is swallowed
		await settle();
		expect(events).toEqual(["interrupt"]);
		shell.close();
	});

	it("a second select() while one is open QUEUES — it opens when the first finishes (M10: the reentrant decline silently vetoed guardian confirms)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const first = shell.select({ items: [{ label: "a" }, { label: "b" }] });
		await settle();
		let secondSettled: (value: number | null) => void = () => {};
		const second = new Promise<number | null>((resolve) => {
			secondSettled = resolve;
		});
		void shell.select({ items: [{ label: "x" }] }).then(secondSettled);
		await settle(0);
		expect(terminal.frameSince(0)).toContain("→ a"); // the FIRST list is still mounted
		expect(terminal.frameSince(0)).not.toContain("→ x"); // the second is queued, not stacked
		terminal.data("\x1b[B");
		terminal.data("\r");
		await expect(first).resolves.toBe(1);
		await settle();
		expect(terminal.frameSince(0)).toContain("→ x"); // now the queued picker opened
		terminal.data("\r");
		await expect(second).resolves.toBe(0);
		shell.close();
	});

	it("close() drains a queued picker to null (no hang past the terminal stop)", async () => {
		const { shell } = makeShell();
		shell.start();
		await settle(0);
		const first = shell.select({ items: [{ label: "a" }] });
		let secondSettled: (value: number | null) => void = () => {};
		const second = new Promise<number | null>((resolve) => {
			secondSettled = resolve;
		});
		void shell.select({ items: [{ label: "x" }] }).then(secondSettled);
		shell.close(); // tears the first down, drains the queued one
		await expect(first).resolves.toBe(null);
		await expect(second).resolves.toBe(null);
	});

	it("a question queued while a picker is open renders only after the picker resolves", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const pick = shell.select({ items: [{ label: "a" }] });
		await settle(0);
		const question = shell.ask("proceed? [y/N] ");
		await settle();
		expect(terminal.frameSince(0)).toContain("→ a"); // positive control: picker rendered
		expect(terminal.frameSince(0)).not.toContain("proceed?"); // held, not shown under the list
		terminal.data("\x1b"); // cancel the picker
		await settle();
		await expect(pick).resolves.toBe(null);
		expect(terminal.frameSince(0)).toContain("proceed? [y/N] "); // flushed on finish
		terminal.data("y\r");
		await expect(question).resolves.toBe(true);
		shell.close();
	});

	it("SIGINT while a picker is open tears it down, then interrupts", async () => {
		const { shell, events } = makeShell();
		shell.start();
		await settle(0);
		const pick = shell.select({ items: [{ label: "a" }] });
		await settle(0);
		process.emit("SIGINT");
		await expect(pick).resolves.toBe(null);
		expect(events).toEqual(["interrupt"]);
		shell.close();
	});

	it("the footer is dim in the raw byte stream and sits below the editor box", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setFooter("glm-5.3 · abc12345");
		await settle();
		const raw = terminal.writes.join("");
		expect(raw).toContain("\x1b[2mglm-5.3"); // dim is really emitted (not just stripped away)
		const frame = terminal.frameSince(0);
		const footerAt = frame.lastIndexOf("glm-5.3");
		const borderAt = frame.lastIndexOf("────"); // the editor box's bottom border
		expect(footerAt).toBeGreaterThan(borderAt); // placement pin: below the editor
		shell.close();
	});
});

// ── M10: autocomplete panel, placeholder hint, Esc interrupt ───────────

/** fd probe for the @ completion tests — one spawn per process (bin-detect
 *  caches); environments without fd skip the fd-dependent pins. */
const fdReady = detectBinary("fd");

describe("TuiShell autocomplete (M10)", () => {
	const commands: AutocompleteSlashCommand[] = [
		{ name: "model", description: "switch the model" },
		{ name: "help", description: "show help" },
	];

	it("typing / filters the command panel — the provider is wired at construction", async () => {
		const { terminal, shell } = makeShell({ autocomplete: { commands, basePath: "/tmp", fdPath: null } });
		shell.start();
		await settle(120);
		terminal.data("/mo");
		await settle(120); // key travel + provider round-trip
		const frame = terminal.frameSince(0);
		expect(frame).toContain("model"); // the filtered match renders
		expect(frame).toContain("switch the model");
		expect(frame).not.toContain("show help"); // filtered out, not listed
		shell.close();
	});

	it("Enter on a slash completion completes AND submits in one press (pi-tui falls through for / prefixes)", async () => {
		const { terminal, shell, events } = makeShell({
			autocomplete: { commands, basePath: "/tmp", fdPath: null },
		});
		shell.start();
		await settle(0);
		terminal.data("/mo");
		await settle(120);
		terminal.data("\r");
		await settle(0);
		expect(events).toEqual(["line:/model"]); // completed, then submitted — one press
		shell.close();
	});

	it("without autocomplete options the editor stays provider-less — /mo submits raw", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("/mo");
		await settle(120);
		terminal.data("\r");
		await settle(0);
		expect(events).toEqual(["line:/mo"]); // no panel, no completion
		shell.close();
	});

	it("Esc closes the panel; the typed text stays and submits as-is", async () => {
		const { terminal, shell, events } = makeShell({
			autocomplete: { commands, basePath: "/tmp", fdPath: null },
		});
		shell.start();
		await settle(0);
		terminal.data("/mo");
		await settle(120);
		terminal.data("\x1b"); // Esc — close the panel (the splitter holds a lone ESC ~10ms)
		await settle(60);
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).not.toContain("switch the model"); // panel gone
		terminal.data("\r");
		await settle(0);
		expect(events).toEqual(["line:/mo"]); // the raw text survived
		shell.close();
	});

	it("@ lists files under basePath; Enter completes without submitting — a second Enter submits", async () => {
		if (!(await fdReady)) return; // fd missing here — the @ fuzzy search is off, nothing to pin
		const dir = await mkdtemp(path.join(tmpdir(), "imp-ac-"));
		await writeFile(path.join(dir, "alpha.txt"), "a", "utf-8");
		await writeFile(path.join(dir, "beta.md"), "b", "utf-8");
		const { terminal, shell, events } = makeShell({
			autocomplete: { commands: [], basePath: dir, fdPath: "fd" },
		});
		shell.start();
		await settle(0);
		terminal.data("@al");
		await settle(400); // @ debounce (20ms) + the fd walk
		expect(terminal.frameSince(0)).toContain("alpha.txt"); // the file list renders
		terminal.data("\r"); // complete — NOT submit (only / prefixes fall through)
		await settle(0);
		expect(events).toEqual([]);
		terminal.data("\r"); // now the completed text submits
		await settle(0);
		expect(events).toEqual(["line:@alpha.txt"]); // input aid: path text, nothing read
		shell.close();
	});
});

describe("TuiShell placeholder hint (M10)", () => {
	const hint = "(/ for commands · @ files · ! bash · shift+enter newline)";

	/** forceRender into a fresh mark — the differential renderer may skip
	 *  unchanged lines otherwise (same pattern as the marker tests). */
	async function paint(terminal: FakeTerminal, shell: TuiShell): Promise<string> {
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		return terminal.frameSince(mark);
	}

	it("idle + empty editor shows the hint; typing hides it; emptying restores it", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(); // the initial paint must land before the first mark
		expect(await paint(terminal, shell)).toContain(hint);
		terminal.data("hi");
		await settle(0);
		expect(await paint(terminal, shell)).not.toContain(hint);
		terminal.data("\x7f\x7f"); // backspace both chars → empty again
		await settle(0);
		expect(await paint(terminal, shell)).toContain(hint);
		shell.close();
	});

	it("active hides the hint; idle restores it (setActive drives it)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setActive(true);
		await settle(0);
		expect(await paint(terminal, shell)).not.toContain(hint);
		shell.setActive(false);
		await settle(0);
		expect(await paint(terminal, shell)).toContain(hint);
		shell.close();
	});

	it("a pending ask hides the hint; settling restores it", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const question = shell.ask("proceed? [y/N] ");
		await settle(0);
		expect(await paint(terminal, shell)).not.toContain(hint);
		terminal.data("n\r");
		await settle(0);
		await expect(question).resolves.toBe(false);
		expect(await paint(terminal, shell)).toContain(hint);
		shell.close();
	});
});

describe("TuiShell Esc routing (M10)", () => {
	it("Esc while active interrupts — the same machine path as Ctrl+C", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		shell.setActive(true);
		terminal.data("\x1b");
		await settle(60); // the splitter holds a lone ESC ~10ms before emitting it
		expect(events).toEqual(["interrupt"]);
		// Known dual-consumer edge (documented in HELP_KEYS): with the editor's
		// autocomplete panel ALSO open, this one Esc closes the panel and
		// interrupts — pi-tui exposes no panel-visibility state to split them,
		// so the key is deliberately left unconsumed.
		shell.close();
	});

	it("Esc while idle is an editor key — never an interrupt", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("\x1b");
		await settle(0);
		expect(events).toEqual([]);
		shell.close();
	});

	it("Esc with a selector open cancels the selector — the interrupt never fires", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		shell.setActive(true); // a run is live while the picker is open
		const pick = shell.select({ items: [{ label: "alpha" }, { label: "beta" }] });
		await settle(0);
		terminal.data("\x1b");
		await expect(pick).resolves.toBeNull(); // the selector consumed the Esc
		expect(events).toEqual([]); // positive control: no interrupt leaked out
		shell.close();
	});
});

describe("multi-line submissions (M10 pin)", () => {
	it("Ctrl+J newline + Enter submits ONE line event with an embedded newline", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("line1\nline2\r"); // \n = the Ctrl+J byte through the real splitter
		await settle(0);
		expect(events).toEqual(["line:line1\nline2"]);
		shell.close();
	});

	it("kitty shift+enter (CSI-u) inserts the newline the same way", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("aa\x1b[13;2ubb\r");
		await settle(0);
		expect(events).toEqual(["line:aa\nbb"]);
		shell.close();
	});
});

// ── runRepl ↔ TuiShell integration (the production wiring) ────────────

// ── runRepl ↔ TuiShell integration (the production wiring) ────────────

describe("runRepl with shell:tui", () => {
	const reply = (text: string): AssistantMessage => ({
		role: "assistant",
		blocks: [{ type: "text", text }],
		usage: { inputTokens: 10, outputTokens: 5 },
		stopReason: "end_turn",
	});

	async function startTuiRepl(
		scripts: ScriptStep[],
		options?: {
			commands?: RegisteredExtensionCommand[];
			tools?: Tool[];
			confirm?: boolean;
			agentsHomeDir?: string;
			provider?: LLMProvider; // inject an abort-aware hold stream when needed
		},
	) {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-tui-"));
		const requests: LLMRequest[] = [];
		const provider: LLMProvider = options?.provider ?? scriptedProvider(scripts, requests);
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink();
		const renderer = new Renderer({
			write: transcript.feed,
			ansi: false,
			liveTools: false, // no spinner timers; the byte path is what matters
			toolStyle: "one-line",
			markdown: false,
			foldedResults: true, // mirrors cli.ts's TUI wiring (M11 #1)
		});
		const runner = await createRunner({
			cwd: baseDir,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			renderer,
			provider,
			tools: options?.tools,
			agentsHomeDir: options?.agentsHomeDir,
			deferInit: false,
		});
		// cli.ts's confirm wiring: one renderer (the transcript's), one host —
		// runRepl binds its picker to the shell's select once it exists
		const confirm = options?.confirm === true ? new TtyConfirm(renderer) : undefined;
		const repl = runRepl({
			runner,
			commands: options?.commands ?? [],
			shell: "tui",
			transcript,
			terminal,
			interactive: true,
			confirm,
			exit: (code: number) => {
				throw new Error(`force-exit:${code}`);
			},
		});
		await ticks(2);
		return { runner, terminal, transcript, repl, requests, baseDir, confirm };
	}

	it("rejects a tui shell without the transcript (wiring guard)", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-tui-guard-"));
		const renderer = new Renderer({ write: () => {}, ansi: false, liveTools: false, toolStyle: "one-line" });
		const runner = await createRunner({
			cwd: baseDir,
			argv: [],
			model: "m",
			maxTokens: 8,
			maxTurns: 2,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer,
			provider: scriptedProvider([reply("x")]),
			deferInit: false,
		});
		await expect(runRepl({ runner, commands: [], shell: "tui", interactive: true })).rejects.toThrow(
			/requires the transcript/,
		);
	});

	it("runs a full turn through the TUI shell: banner, streamed reply, prompt restored", async () => {
		// A gated turn keeps the run in flight so the activity row actually
		// paints (an instant scripted reply would coalesce to one diff frame).
		let releaseTurn: () => void = () => {};
		const gated = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const env = await startTuiRepl([() => gated.then(() => reply("hello from the model"))]);
		await settle();
		expect(env.terminal.frameSince(0)).toContain("/help for commands"); // banner painted
		// P1 regression: the footer is live at STARTUP — the machine's
		// constructor push arrives before input.start() and must be buffered,
		// not dropped (no turn has run yet).
		expect(env.terminal.frameSince(0)).toMatch(/test-model · [0-9a-f]{8}/);
		env.terminal.data("hi\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("thinking"); // activity row while the turn runs
		releaseTurn();
		await settle();
		await settle();
		expect(env.requests.length).toBe(1);
		expect(env.requests[0]?.messages.at(-1)).toMatchObject({ role: "user", content: "hi" });
		expect(env.transcript.completedLines().join("\n")).toContain("hello from the model");
		expect(env.terminal.frameSince(0)).toContain("> "); // idle again after
		// Footer: model + session id8 at startup, cumulative tokens after the run
		expect(env.terminal.frameSince(0)).toMatch(/test-model · [0-9a-f]{8}/);
		expect(env.terminal.frameSince(0)).toContain("↑10 ↓5");
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("a submitted prompt echoes into the transcript, and the turn settles to ONE stats line (no cumulative)", async () => {
		const env = await startTuiRepl([reply("the answer")]);
		await settle();
		env.terminal.data("hello there\r");
		await settle();
		const lines = env.transcript.completedLines();
		expect(lines).toContain("> hello there"); // the question is visible above the answer
		expect(lines).toContain("the answer");
		// exactly one status line per turn: the run stats; the session
		// cumulative line moved to the TUI footer (dogfood 2026-09-09)
		expect(lines.some((l) => l.startsWith("— test-model ·"))).toBe(true);
		expect(lines.filter((l) => l.includes("msgs total")).length).toBe(0);
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("Ctrl+C routes through the machine: the quit hint lands in the transcript", async () => {
		const env = await startTuiRepl([reply("ok")]);
		await settle();
		env.terminal.data("\x03");
		await settle();
		expect(env.transcript.completedLines().join("\n")).toContain("press Ctrl+C again to quit");
		env.terminal.data("/exit\r");
		await env.repl;
	});

	it("/model with no args opens the selector; Down+Enter switches like /model <id>", async () => {
		const env = await startTuiRepl([reply("ok")]);
		await settle();
		env.terminal.data("/model\r");
		await settle();
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("models — switch applies from the next turn"); // title
		expect(frame).toContain("→ test-model"); // current id first, preselected
		expect(frame).toContain("claude-sonnet-4-5");
		expect(frame).toContain("glm-4.6"); // README-documented candidates listed
		expect(frame).toContain("current"); // the current row is marked
		env.terminal.data("\x1b[B"); // Down → claude-sonnet-4-5 (row 1)
		await settle();
		env.terminal.data("\r"); // pick
		await settle();
		expect(env.runner.model).toBe("claude-sonnet-4-5");
		expect(env.transcript.completedLines().join("\n")).toContain(
			"▪ model: test-model → claude-sonnet-4-5 (applies from the next turn)",
		);
		// Mutation pin: the footer refreshes after a COMMAND (no turn ran) —
		// runCommand's finally push is what makes this green.
		expect(env.terminal.frameSince(0)).toContain("claude-sonnet-4-5 · ");
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("/model selector: Esc cancels — no switch, no note, editor keeps keys", async () => {
		const env = await startTuiRepl([reply("ok")]);
		await settle();
		env.terminal.data("/model\r");
		await settle();
		// Positive control (review P2): the picker must actually be open —
		// without ctx.select, /model silently falls back to the legacy text
		// path and every later assertion would still pass.
		expect(env.terminal.frameSince(0)).toContain("models — switch applies from the next turn");
		env.terminal.data("\x1b"); // Esc — cancel
		await settle();
		expect(env.runner.model).toBe("test-model");
		expect(env.transcript.completedLines().join("\n")).not.toContain("▪ model:");
		env.terminal.data("/exit\r"); // keys still reach the editor
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("EOF on an empty editor exits gracefully with the session-saved note", async () => {
		const env = await startTuiRepl([reply("ok")]);
		await settle();
		env.terminal.data("\x04");
		const code = await env.repl;
		expect(code).toBe(0);
		await settle(80); // deferred stop paints the final note
		expect(env.terminal.frameSince(0)).toContain("saved");
	});

	it("an edit tool result becomes a collapsed fold; Ctrl+O expands the diff (producer wiring)", async () => {
		const env = await startTuiRepl([
			{
				role: "assistant",
				blocks: [
					{
						type: "toolCall",
						id: "c1",
						name: "edit",
						arguments: { path: "fold.txt", edits: [{ oldText: "hello", newText: "goodbye" }] },
					},
				],
				usage: { inputTokens: 10, outputTokens: 5 },
				stopReason: "tool_use",
			},
			reply("done"),
		]);
		await writeFile(path.join(env.baseDir, "fold.txt"), "hello\n", "utf-8");
		env.terminal.data("edit it\r");
		await settle();
		await settle();
		expect(env.terminal.frameSince(0)).toContain("▸ Edited fold.txt (1 edit applied) (+1/-1)");
		env.terminal.data("\x0f"); // Ctrl+O — expand the newest fold
		await settle();
		expect(env.terminal.frameSince(0)).toContain("+ goodbye");
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("autocomplete is live in production wiring: imp's COMMANDS feed the panel, Enter completes and runs /help", async () => {
		const env = await startTuiRepl([reply("ok")]);
		await settle();
		env.terminal.data("/he"); // filters COMMANDS: help matches, model does not
		await settle(150);
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("show this help"); // real /help summary → mapped description
		expect(frame).not.toContain("show the current model"); // filtered out
		env.terminal.data("\r"); // complete AND submit (pi-tui's / fall-through)
		await settle();
		expect(env.terminal.frameSince(0)).toContain("Commands:"); // /help actually ran
		env.terminal.data("/exit\r");
		await env.repl;
	});

	it("extension commands ride the same panel (M4b commands reach the provider)", async () => {
		const deploy: RegisteredExtensionCommand = {
			command: {
				name: "deploy",
				summary: "ship it",
				allowedDuringRun: false,
				run: (_args, ctx) => {
					ctx.renderer.writeLine("deployed!");
					return "handled";
				},
			},
			source: "test",
		};
		const env = await startTuiRepl([reply("ok")], { commands: [deploy] });
		await settle();
		env.terminal.data("/de");
		await settle(150);
		expect(env.terminal.frameSince(0)).toContain("ship it"); // extension row in the panel
		env.terminal.data("\r"); // complete + submit → dispatches the extension command
		await settle();
		expect(env.terminal.frameSince(0)).toContain("deployed!");
		env.terminal.data("/exit\r");
		await env.repl;
	});

	it("! passthrough on the TUI shell: dim echo, real bash tool, output in the transcript", async () => {
		const env = await startTuiRepl([reply("ok")]);
		await settle();
		env.terminal.data("! echo lane-a\r");
		await settle(200);
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("! echo lane-a"); // the echo line
		expect(frame).toContain("lane-a"); // the command's stdout rendered
		expect(env.requests.length).toBe(0); // never the model
	});

	// ── M10: the three-option confirm on the real shell ──

	it("confirm with a sessionKey opens the real three-option picker; 'don't ask again' short-circuits the next ask", async () => {
		const env = await startTuiRepl([reply("ok")], { confirm: true });
		const confirm = env.confirm;
		if (confirm === undefined) throw new Error("confirm host not wired");
		const first = confirm.handler("[guardian] allow this bash command?", "rm -rf node_modules", {
			sessionKey: "guardian:bash:rm",
		});
		await settle();
		expect(env.terminal.frameSince(0)).toContain("Yes, don't ask again this session"); // the picker is live
		env.terminal.data("\x1b[B"); // Down → "Yes, don't ask again this session"
		env.terminal.data("\r"); // pick it
		await expect(first).resolves.toBe(true);
		// same key again: approved WITHOUT a picker — the promise settles with no keypress
		const second = confirm.handler("[guardian] allow this bash command?", "rm -rf again", {
			sessionKey: "guardian:bash:rm",
		});
		await expect(second).resolves.toBe(true);
		await settle();
		expect(env.transcript.completedLines().join("\n")).toContain(
			"▪ confirm: [guardian] allow this bash command? — allowed for this session",
		);
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("the placeholder hint hides while a turn runs and returns when idle", async () => {
		let releaseTurn: () => void = () => {};
		const gated = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const env = await startTuiRepl([() => gated.then(() => reply("done"))]);
		await settle();
		expect(env.terminal.frameSince(0)).toContain("(/ for commands"); // idle at startup
		env.terminal.data("hi\r");
		const mark = env.terminal.writes.length;
		await settle();
		const runFrame = env.terminal.frameSince(mark); // the run's own repaint only
		expect(runFrame).toContain("thinking"); // activity row while gated
		expect(runFrame).toContain("> hi"); // the echoed prompt rides the same frame
		expect(runFrame).not.toContain("(/ for commands"); // hidden while running
		releaseTurn();
		const mark2 = env.terminal.writes.length;
		await settle();
		await settle();
		expect(env.terminal.frameSince(mark2)).toContain("(/ for commands"); // back when idle
		env.terminal.data("/exit\r");
		await env.repl;
	});

	// ── queue visual (M10): the machine pushes it, the shell paints it ──

	it("queue visual: queued lines paint 'N queued · next:', drain via steering/flush, then clear", async () => {
		const g = gate();
		const g2 = gate();
		let toolStarted = false;
		const slow: Tool = {
			name: "slow_tool",
			description: "waits for the test gate",
			parameters: Type.Object({ message: Type.String() }),
			async execute() {
				toolStarted = true;
				await g.promise;
				return { output: "done" };
			},
		};
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "x" } }],
					"tool_use",
				),
				() => g2.promise.then(() => reply("turn one done")), // held: keeps the post-steering frame on screen
				reply("turn two done"),
			],
			{ tools: [slow] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => toolStarted);
		env.terminal.data("queued A\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("1 queued · next: queued A");
		env.terminal.data("queued B\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("2 queued · next: queued A"); // the head stays the preview
		g.resolve();
		await waitUntil(() => env.requests.length >= 2); // steering poll consumed A; request 2 held open
		await settle();
		expect(env.terminal.frameSince(0)).toContain("1 queued · next: queued B");
		const mark = env.terminal.writes.length;
		g2.resolve(); // the run settles; leftover B flushes as its own turn → count 0
		await waitUntil(() => env.requests.length >= 3);
		await settle();
		expect(env.terminal.frameSince(mark)).not.toContain("queued · next:"); // the row cleared
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("queue visual: an abort discards the queue and clears the row", async () => {
		const g = gate();
		let toolStarted = false;
		const slow: Tool = {
			name: "slow_tool",
			description: "waits for the test gate",
			parameters: Type.Object({ message: Type.String() }),
			async execute() {
				toolStarted = true;
				await g.promise;
				return { output: "never" };
			},
		};
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "x" } }],
					"tool_use",
				),
			],
			{ tools: [slow] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => toolStarted);
		env.terminal.data("queued A\r");
		env.terminal.data("queued B\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("2 queued · next: queued A");
		const mark = env.terminal.writes.length;
		env.terminal.data("\x03"); // abort — the user takes control, the queue is discarded
		g.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("discarded 2 queued"));
		await settle();
		expect(env.terminal.frameSince(mark)).not.toContain("queued · next:");
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	// ── activity region (M10 B): thinking/tool/subagent rows replace the
	// byte-stream spinner in TUI mode ──

	it("thinking phase paints a spinner row while the model is gated; it clears on settle", async () => {
		const g = gate();
		const env = await startTuiRepl([() => g.promise.then(() => reply("hello"))]);
		await settle();
		env.terminal.data("go\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("thinking"); // the activity row, not a byte-stream spinner
		const mark = env.terminal.writes.length;
		g.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("hello"));
		await settle();
		expect(env.terminal.frameSince(mark)).not.toContain("thinking"); // row cleared on settle
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("a pending tool paints a live row; the ✓/⎿ completion stays in the transcript", async () => {
		const g = gate();
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "gated", arguments: { message: "slow" } }],
					"tool_use",
				),
				reply("done"),
			],
			{ tools: [gatedTool(g)] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("gated"));
		const pending = env.terminal.frameSince(0);
		expect(pending).toContain("gated"); // the live activity row
		expect(pending).not.toContain("●"); // no byte-stream pending line in TUI mode
		const mark = env.terminal.writes.length;
		g.resolve();
		// M11: success results fold — the ⎿ preview is replaced by a ▸ fold title
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("✓"));
		await settle();
		// the pending row is gone — spinner+name only ever appeared in the
		// activity region (the completion line uses ●, not a spinner frame)
		expect(env.terminal.frameSince(mark)).not.toMatch(
			/[\u280b\u2819\u28b9\u28b8\u287c\u2834\u2826\u2867\u2807\u283f] gated/,
		);
		const stream = env.transcript.completedLines().join("\n");
		expect(stream).toContain("✓"); // the completion line (Renderer, unchanged)
		expect(stream).not.toContain("⎿"); // M11: folded — the preview moved to the fold title
		expect(env.terminal.frameSince(0)).toContain("▸"); // the fold itself
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("a subagent paints a tree row held on screen; it leaves with the task", async () => {
		const agentsHome = await mkdtemp(path.join(tmpdir(), "imp-agents-"));
		await mkdir(path.join(agentsHome, ".imp", "agents"), { recursive: true });
		await writeFile(
			path.join(agentsHome, ".imp", "agents", "scout.md"),
			"---\nname: scout\ndescription: test scout\n---\nYou are a test scout.\n",
			"utf-8",
		);
		const childHold = gate();
		const env = await startTuiRepl(
			[
				// parent: call the task tool (instant — the row appears at once)
				assistant(
					[
						{
							type: "toolCall",
							id: "t1",
							name: "task",
							arguments: { prompt: "explore the tree", agent: "scout" },
						},
					],
					"tool_use",
				),
				// child: first response HELD — a fully-scripted child finishes inside
				// one render interval and the row would never paint
				() => childHold.promise.then(() => reply("scout done")),
				// parent: closing text
				reply("all done"),
			],
			{ agentsHomeDir: agentsHome },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("└─ scout"), 8000);
		expect(env.terminal.frameSince(0)).toContain("└─ scout · explore the tree"); // agent + task label
		const mark = env.terminal.writes.length;
		childHold.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("all done"), 8000);
		await settle();
		expect(env.terminal.frameSince(mark)).not.toContain("└─ scout"); // row left with the task call
		// M11: the task result folds — the report is the fold body/title now
		expect(env.terminal.frameSince(0)).toContain("▸");
		expect(env.terminal.frameSince(0)).toContain("scout done");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("child edit results never reach the Renderer or fold — zero ⎿, the one ▸ is the task result (P2#3)", async () => {
		const agentsHome = await mkdtemp(path.join(tmpdir(), "imp-agents-"));
		await mkdir(path.join(agentsHome, ".imp", "agents"), { recursive: true });
		await writeFile(
			path.join(agentsHome, ".imp", "agents", "scout.md"),
			"---\nname: scout\ndescription: test scout\n---\nYou are a test scout.\n",
			"utf-8",
		);
		const env = await startTuiRepl(
			[
				assistant(
					[
						{
							type: "toolCall",
							id: "t1",
							name: "task",
							arguments: { prompt: "edit the file", agent: "scout" },
						},
					],
					"tool_use",
				),
				// child: one edit call, then closing text
				assistant(
					[
						{
							type: "toolCall",
							id: "c1",
							name: "edit",
							arguments: { path: "alpha.txt", edits: [{ oldText: "two", newText: "TWO" }] },
						},
					],
					"tool_use",
				),
				reply("child report done"),
				reply("all done"),
			],
			{ agentsHomeDir: agentsHome },
		);
		await writeFile(path.join(env.baseDir, "alpha.txt"), "one\ntwo\nthree\n", "utf-8");
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("all done"), 8000);
		const stream = env.transcript.completedLines().join("\n");
		// M11: the top-level task result folds (no ⎿, one ▸); a child edit fed
		// to the Renderer would add its own ✓/⎿ pair
		expect(stream.match(/⎿/g) ?? []).toHaveLength(0);
		expect(stream).not.toContain("✓ edit");
		// and no fold from the child's edit (top-level-only fold rule): the one
		// ▸ is the task result's, never "edit alpha.txt"
		expect(env.terminal.frameSince(0)).toContain("▸");
		expect(env.terminal.frameSince(0)).not.toContain("▸ edit alpha.txt");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("M11: a bash-style result folds and Ctrl+O expands the full output; no ⎿ line (dogfood #1/#2)", async () => {
		const bashLike: Tool = {
			name: "bash",
			description: "test bash stand-in",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				// trailing \n: a terminator, not an extra blank line (review P2)
				return { output: "stdout:\nline-one\nline-two\nline-three\n" };
			},
		};
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "seq 3" } }],
					"tool_use",
				),
				reply("done"),
			],
			{ tools: [bashLike] },
		);
		await settle();
		env.terminal.data("run it\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("done"), 8000);
		// the preview shows the first OUTPUT line (not "stdout:") and folds
		expect(env.terminal.frameSince(0)).toContain("▸ line-one (+2 lines)");
		const stream = env.transcript.completedLines().join("\n");
		expect(stream).not.toContain("⎿");
		expect(stream).not.toContain("stdout:");
		// Ctrl+O expands the full content
		env.terminal.data("\x0f");
		await waitUntil(() => env.terminal.frameSince(0).includes("line-three"));
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("resize reflows the render — a wide fold truncates to the new width (debt clearance #16)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle();
		const long = "x".repeat(70);
		shell.addFold(`wide ${long}`, [`body ${long}`]);
		await settle();
		terminal.data("\x0f"); // expand-all
		await settle();
		for (const line of terminal.frameSince(0).split("\n")) {
			expect(line.length).toBeLessThanOrEqual(80); // fits the original width
		}
		const mark = terminal.writes.length; // post-resize frames only
		terminal.resize(40); // SIGWINCH: width drops, the resize hook re-renders
		await settle();
		const narrow = terminal.frameSince(mark);
		let sawBody = false;
		for (const line of narrow.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(40); // re-truncated, no renderer throw
			if (line.includes("body")) sawBody = true;
		}
		expect(sawBody).toBe(true); // the fold body is still there, just clipped
		shell.close();
	});

	it("/tree (#10 batch 2): switch back — the left branch is summarized into the next request", async () => {
		const env = await startTuiRepl([
			reply("answer one"),
			reply("answer two"),
			reply("answer three"), // q3 on the NEW branch
			reply("BRANCHES: the new direction was tried"), // the summary call
			reply("answer four"),
		]);
		await settle();
		env.terminal.data("q1 trunk\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("answer one"), 8000);
		env.terminal.data("q2 old direction\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("answer two"), 8000);
		// fork before q2 and write on the new branch
		env.terminal.data("/fork 2\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("forked before"), 8000);
		env.terminal.data("q3 new direction\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("answer three"), 8000);
		// switch back to the old branch — summarizes the abandoned q3 branch
		env.terminal.data("/tree\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("Switch to which branch?"), 8000);
		env.terminal.data("\r"); // first tip = the old branch
		await waitUntil(() => env.terminal.frameSince(0).includes("summarized in context"), 8000);
		// the screen shows the OLD branch again
		expect(env.terminal.frameSince(0)).toContain("answer two");
		// the summary request covered the abandoned segment only
		const summaryReq = env.requests[3];
		expect(String(summaryReq?.system ?? "")).toContain("summarization");
		const summaryFirst = summaryReq?.messages[0] as UserMessage | undefined;
		expect(summaryFirst?.content ?? "").toContain("q3 new direction");
		expect(summaryFirst?.content ?? "").not.toContain("q1 trunk");
		// the next turn's request carries the framed summary + old branch
		env.terminal.data("q4 continue\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("answer four"), 8000);
		const last = env.requests[4];
		const userTexts = (last?.messages ?? [])
			.filter((m): m is UserMessage => m.role === "user")
			.map((m) => m.content);
		expect(userTexts.some((t) => t.includes("q2 old direction"))).toBe(true);
		expect(userTexts.some((t) => t.startsWith("[Branch summary \u2014") && t.includes("BRANCHES:"))).toBe(
			true,
		);
		expect(userTexts.includes("q3 new direction")).toBe(false); // only via the summary frame
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("/fork (#10): picker flow — the model's next request excludes the abandoned tail", async () => {
		const env = await startTuiRepl([reply("first answer"), reply("second answer"), reply("third answer")]);
		await settle();
		env.terminal.data("q1 hello\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("first answer"), 8000);
		env.terminal.data("q2 world\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("second answer"), 8000);
		env.terminal.data("/fork\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("Fork before which message?"), 8000);
		env.terminal.data("q2"); // filter narrows to the second message
		await settle();
		env.terminal.data("\r"); // fork before "q2 world"
		await waitUntil(() => env.terminal.frameSince(0).includes("forked before"), 8000);
		expect(env.terminal.frameSince(0)).toContain("2 messages kept, 2 left on the old branch");
		// the abandoned tail left the screen — post-fork frames only
		const forkMark = env.terminal.writes.length;
		await settle();
		expect(env.terminal.frameSince(forkMark)).not.toContain("second answer");
		env.terminal.data("q2 again differently\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("third answer"), 8000);
		// the provider sees q1 + the NEW question, never the abandoned q2/answer
		const last = env.requests[env.requests.length - 1];
		expect(last).toBeDefined();
		const userTexts = (last?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content);
		expect(userTexts).toContain("q1 hello");
		expect(userTexts).toContain("q2 again differently");
		expect(userTexts).not.toContain("q2 world");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("debt clearance: error results fold too — no red ⎿ line, the ● ✗ line stays, expand works", async () => {
		const failing: Tool = {
			name: "bash",
			description: "test bash stand-in",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				return {
					output: "Error: command timed out after 5s and was killed. Partial output:\nline one\nline two",
					isError: true,
				};
			},
		};
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 99" } }],
					"tool_use",
				),
				reply("done"),
			],
			{ tools: [failing] },
		);
		await settle();
		env.terminal.data("run it\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("done"), 8000);
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("● bash $ sleep 99 ✗"); // the salient failure line stays
		expect(frame).not.toContain("⎿"); // the red ⎿ preview is gone — folded instead
		expect(frame).toContain("▸ Error: command timed out"); // the error fold's collapsed title
		// expand-all reveals the partial output
		env.terminal.data("\x0f");
		await waitUntil(() => env.terminal.frameSince(0).includes("line one"), 8000);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("debt clearance: /new clears the transcript and folds", async () => {
		const chatty: Tool = {
			name: "bash",
			description: "test bash stand-in",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				return { output: "stdout:\nsome long output line that should vanish\n" };
			},
		};
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "seq 99" } }],
					"tool_use",
				),
				reply("done"),
				reply("fresh turn"),
			],
			{ tools: [chatty] },
		);
		await settle();
		env.terminal.data("run it\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("should vanish"), 8000);
		env.terminal.data("/new\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("new session"), 8000);
		const mark = env.terminal.writes.length;
		env.terminal.data("hello\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("fresh turn"), 8000);
		// the old content and its fold are gone from the CURRENT screen
		expect(env.terminal.frameSince(mark)).not.toContain("should vanish");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("M11 #6 (review P1): a '!'-leading md body queued mid-run flushes as a MODEL turn — never as a shell command", async () => {
		const extras = [
			{
				command: {
					name: "boom",
					summary: "dangerous-looking body",
					allowedDuringRun: true,
					run: (_args: string, ctx: { submitPrompt: (t: string) => void }): "handled" => {
						ctx.submitPrompt("!double-check the flaky test");
						return "handled";
					},
				},
				source: "md:project",
			},
		];
		let releaseTurn: () => void = () => {};
		const gated = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const env = await startTuiRepl(
			[() => gated.then(() => reply("first done")), reply("second turn reply")],
			{
				commands: extras as never,
			},
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("(esc to interrupt"), 8000);
		env.terminal.data("/boom\r"); // queued behind the gated turn
		await waitUntil(() => env.terminal.frameSince(0).includes("1 queued"), 8000);
		releaseTurn();
		await waitUntil(() => env.terminal.frameSince(0).includes("second turn reply"), 8000);
		// the queued body reached the MODEL, and the bang path never fired
		expect(
			env.requests[1]?.messages.some(
				(m) => m.role === "user" && m.content === "!double-check the flaky test",
			),
		).toBe(true);
		const stream = env.transcript.completedLines().join("\n");
		// the user echo (`> !double-check…`) is expected — the BANG echo
		// (`! double-check…`, the runBangCommand note) must never appear
		expect(stream).not.toMatch(/^! double-check/m);
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("M11 #6: a markdown quick command spends a real turn with the rendered prompt", async () => {
		const extras = [
			{
				command: {
					name: "review",
					summary: "Review the current diff",
					allowedDuringRun: false,
					run: (args: string, ctx: { submitPrompt: (t: string) => void }): "handled" => {
						ctx.submitPrompt(renderMdPrompt("Review the diff. $ARGUMENTS", args));
						return "handled";
					},
				},
				source: "md:project",
			},
		];
		const env = await startTuiRepl([reply("reviewed")], { commands: extras as never });
		await settle();
		env.terminal.data("/review the parser\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("reviewed"), 8000);
		expect(
			env.requests[0]?.messages.some(
				(m) => m.role === "user" && m.content.includes("Review the diff. the parser"),
			),
		).toBe(true);
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("M11 #4: a submitted line persists and a NEW shell recalls it with up-arrow", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-hist-e2e-"));
		const file = path.join(dir, "history.jsonl");
		const first = makeShell({ historyPath: file });
		first.shell.start();
		await settle(0);
		first.terminal.data("! echo persisted-history\r");
		await settle(0);
		first.terminal.data("remembered prompt\r");
		await settle();
		first.shell.close();
		// fresh shell, same file: up-arrow must recall the persisted line
		const second = makeShell({ historyPath: file });
		second.shell.start();
		await settle(0);
		const mark = second.terminal.writes.length;
		second.terminal.data("\x1b[A"); // up arrow
		await settle(); // let the debounced repaint land
		expect(second.terminal.frameSince(mark)).toContain("remembered prompt"); // editor shows it
		second.terminal.data("\r"); // submit unchanged — routes to onLine
		await settle();
		expect(second.events.some((e) => e.startsWith("line:remembered prompt"))).toBe(true);
		second.shell.close();
	});

	it("M11 #9: a filterable select narrows as you type; Enter picks the ORIGINAL index", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const pick = shell.select({
			title: "sessions — pick one to resume",
			filterable: true,
			items: [
				{ label: "aaaa1111", description: "9/1 · 4 msgs · fix the login bug" },
				{ label: "bbbb2222", description: "9/2 · 8 msgs · refactor the parser" },
				{ label: "cccc3333", description: "9/3 · 2 msgs · login screen styles" },
			],
		});
		await settle();
		expect(terminal.frameSince(0)).toContain("login bug"); // full list first
		const filteredMark = terminal.writes.length; // the un-filtered rows live in earlier writes
		terminal.data("l"); // query "l"
		terminal.data("o");
		terminal.data("g");
		await settle();
		const filtered = terminal.frameSince(filteredMark);
		expect(filtered).toContain("login bug"); // both login rows match
		expect(filtered).not.toContain("parser"); // the non-match is gone
		expect(filtered).toContain("filter: log");
		terminal.data("\x7f"); // backspace: query "lo" — still filtered
		terminal.data("\x7f"); // backspace: query "l"
		await settle();
		terminal.data("\x7f"); // backspace: query "" — full list restored
		await settle();
		const mark = terminal.writes.length;
		terminal.data("z"); // no match
		terminal.data("z");
		await settle();
		expect(terminal.frameSince(mark)).toContain("No matching"); // the empty state
		terminal.data("\x1b"); // Esc cancels the picker entirely
		await expect(pick).resolves.toBe(null);
		shell.close();
	});

	it("M11 (review edge): an extension tool named 'edit' without the summary contract still folds generically", async () => {
		const fakeEdit: Tool = {
			name: "edit",
			description: "not the built-in edit",
			parameters: Type.Object({}),
			async execute() {
				return { output: "plain output without the colon contract" };
			},
		};
		const env = await startTuiRepl(
			[assistant([{ type: "toolCall", id: "t1", name: "edit", arguments: {} }], "tool_use"), reply("done")],
			{ tools: [fakeEdit] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("done"), 8000);
		expect(env.terminal.frameSince(0)).toContain("▸ plain output without the colon contract"); // preview not lost
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("M11: a queued line shows the queue row only — no ▪ queued note (dogfood #3); the hint row carries the interrupt affordance while active (dogfood #8)", async () => {
		const g = gate();
		const env = await startTuiRepl([() => g.promise.then(() => reply("ok"))]);
		await settle();
		env.terminal.data("first\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("(esc to interrupt"), 8000);
		const activeMark = env.terminal.writes.length;
		env.terminal.data("second line\r");
		await waitUntil(() => env.terminal.frameSince(activeMark).includes("1 queued · next: second line"), 8000);
		const stream = env.transcript.completedLines().join("\n");
		expect(stream).not.toContain("▪ queued:"); // TUI: the row replaces the note
		// idle hint swapped out (frameSince(0) still holds the startup text)
		expect(env.terminal.frameSince(activeMark)).not.toContain("(/ for commands");
		g.resolve();
		await waitUntil(() => env.terminal.frameSince(0).includes("> second line"), 8000); // flushed: echoed
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("an aborted turn clears the activity rows — the interrupt path (P2#4)", async () => {
		const g = gate();
		const env = await startTuiRepl([], {
			provider: {
				name: "abort-hold",
				async *stream(request) {
					const aborted = () => request.signal?.aborted ?? false;
					yield { type: "text_delta", text: "partial" };
					// Mid-stream hold — a real provider's fetch REJECTS on abort, so the
					// hold must lose the race the same way (otherwise the loop blocks).
					await new Promise<void>((resolve) => {
						const onAbort = () => resolve();
						request.signal?.addEventListener("abort", onAbort, { once: true });
						g.promise.then(() => {
							request.signal?.removeEventListener("abort", onAbort);
							resolve();
						});
					});
					if (aborted()) return;
					yield { type: "message_end", message: reply("never") };
				},
			},
		});
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("thinking"));
		env.terminal.data("\x03");
		// zero-turn aborts skip run stats — the interrupt note plus the restored
		// placeholder (idle marker repaint) are the settle signal
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("(interrupt"), 5000);
		await waitUntil(() => env.terminal.frameSince(0).includes("(/ for commands"), 5000);
		const mark = env.terminal.writes.length;
		env.terminal.data("x"); // editor change → repaint; the row is gone if cleared
		await settle(30);
		expect(env.terminal.frameSince(mark)).not.toContain("thinking");
		env.terminal.data("\x15"); // clear the draft (ctrl+u) before exiting cleanly
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});
});

describe("TuiShell activity region (M10 B)", () => {
	it("thinking paints a spinner row that ticks, then clears on idle", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setActivity({ phase: "thinking", tools: [], agents: [] });
		await settle(30); // first paint (16ms render interval), before any 120ms tick
		const first = terminal.frameSince(0);
		expect(first).toContain("thinking");
		await settle(300); // ≥2 ticker frames
		const ticked = terminal.frameSince(0);
		expect(ticked).toContain("thinking");
		expect(ticked).not.toBe(first); // the spinner frame advanced
		const mark = terminal.writes.length;
		shell.setActivity({ phase: "idle", tools: [], agents: [] });
		await settle(30);
		expect(terminal.frameSince(mark)).not.toContain("thinking");
	});

	it("working rows render pending tools and subagent tree lines", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setActivity({
			phase: "working",
			tools: [{ id: "t1", name: "bash", label: "echo hi", startedAtMs: Date.now() }],
			agents: [
				{
					agent: "scout",
					task: "explore the tree",
					taskToolId: "t9",
					cwd: null,
					lastTool: "bash echo deep",
					toolCount: 3,
					startedAtMs: Date.now(),
				},
			],
		});
		await settle(30);
		const frame = terminal.frameSince(0);
		expect(frame).toContain("bash echo hi");
		expect(frame).toContain("└─ scout · explore the tree · 3 tools · last: bash echo deep");
		shell.close();
	});
});

describe("M10 review regressions (wave 1 + B)", () => {
	it("layout order: transcript < folds < activity < ask, and queue < hint < editor box (P2#6)", async () => {
		const { terminal, transcript, shell } = makeShell();
		shell.start();
		await settle(0);
		transcript.feed("ORDER-TRANSCRIPT\n");
		shell.addFold("ORDER-FOLD", ["+ a", "- b"]);
		shell.setActivity({
			phase: "working",
			tools: [{ id: "t1", name: "bash", label: "ORDER-TOOL", startedAtMs: Date.now() }],
			agents: [],
		});
		const asked = shell.ask("ORDER-ASK");
		let mark = terminal.writes.length;
		shell.forceRender();
		await settle(30);
		const frameA = terminal.frameSince(mark);
		const t = frameA.indexOf("ORDER-TRANSCRIPT");
		const f = frameA.indexOf("ORDER-FOLD");
		const a = frameA.indexOf("ORDER-TOOL");
		const k = frameA.indexOf("ORDER-ASK");
		expect([t, f, a, k].every((i) => i >= 0)).toBe(true);
		expect(t).toBeLessThan(f);
		expect(f).toBeLessThan(a);
		expect(a).toBeLessThan(k);
		// settle the ask, then queue + hint + marker in one full repaint
		terminal.data("y\r");
		await expect(asked).resolves.toBe(true);
		shell.setQueue(1, "ORDER-QUEUE");
		await settle(30);
		mark = terminal.writes.length;
		shell.forceRender();
		await settle(30);
		const frameB = terminal.frameSince(mark);
		const q = frameB.indexOf("ORDER-QUEUE");
		const h = frameB.indexOf("(/ for commands");
		const e = frameB.indexOf("─────"); // the editor box's top border
		expect([q, h, e].every((i) => i >= 0)).toBe(true);
		expect(q).toBeLessThan(h);
		expect(h).toBeLessThan(e);
		shell.close();
	});
});
