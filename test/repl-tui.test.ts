import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { renderMdPrompt } from "../src/core/commands-md.js";
import type { AgentMessage, AssistantMessage, UserMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { buildSkillCommands, expandSkillBlock, loadSkills } from "../src/core/skills.js";
import { detectBinary } from "../src/core/tools/bin-detect.js";
import type { Tool } from "../src/core/tools/types.js";
import type { RegisteredExtensionCommand } from "../src/extensions/types.js";
import { loadApiKey } from "../src/provider/auth-store.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { Fold } from "../src/repl/components/fold.js";
import { runRepl, TtyConfirm } from "../src/repl/repl.js";
import { replaySession } from "../src/repl/replay.js";
import { type AutocompleteOptions, TuiShell } from "../src/repl/shell.js";
import * as toolPresentation from "../src/repl/tool-presentation.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner } from "../src/runner.js";
import { type AutocompleteSlashCommand, StdinBuffer, type Terminal, visibleWidth } from "../src/tui.js";
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

/** Poll the rendered frames until text appears — the timing-proof wait
 *  (M15 CI flake: settle()'s fixed 30ms loses to a slow runner's full
 *  provider→tool→render turn; poll instead of hoping). */
async function frameContains(
	env: { terminal: { frameSince: (n: number) => string } },
	text: string,
	timeoutMs = 2000,
): Promise<void> {
	const start = Date.now();
	while (!env.terminal.frameSince(0).includes(text)) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`frame did not contain ${JSON.stringify(text)} within ${timeoutMs}ms`);
		}
		await settle(15);
	}
}

function makeShell(options?: {
	onLine?: (l: string, mode?: "steer" | "followUp") => void;
	onDequeue?: () => void;
	autocomplete?: AutocompleteOptions;
	historyPath?: string;
	pasteImage?: () => Promise<import("../src/repl/clipboard-image.js").ClipboardImage | null>;
	pasteText?: () => Promise<string | null>;
}) {
	const terminal = new FakeTerminal();
	const transcript = new TranscriptSink();
	const events: string[] = [];
	const shell = new TuiShell({
		transcript,
		terminal,
		autocomplete: options?.autocomplete,
		historyPath: options?.historyPath,
		pasteImage: options?.pasteImage,
		pasteText: options?.pasteText,
		onLine: (line, mode) => {
			events.push(`line:${mode ?? "steer"}:${line}`);
			options?.onLine?.(line, mode);
		},
		onInterrupt: () => events.push("interrupt"),
		onEof: () => events.push("eof"),
		onDequeue: () => {
			events.push("dequeue");
			options?.onDequeue?.();
		},
		onCycleThinking: () => events.push("cycle-thinking"),
		onToggleThinking: () => events.push("toggle-thinking"),
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
		expect(events).toEqual(["line:steer:hello"]);
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
		expect(events).toEqual(["line:steer:one", "line:steer:two", "line:steer:two"]);
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

	it("secret: Enter returns the text; empty and Esc cancel; the key never enters history (#login-repl)", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const ask = shell.secret("Enter Z.AI API key ");
		await settle();
		expect(terminal.frameSince(0)).toContain("Enter Z.AI API key ");
		terminal.data("sk-live\r");
		await settle();
		await expect(ask).resolves.toBe("sk-live");
		// the typed key never becomes recallable input
		expect(shell.getHistory()).toEqual([]);
		// empty Enter = cancel (null), not an empty-string key
		const empty = shell.secret("Enter again ");
		await settle();
		terminal.data("\r");
		await settle();
		await expect(empty).resolves.toBeNull();
		// Esc cancels too — even idle (the /login flow's cancel affordance)
		const esc = shell.secret("Enter once more ");
		await settle();
		terminal.data("\x1b");
		await settle();
		await expect(esc).resolves.toBeNull();
		// and the machine never saw a single line from any of it
		expect(events).toEqual([]);
		shell.close();
	});

	it("Alt+O leaves selector, ask and bracketed paste input ownership unchanged", async () => {
		const { terminal, transcript, shell } = makeShell();
		transcript.toolSink.setResolver(() => ({
			call: () => ({
				summary: "query",
				argumentFields: [{ label: "Query", value: "readable", consumes: ["query"] }],
			}),
		}));
		transcript.toolSink.start("id", "custom", { query: "original" });
		transcript.toolSink.end({ toolCallId: "id", toolName: "custom", content: "done", isError: false });
		const fold = transcript.toolFolds[0]!;
		fold.setExpanded(true);
		shell.start();
		await settle(0);
		const question = shell.ask("proceed?");
		terminal.data("\x1bo");
		await settle();
		expect(fold.render(200).join(" ")).toContain("Query: readable");
		terminal.data("\x03");
		await expect(question).resolves.toBe(false);
		const selected = shell.select({ items: [{ label: "choice" }] });
		terminal.data("\x1bo");
		await settle();
		expect(fold.render(200).join(" ")).toContain("Query: readable");
		terminal.data("\x1b");
		await expect(selected).resolves.toBeNull();
		terminal.data("\x1b[200~\x1bo\x1b[201~");
		await settle();
		expect(fold.render(200).join(" ")).toContain("Query: readable");
		terminal.data("\x1bo");
		await settle();
		expect(fold.render(200).join(" ")).toContain("Raw arguments");
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
		expect(events).toEqual(["line:steer:hello"]); // the editor owns keys again
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
	it("paints dim per-entry rows under a 'N queued' head, plus the dequeue hint", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setQueue([{ label: "steer", preview: "queued A" }]);
		await settle();
		const raw = terminal.writes.join("");
		expect(raw).toContain("\x1b[2m1 queued"); // dim is really emitted
		expect(raw).toContain("  steer: queued A");
		expect(raw).toContain("  ↳ alt+up / esc+p to edit all queued");
		// placement: one full repaint, then read layout order out of that window
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		const frame = terminal.frameSince(mark);
		expect(frame).toContain("1 queued");
		expect(frame.indexOf("1 queued")).toBeLessThan(frame.indexOf("(/ for commands")); // above the hint
		// an update repaints in place — labels distinguish routing modes
		shell.setQueue([
			{ label: "steer", preview: "queued A" },
			{ label: "follow-up", preview: "queued B" },
		]);
		await settle();
		const after = terminal.frameSince(0);
		expect(after).toContain("2 queued");
		expect(after).toContain("  steer: queued A");
		expect(after).toContain("  follow-up: queued B");
		shell.close();
	});

	it("an empty entries list collapses the region to zero lines", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setQueue([{ label: "steer", preview: "queued A" }]);
		await settle();
		expect(terminal.frameSince(0)).toContain("  steer: queued A");
		shell.setQueue([]);
		await settle();
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).not.toContain("steer:");
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
		expect(events).toEqual(["line:steer:/model"]); // completed, then submitted — one press
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
		expect(events).toEqual(["line:steer:/mo"]); // no panel, no completion
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
		expect(events).toEqual(["line:steer:/mo"]); // the raw text survived
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
		expect(events).toEqual(["line:steer:@alpha.txt"]); // input aid: path text, nothing read
		shell.close();
	});
});

describe("TuiShell placeholder hint (M10)", () => {
	const hint = "(/ for commands · @ files · ! bash · shift+enter newline · alt+enter follow-up)";

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
		expect(events).toEqual(["line:steer:line1\nline2"]);
		shell.close();
	});

	it("kitty shift+enter (CSI-u) inserts the newline the same way", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("aa\x1b[13;2ubb\r");
		await settle(0);
		expect(events).toEqual(["line:steer:aa\nbb"]);
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
			model?: string; // default test-model is knob-less; Claude opts into thinking
			seed?: AgentMessage[]; // pre-written session history (replayed at startup)
			noSession?: boolean;
			markdown?: boolean;
		},
	) {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-tui-"));
		if (options?.seed !== undefined && options.seed.length > 0) {
			const store = createSession(baseDir, baseDir); // runner cwd is baseDir — same bucket
			for (const message of options.seed) store.appendMessage(message);
		}
		const requests: LLMRequest[] = [];
		const provider: LLMProvider = options?.provider ?? scriptedProvider(scripts, requests);
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink();
		const renderer = new Renderer({
			write: transcript.feed,
			thinkingSink: transcript.thinkingSink,
			userSink: (text) => transcript.feedUser(text),
			statusSink: (text) => transcript.feedStatus(text),
			ansi: false,
			liveTools: false, // no spinner timers; the byte path is what matters
			toolStyle: "one-line",
			markdown: options?.markdown ?? false,
			foldedResults: true, // mirrors cli.ts's TUI wiring (M11 #1)
		});
		const runner = await createRunner({
			cwd: baseDir,
			argv: [],
			model: options?.model ?? "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: options?.noSession ?? false,
			continueRecent: options?.seed !== undefined && options.seed.length > 0 ? true : undefined,
			sessionBaseDir: baseDir,
			settingsPath: path.join(baseDir, "settings.json"),
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
		expect(env.terminal.frameSince(0)).toContain("Tips for getting started:"); // welcome painted
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
		expect(env.terminal.frameSince(0)).toContain("hi"); // the user block survives; idle again after
		// Footer: model + session id8 at startup, cumulative tokens after the run
		expect(env.terminal.frameSince(0)).toMatch(/test-model · [0-9a-f]{8}/);
		expect(env.terminal.frameSince(0)).toContain("↑10 ↓5");
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("a submitted prompt echoes into the transcript; NO stats lines in the TUI — the footer is the sole status surface (pi parity)", async () => {
		const env = await startTuiRepl([reply("the answer")]);
		await settle();
		env.terminal.data("hello there\r");
		await settle();
		const lines = env.transcript.completedLines();
		expect(lines).toContain("hello there"); // the user block's text (no "> " prefix — pi parity)
		expect(lines).toContain("the answer");
		// pi parity (2026-09-10): neither the per-run `— model · turns ·
		// tokens` line NOR the session cumulative line prints in the TUI
		// transcript — usage lives in the footer only (print keeps both).
		expect(lines.some((l) => l.startsWith("— test-model ·"))).toBe(false);
		expect(lines.filter((l) => l.includes("msgs total")).length).toBe(0);
		expect(env.terminal.frameSince(0)).toContain("test-model"); // footer carries the model/usage
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
		// #model-discovery hermeticity: pin "no family configured" so the list
		// is the classic seed set, independent of the host's login/keys.
		const saved: Record<string, string | undefined> = {};
		for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "IMP_AUTH_PATH"]) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.IMP_AUTH_PATH = "/nonexistent-imp-auth.json";
		try {
			const env = await startTuiRepl([reply("ok")]);
			await settle();
			env.terminal.data("/model\r");
			await settle();
			const frame = env.terminal.frameSince(0);
			expect(frame).toContain("models — switch applies from the next turn"); // title
			expect(frame).toContain("→ test-model"); // current id first, preselected
			expect(frame).toContain("claude-sonnet-4-5");
			expect(frame).toContain("zai/glm-5.3"); // GLM candidates are zai-canonical
			expect(frame).toContain("current"); // the current row is marked
			env.terminal.data("\x1b[B"); // Down → claude-sonnet-4-5 (row 1)
			await settle();
			env.terminal.data("\r"); // pick
			await settle();
			expect(env.runner.model).toBe("claude-sonnet-4-5");
			expect(env.transcript.completedLines().join("\n")).toContain(
				"Model: claude-sonnet-4-5", // pi showStatus form (anthropic family stays unprefixed)
			);
			// Mutation pin: the footer refreshes after a COMMAND (no turn ran) —
			// runCommand's finally push is what makes this green.
			expect(env.terminal.frameSince(0)).toContain("claude-sonnet-4-5 · ");
			env.terminal.data("/exit\r");
			const code = await env.repl;
			expect(code).toBe(0);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("/model selector: Esc cancels — no switch, no note, editor keeps keys", async () => {
		// #model-discovery hermeticity (same pin as the Down+Enter test)
		const saved: Record<string, string | undefined> = {};
		for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "IMP_AUTH_PATH"]) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.IMP_AUTH_PATH = "/nonexistent-imp-auth.json";
		try {
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
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("EOF on a pristine session exits gracefully without a file or saved hint", async () => {
		const env = await startTuiRepl([reply("ok")]);
		await settle();
		env.terminal.data("\x04");
		const code = await env.repl;
		expect(code).toBe(0);
		await settle(80); // deferred stop paints the final note
		expect(env.runner.session?.isPersisted).toBe(false);
		expect(existsSync(env.runner.session?.filePath as string)).toBe(false);
		expect(env.terminal.frameSince(0)).toContain("▪ bye");
		expect(env.terminal.frameSince(0)).not.toContain("saved — resume with");
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
		await frameContains(env, "⎿ Edited");
		env.terminal.data("\x0f"); // Ctrl+O — expand the newest fold
		await frameContains(env, "+ goodbye");
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it("Alt+O toggles structured calls without expanding and respects key releases", async () => {
		const env = await startTuiRepl([reply("ok")]);
		const hook = vi.fn(() => ({
			summary: "query",
			argumentFields: [{ label: "Query", value: "readable", consumes: ["query"] }],
		}));
		env.transcript.toolSink.setResolver(() => ({ call: hook }));
		env.transcript.toolSink.start("raw", "custom", { query: " original " });
		env.transcript.toolSink.end({ toolCallId: "raw", toolName: "custom", content: "done", isError: false });
		const fold = env.transcript.toolFolds[0]!;
		env.terminal.data("\x1bo");
		await settle();
		expect(fold.isExpanded()).toBe(false);
		env.terminal.data("\x0f");
		await frameContains(env, "Raw arguments");
		expect(fold.isExpanded()).toBe(true);
		env.terminal.data("\x1b[111;3:3u"); // Kitty Alt+O release
		await settle();
		expect(fold.render(200).join(" ")).toContain("Raw arguments");
		env.terminal.data("\x1b[111;3u"); // Kitty Alt+O press
		await settle();
		expect(fold.render(200).join(" ")).toContain("Query: readable");
		expect(fold.isExpanded()).toBe(true);
		expect(hook).toHaveBeenCalledTimes(1);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("semantic tools: reverse execution completion retains call order live and on replay", async () => {
		const first = gate();
		const second = gate();
		const started: string[] = [];
		const finished: string[] = [];
		const tool: Tool = {
			name: "parallel_test",
			description: "gated fake tool",
			concurrencySafe: true,
			parameters: Type.Object({ id: Type.String() }),
			async execute(args) {
				const id = String(args.id);
				started.push(id);
				await (id === "a" ? first.promise : second.promise);
				finished.push(id);
				return { output: `${id} result` };
			},
		};
		const env = await startTuiRepl(
			[
				assistant(
					["a", "b"].map((id) => ({
						type: "toolCall" as const,
						id,
						name: "parallel_test",
						arguments: { id },
					})),
					"tool_use",
				),
				reply("parallel done"),
			],
			{ tools: [tool] },
		);
		env.terminal.data("run parallel\r");
		await waitUntil(() => started.length === 2);
		second.resolve();
		await waitUntil(() => finished.length === 1);
		expect(finished).toEqual(["b"]);
		expect(env.transcript.toolFolds).toHaveLength(0);
		first.resolve();
		await frameContains(env, "parallel done");
		expect(env.transcript.toolFolds.map((f) => f.block.id)).toEqual(["a", "a", "b", "b"]);
		env.terminal.data("\x0f");
		await waitUntil(() => env.transcript.toolFolds.every((f) => f.isExpanded()));
		env.transcript.toolSink.start("c", "read", { path: "new" });
		env.transcript.toolSink.end({ toolCallId: "c", toolName: "read", content: "new", isError: false });
		expect(env.transcript.toolFolds.at(-1)?.isExpanded()).toBe(false);
		env.terminal.data("\x0f");
		await waitUntil(() => env.transcript.toolFolds.every((f) => f.isExpanded()));
		env.terminal.data("\x0f");
		await waitUntil(() => env.transcript.toolFolds.every((f) => !f.isExpanded()));
		const session = env.runner.session;
		if (!session) throw new Error("missing test session");
		env.transcript.clear();
		replaySession(
			{ write: env.transcript.feed, ansi: true, markdown: true, toolSink: env.transcript.toolSink },
			session,
		);
		expect(env.transcript.toolFolds.map((f) => f.block.id)).toEqual(["a", "a", "b", "b"]);
		env.terminal.data("\x0f");
		await waitUntil(() => env.transcript.toolFolds.every((f) => f.isExpanded()));
		env.terminal.data("/new\r");
		await frameContains(env, "new session");
		expect(env.transcript.toolFolds).toHaveLength(0);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
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
		expect(runFrame).toContain("hi"); // the echoed user block rides the same frame
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

	it("queue visual: steer rows drain batched (all mode default), region clears, run continues", async () => {
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
		expect(env.terminal.frameSince(0)).toContain("  steer: queued A");
		env.terminal.data("queued B\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("2 queued"); // both rows visible now
		expect(env.terminal.frameSince(0)).toContain("  steer: queued B");
		const mark = env.terminal.writes.length;
		g.resolve();
		// M17 default steeringMode "all": ONE poll drains both entries → the
		// second request carries both as consecutive user messages and the
		// queue region clears at the same boundary (pi's one-at-a-time default
		// would spend a turn per entry — the deliberate divergence, design §2).
		await waitUntil(() => env.requests.length >= 2); // request 2 held open
		const request2 = env.requests[1]?.messages ?? [];
		expect(request2.some((m) => m.role === "user" && m.content === "queued A")).toBe(true);
		expect(request2.some((m) => m.role === "user" && m.content === "queued B")).toBe(true);
		const expectedUsers = new TranscriptSink();
		for (const text of ["go", "queued A", "queued B"]) expectedUsers.feedUser(text);
		expect(env.transcript.render(80).filter((row) => row.includes("\x1b[48;5;237m"))).toEqual(
			expectedUsers.render(80),
		);
		expect(env.transcript.completedLines().join("\n")).not.toContain("▪ steering:");
		// wait for a REAL post-drain repaint first (the tool's ✓ row) so the
		// region-clear check below cannot pass on an empty window vacuously
		await waitUntil(() => env.terminal.frameSince(mark).includes("⎿ done"));
		expect(env.terminal.frameSince(mark)).not.toContain("steer:"); // region cleared
		g2.resolve(); // both answers land; boundary polls find nothing → run completes
		await settle();
		env.terminal.data("/exit\r");
		const code = await env.repl;
		expect(code).toBe(0);
	});

	it.each(["all", "one-at-a-time"])(
		"consumed steer uses a full user block at the final-response boundary (%s mode)",
		async (steeringMode) => {
			const g = gate();
			const g2 = gate();
			const env = await startTuiRepl([
				() => g.promise.then(() => reply("initial answer")),
				() => g2.promise.then(() => reply("steer acknowledged")),
			]);
			await writeFile(path.join(env.baseDir, "settings.json"), JSON.stringify({ steeringMode }));
			const text = `${"Keep the full steering message visible. ".repeat(4)}\nSecond line must remain visible.`;
			try {
				env.terminal.data("go\r");
				await waitUntil(() => env.requests.length === 1);
				env.terminal.data(`\x1b[200~${text}\x1b[201~`);
				env.terminal.data("\r");
				await frameContains(env, "1 queued");
				expect(env.transcript.completedLines().join("\n")).not.toContain(text);
				g.resolve();
				await waitUntil(() => env.requests.length === 2);
				expect(env.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: text });
				const expectedUsers = new TranscriptSink();
				expectedUsers.feedUser("go");
				expectedUsers.feedUser(text);
				for (const width of [40, 120]) {
					expect(env.transcript.render(width).filter((row) => row.includes("\x1b[48;5;237m"))).toEqual(
						expectedUsers.render(width),
					);
				}
				const transcript = env.transcript.completedLines().join("\n");
				expect(transcript).toContain(text);
				expect(transcript).not.toContain("▪ steering:");
			} finally {
				g.resolve();
				g2.resolve();
				await waitUntil(() => env.transcript.completedLines().join("\n").includes("steer acknowledged"));
				env.terminal.data("/exit\r");
				await env.repl;
			}
		},
	);

	it("queue visual: an abort restores the queue to the editor and clears the region", async () => {
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
		expect(env.terminal.frameSince(0)).toContain("2 queued");
		const mark = env.terminal.writes.length;
		env.terminal.data("\x03"); // abort — the user takes control
		g.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("restored 2 queued"));
		await settle();
		// the queue region cleared AND the editor now holds both texts (pi:
		// user input is never lost) — one differential window covers both
		const frame = env.terminal.frameSince(mark);
		expect(frame).not.toContain("steer:");
		expect(frame).toContain("queued A");
		expect(frame).toContain("queued B");
		// the restored text owns the editor now — clear it before /exit
		// (18 chars: "queued A\n\nqueued B")
		env.terminal.data("\x7f".repeat(18));
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

	it("isolates identical child labels and ids, releases parent state and ignores late events", async () => {
		const call = vi.fn((ctx) => ({ summary: `child-${(ctx.args as { value: string }).value}` }));
		const resultHook = vi.fn((ctx) => ({ summary: String((ctx.args as { value: string }).value) }));
		const child: Tool = {
			name: "child_tool",
			description: "test",
			parameters: Type.Object({}),
			execute: async () => ({ output: "unused" }),
			presentation: { call, result: resultHook },
		};
		const env = await startTuiRepl([reply("finished")], { tools: [child] });
		const original = env.runner.runTurn.bind(env.runner);
		let late: (() => void) | undefined;
		vi.spyOn(env.runner, "runTurn").mockImplementation(async (options) => {
			const emit = options.onEvent!;
			for (const id of ["parent-a", "parent-b"])
				emit({ type: "tool_start", toolCallId: id, name: "task", args: { agent: "same", prompt: id } });
			const a = { sourceId: "source-a", taskToolCallId: "parent-a", agent: "same", cwd: "/same" };
			const b = { ...a, sourceId: "source-b", taskToolCallId: "parent-b" };
			const start = (value: string) => ({
				type: "tool_start" as const,
				toolCallId: "identical",
				name: "child_tool",
				args: { value },
			});
			emit(start("a"), a);
			emit(start("b"), b);
			await settle();
			expect(env.terminal.frameSince(0)).toContain("child-a");
			expect(env.terminal.frameSince(0)).toContain("child-b");
			const end = {
				type: "tool_end" as const,
				result: { toolCallId: "identical", toolName: "child_tool", content: "raw child", isError: false },
			};
			emit(end, b);
			emit(end, a);
			expect(resultHook.mock.calls.map(([ctx]) => (ctx.args as { value: string }).value)).toEqual(["b", "a"]);
			emit({
				type: "tool_end",
				result: { toolCallId: "parent-a", toolName: "task", content: "done", isError: false },
			});
			emit(start("stale-parent"), a);
			expect(call).toHaveBeenCalledTimes(2);
			emit({
				type: "tool_end",
				result: { toolCallId: "parent-b", toolName: "task", content: "done", isError: false },
			});
			late = () => emit(start("late-run"), b);
			return original(options);
		});
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.transcript.completedLines().join().includes("finished"));
		await settle();
		late?.();
		expect(call).toHaveBeenCalledTimes(2);
		expect(env.transcript.toolFolds.every((f) => f.block.name === "task")).toBe(true);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});
	it("resolves hooks before initial saved-history replay", async () => {
		const call = vi.fn(() => ({ summary: "historical call" }));
		const result = vi.fn(() => ({ summary: "historical result" }));
		const tool = gatedTool(gate());
		tool.presentation = { call, result };
		const env = await startTuiRepl([], {
			tools: [tool],
			seed: [
				assistant(
					[{ type: "toolCall", id: "old", name: "gated", arguments: { message: "saved" } }],
					"tool_use",
				),
				{
					role: "toolResult",
					results: [{ toolCallId: "old", toolName: "gated", content: "saved raw", isError: false }],
				},
			],
		});
		await waitUntil(() => env.transcript.toolFolds.length === 2);
		expect(call).toHaveBeenCalledTimes(1);
		expect(result).toHaveBeenCalledTimes(1);
		expect(env.transcript.toolFolds[1]?.block.semantic?.summary).toBe("historical result");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});
	it("shares hook invocation between activity and transcript, never ticks or resize", async () => {
		const g = gate();
		const tool = gatedTool(g);
		const call = vi.fn(() => ({ summary: "semantic activity" }));
		const result = vi.fn(() => ({ summary: "semantic result" }));
		tool.presentation = { call, result };
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "gated", arguments: { message: "original" } }],
					"tool_use",
				),
				reply("finished"),
			],
			{ tools: [tool] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("semantic activity"));
		env.terminal.resize(60);
		await settle();
		expect(call).toHaveBeenCalledTimes(1);
		g.resolve();
		await waitUntil(() => env.transcript.toolFolds.length === 2);
		env.terminal.data("\x0f");
		env.terminal.resize(80);
		await settle();
		expect(call).toHaveBeenCalledTimes(1);
		expect(result).toHaveBeenCalledTimes(1);
		expect(env.transcript.toolFolds[1]?.block.sections?.[0]?.lines).toEqual(["gated: original"]);
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
		await waitUntil(() =>
			env.transcript.toolFolds.some((f) => f.block.name === "gated" && f.block.kind === "output"),
		);
		await settle();
		// the pending row is gone — spinner+name only ever appeared in the
		// activity region (the completion line uses ●, not a spinner frame)
		expect(env.terminal.frameSince(mark)).not.toMatch(
			/[\u280b\u2819\u28b9\u28b8\u287c\u2834\u2826\u2867\u2807\u283f] gated/,
		);
		const stream = env.transcript.completedLines().join("\n");
		expect(env.transcript.toolFolds.map((f) => f.block.kind)).toEqual(["input", "output"]);
		expect(stream).not.toContain("⎿"); // M11: folded — the preview moved to the fold title
		expect(env.terminal.frameSince(0)).toContain("⎿"); // the fold itself
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("pi parity: the result fold renders INLINE — directly under its ● completion line, above the text that follows", async () => {
		const g = gate();
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "gated", arguments: { message: "slow" } }],
					"tool_use",
				),
				reply("after-the-tool answer text"),
			],
			{ tools: [gatedTool(g)] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("gated"), 8000); // live row up
		g.resolve(); // let the tool finish
		await waitUntil(() => env.terminal.frameSince(0).includes("⎿ gated: slow"), 8000);
		await waitUntil(() => env.terminal.frameSince(0).includes("after-the-tool"), 8000);
		await settle();
		const frame = env.terminal.frameSince(0);
		const iTool = frame.indexOf("● gated"); // the completion line (● marks it; live rows are gone)
		const iFold = frame.indexOf("⎿ gated: slow"); // the result fold (collapsed title)
		const iText = frame.indexOf("after-the-tool");
		expect(iTool).toBeGreaterThanOrEqual(0);
		expect(iFold).toBeGreaterThan(iTool); // fold UNDER its tool line…
		expect(iText).toBeGreaterThan(iFold); // …and the following text UNDER the fold
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
		await waitUntil(() => env.terminal.frameSince(0).includes("scout · explore the tree"), 8000);
		expect(env.terminal.frameSince(0)).toContain("scout · explore the tree"); // agent + task label
		const mark = env.terminal.writes.length;
		childHold.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("all done"), 8000);
		await settle();
		expect(env.terminal.frameSince(mark)).not.toContain("└─ running"); // row left with the task call
		// M11: the task result folds — the report is the fold body/title now
		expect(env.terminal.frameSince(0)).toContain("⎿");
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
		expect(env.terminal.frameSince(0)).toContain("⎿");
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
		expect(env.terminal.frameSince(0)).toContain("⎿ stdout:");
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

	it("/tree opens and cancels the picker without a busy row or provider call, while input stays guarded", async () => {
		const env = await startTuiRepl([], {
			seed: [{ role: "user", content: "tree question" }, reply("tree answer")],
		});
		const active = vi.spyOn(TuiShell.prototype, "setActive");
		try {
			await settle();
			const mark = env.terminal.writes.length;
			env.terminal.data("/tree\r");
			await frameContains(env, "Navigate the session tree");
			expect(active).toHaveBeenLastCalledWith(true);
			expect(env.terminal.frameSince(mark)).not.toContain("compacting");
			expect(env.terminal.frameSince(mark)).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
			expect(env.requests).toHaveLength(0);
			env.terminal.data("\x1b");
			await waitUntil(() => active.mock.calls.at(-1)?.[0] === false);
			await settle();
			expect(env.terminal.frameSince(mark)).not.toContain("compacting");
			expect(env.requests).toHaveLength(0);
		} finally {
			active.mockRestore();
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		}
	});

	it.each([false, true])("/tree picker navigation labels work and clears on abort=%s", async (abort) => {
		const env = await startTuiRepl([], {
			seed: [
				{ role: "user", content: "first tree question" },
				reply("first tree answer"),
				{ role: "user", content: "second tree question" },
				reply("second tree answer"),
			],
		});
		const held = gate();
		const navigate = env.runner.navigateTree.bind(env.runner);
		const spy = vi.spyOn(env.runner, "navigateTree").mockImplementation(async (id, options) => {
			options?.signal?.addEventListener("abort", () => held.resolve(), { once: true });
			await held.promise;
			return abort ? { aborted: true } : navigate(id, options);
		});
		const spinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] switching branches…/;
		try {
			await settle();
			env.terminal.data("/tree\r");
			await frameContains(env, "Navigate the session tree");
			env.terminal.data("\x1b[A\r");
			await frameContains(env, "Summarize the branch");
			expect(env.terminal.frameSince(0)).not.toContain("compacting context");
			env.terminal.data("\r"); // default choice: No summary
			await waitUntil(() => spy.mock.calls.length === 1);
			expect(spy.mock.calls[0]?.[1]?.summarize).toBe(false);
			await waitUntil(() => spinner.test(env.terminal.frameSince(0)));
			expect(env.requests).toHaveLength(0);
			const mark = env.terminal.writes.length;
			if (abort) env.terminal.data("\x03");
			else held.resolve();
			await waitUntil(() => spy.mock.settledResults[0]?.type === "fulfilled");
			await settle();
			if (abort) {
				expect(env.terminal.frameSince(mark)).toContain("Navigate the session tree");
				expect(spy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			}
			expect(env.terminal.frameSince(mark)).not.toMatch(spinner);
			expect(env.terminal.frameSince(mark)).not.toContain("compacting context");
			expect(env.requests).toHaveLength(0);
		} finally {
			held.resolve();
			spy.mockRestore();
			env.terminal.data("\x1b");
			await settle();
			// Navigating to a user entry restores its prompt in the editor.
			env.terminal.data("\x15/exit\r");
			await expect(env.repl).resolves.toBe(0);
		}
	});

	it("/tree (review P1-1): the summarizer window holds state — typed lines QUEUE, /new is refused", async () => {
		let releaseSummary: () => void = () => {};
		const gated = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		const env = await startTuiRepl([
			reply("answer one"),
			reply("answer two"),
			reply("answer three"), // q3 on the new branch
			() => gated.then(() => reply("THE LEFT BRANCH SUMMARY")), // the gated summarizer
			reply("flushed turn reply"),
		]);
		await settle();
		env.terminal.data("q1 trunk\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("answer one"), 8000);
		env.terminal.data("q2 old\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("answer two"), 8000);
		env.terminal.data("/fork 2\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("forked before"), 8000);
		env.terminal.data("q3 new\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("answer three"), 8000);
		// switch — the summarizer hangs on the gate (#tree: rows are ACTIVE-FIRST
		// tree rows: q1, a1, q3, a3(current), q2-old, a2-old — #6 = the abandoned tip)
		env.terminal.data("/tree 6\r");
		const summarySpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] summarizing branch…/;
		await waitUntil(() => summarySpinner.test(env.terminal.frameSince(0)), 8000);
		expect(env.terminal.frameSince(0)).not.toContain("compacting context");
		// during the window: a typed line must QUEUE, not open a stale-history turn
		env.terminal.data("typed during the switch\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("1 queued"), 8000);
		expect(env.requests).toHaveLength(4); // q1, q2, q3, and the pending summary — no 5th
		// and /new is refused while the switch is in flight
		env.terminal.data("/new\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("waits for the running turn"), 8000);
		const clearMark = env.terminal.writes.length;
		releaseSummary();
		await waitUntil(() => env.terminal.frameSince(0).includes("summarized in context"), 8000);
		// the queued line flushes as a real turn ON the new branch
		await waitUntil(() => env.terminal.frameSince(0).includes("flushed turn reply"), 8000);
		expect(env.terminal.frameSince(clearMark)).not.toMatch(summarySpinner);
		const flushed = env.requests[4];
		const userTexts = (flushed?.messages ?? [])
			.filter((m): m is UserMessage => m.role === "user")
			.map((m) => m.content);
		expect(userTexts).toContain("typed during the switch");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
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
		// (active-first rows: q1, a1, q3, a3(current), q2, a2 — #6 = a2, the old tip)
		env.terminal.data("/tree 6\r");
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
			.map((m) => (typeof m.content === "string" ? m.content : ""));
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
		expect(env.terminal.frameSince(0)).toContain("2 messages kept on this branch"); // batch B D6
		// the abandoned tail left the screen — post-fork frames only
		const forkMark = env.terminal.writes.length;
		await settle();
		expect(env.terminal.frameSince(forkMark)).not.toContain("second answer");
		// batch B D6: the forked message's TEXT sits in the editor for
		// re-editing — the user amends it (not retypes)
		env.terminal.data(" — edited\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("third answer"), 8000);
		// the provider sees q1 + the AMENDED question — the abandoned
		// assistant answer never returns, and the old text arrives only as
		// the re-edit it now is
		const last = env.requests[env.requests.length - 1];
		expect(last).toBeDefined();
		const userTexts = (last?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content);
		expect(userTexts).toContain("q1 hello");
		expect(userTexts).toContain("q2 world — edited");
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
		expect(frame).toContain("⎿ failed"); // explicit failure status
		expect(frame).toContain("⎿"); // the red ⎿ preview is gone — folded instead
		expect(frame).toContain("Error: command timed out"); // the error fold's collapsed title
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
		// the user echo (the bg block holding `!double-check…` — no `> `
		// prefix since the user-block change) is expected; the BANG echo
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
				(m) =>
					m.role === "user" &&
					typeof m.content === "string" &&
					m.content.includes("Review the diff. the parser"),
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
		expect(second.events.some((e) => e.startsWith("line:steer:remembered prompt"))).toBe(true);
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
		expect(env.terminal.frameSince(0)).toContain("⎿ plain output without the colon contract"); // preview not lost
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
		await waitUntil(() => env.terminal.frameSince(activeMark).includes("  steer: second line"), 8000);
		const stream = env.transcript.completedLines().join("\n");
		expect(stream).not.toContain("▪ queued:"); // TUI: the row replaces the note
		// idle hint swapped out (frameSince(0) still holds the startup text)
		expect(env.terminal.frameSince(activeMark)).not.toContain("(/ for commands");
		g.resolve();
		await waitUntil(() => env.terminal.frameSince(0).includes("second line"), 8000); // flushed: echoed
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
	describe("queue parity: follow-up routing and dequeue (machine)", () => {
		it("alt+enter queues a follow-up: it skips the steering poll and is consumed by the SAME run at the would-stop boundary (M17)", async () => {
			const g = gate();
			const g2 = gate();
			const g3 = gate();
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
					() => g2.promise.then(() => reply("turn one done")), // held: request 2 stays open
					() => g3.promise.then(() => reply("turn two done")), // held: the follow-up turn stays open
				],
				{ tools: [slow] },
			);
			await settle();
			env.terminal.data("go\r");
			await waitUntil(() => toolStarted);
			const runMark = env.terminal.writes.length; // mid-run mark: the run is live from here
			env.terminal.data("steer me\r"); // Enter: steer mode
			await settle();
			expect(env.terminal.frameSince(0)).toContain("  steer: steer me");
			env.terminal.data("later please");
			env.terminal.data("\x1b\r"); // alt+enter: follow-up mode
			await settle();
			expect(env.terminal.frameSince(0)).toContain("  follow-up: later please");
			g.resolve(); // tool finishes → steering poll consumes ONLY the steer entry
			await waitUntil(() => env.requests.length >= 2);
			const request2 = env.requests[1]?.messages ?? [];
			expect(request2.some((m) => m.role === "user" && m.content === "steer me")).toBe(true);
			expect(request2.some((m) => m.role === "user" && m.content === "later please")).toBe(false); // NOT injected
			g2.resolve(); // first answer lands (no tool calls) → M17 would-stop boundary:
			// the SAME run consumes the follow-up — no settle, no flush dispatch
			await waitUntil(() => env.requests.length >= 3);
			const request3 = env.requests[2]?.messages ?? [];
			expect(request3.some((m) => m.role === "user" && m.content === "later please")).toBe(true);
			await waitUntil(() => env.terminal.frameSince(0).includes("later please")); // echoed as a user block
			// same-run pin: the follow-up turn is HELD OPEN here, so the whole span
			// since runMark is mid-run — the idle editor hint must never have
			// painted between the two answers (the legacy shell pins the same
			// fact via ONE stats line)
			expect(env.terminal.frameSince(runMark)).not.toContain("(/ for commands");
			g3.resolve();
			await settle();
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("M17: two queued follow-ups drain one per boundary inside ONE run (one-at-a-time default)", async () => {
			const g = gate();
			const g2 = gate();
			const g3 = gate();
			const env = await startTuiRepl([
				() => g.promise.then(() => reply("answer one")), // held: request 1
				() => g2.promise.then(() => reply("answer two")), // held: the F1 follow-up turn
				() => g3.promise.then(() => reply("answer three")), // held: the F2 follow-up turn
			]);
			await settle();
			env.terminal.data("go\r");
			env.terminal.data("F one");
			env.terminal.data("\x1b\r"); // alt+enter: follow-up F1
			env.terminal.data("F two");
			env.terminal.data("\x1b\r"); // follow-up F2
			await settle();
			expect(env.terminal.frameSince(0)).toContain("2 queued");
			const runMark = env.terminal.writes.length; // run is live (request 1 held)
			g.resolve(); // answer one lands → boundary consumes F1 ONLY
			await waitUntil(() => env.requests.length >= 2);
			const request2 = env.requests[1]?.messages ?? [];
			expect(request2.some((m) => m.role === "user" && m.content === "F one")).toBe(true);
			expect(request2.some((m) => m.role === "user" && m.content === "F two")).toBe(false); // one-at-a-time
			// ONE run end to end: F2's turn holds below — the idle hint must
			// never have painted across the three answers
			g2.resolve(); // answer two lands → next boundary consumes F2
			await waitUntil(() => env.requests.length >= 3);
			const request3 = env.requests[2]?.messages ?? [];
			expect(request3.some((m) => m.role === "user" && m.content === "F two")).toBe(true);
			// ONE run end to end: F2's turn is HELD OPEN here — the idle hint must
			// never have painted across the three answers
			expect(env.terminal.frameSince(runMark)).not.toContain("(/ for commands");
			g3.resolve();
			await settle();
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("M17 review P1: a bang line submitted with alt+enter never enters the model — flush runs it in the shell", async () => {
			const g = gate();
			const g2 = gate();
			const env = await startTuiRepl([
				() => g.promise.then(() => reply("answer one")), // held: request 1
				() => g2.promise.then(() => reply("answer two")), // held: the F follow-up turn
			]);
			await settle();
			env.terminal.data("go\r");
			env.terminal.data("! echo shell-ran");
			env.terminal.data("\x1b\r"); // alt+enter on a bang line: mode followUp…
			env.terminal.data("F one");
			env.terminal.data("\x1b\r"); // …and a real follow-up behind it
			await settle();
			expect(env.terminal.frameSince(0)).toContain("bash: ! echo shell-ran"); // labeled as bash
			g.resolve(); // boundary: the drain must skip the bang entry, consume F only
			await waitUntil(() => env.requests.length >= 2);
			const request2 = env.requests[1]?.messages ?? [];
			expect(request2.some((m) => m.role === "user" && m.content === "F one")).toBe(true);
			for (const req of env.requests) {
				expect(req.messages.some((m) => m.role === "user" && m.content === "! echo shell-ran")).toBe(false);
			}
			g2.resolve(); // the run completes → the flush path executes the bang in the shell
			await waitUntil(() => env.terminal.frameSince(0).includes("shell-ran"), 8000);
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("M17: abort during a follow-up turn restores the unconsumed follow-up to the editor", async () => {
			const g = gate();
			let calls = 0;
			const requests: LLMRequest[] = []; // injected provider records its own
			const env = await startTuiRepl([], {
				// abort-aware hold: the FIRST response waits on the gate; the SECOND
				// (the F1 follow-up turn) holds mid-stream and loses the race to Ctrl+C
				provider: {
					name: "abort-hold",
					async *stream(request) {
						requests.push(request);
						calls++;
						if (calls === 1) {
							await g.promise;
							yield { type: "message_end", message: reply("answer one") };
							return;
						}
						yield { type: "text_delta", text: "partial" };
						await new Promise<void>((resolve) => {
							request.signal?.addEventListener("abort", () => resolve(), { once: true });
						});
						if (request.signal?.aborted) return; // abortSafe: end without message_end
						yield { type: "message_end", message: reply("never lands") };
					},
				},
			});
			await settle();
			env.terminal.data("go\r");
			env.terminal.data("F one");
			env.terminal.data("\x1b\r"); // alt+enter: follow-up F1
			env.terminal.data("F two");
			env.terminal.data("\x1b\r"); // stays queued
			await settle();
			g.resolve(); // answer one lands → boundary consumes F1 → request 2 holds mid-stream
			await waitUntil(() => requests.length >= 2);
			env.terminal.data("\x03"); // Ctrl+C: abort the running follow-up turn
			await waitUntil(() => env.terminal.frameSince(0).includes("(interrupt"));
			// the unconsumed F2 comes back to the editor (restore), never dropped
			await waitUntil(() => env.transcript.completedLines().join("\n").includes("restored 1 queued"));
			env.terminal.data("\x15"); // clear the restored draft before exiting
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("esc+p pulls every queued entry back into the editor above the current draft; the run is untouched", async () => {
			const g = gate();
			const env = await startTuiRepl([() => g.promise.then(() => reply("ok"))]);
			await settle();
			env.terminal.data("first\r");
			await waitUntil(() => env.terminal.frameSince(0).includes("(esc to interrupt"), 8000);
			env.terminal.data("q one\r");
			env.terminal.data("q two\r");
			await settle();
			expect(env.terminal.frameSince(0)).toContain("2 queued");
			env.terminal.data("draft in progress"); // typed, not submitted
			await settle();
			env.terminal.data("\x1bp"); // esc+p dequeue
			await waitUntil(() => env.transcript.completedLines().join("\n").includes("restored 2 queued"));
			await settle();
			const frame = env.terminal.frameSince(0);
			expect(frame).toContain("q one");
			expect(frame).toContain("q two");
			expect(frame).toContain("draft in progress"); // the draft survived below the restored text
			expect(env.transcript.completedLines().join("\n")).not.toContain("steering:"); // nothing was injected
			g.resolve();
			await waitUntil(() => env.requests.length >= 1);
			const first = env.requests[0]?.messages ?? [];
			expect(first.some((m) => m.role === "user" && m.content === "q one")).toBe(false); // never steered, never flushed
			env.terminal.data("\x7f".repeat(40));
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});
	});
	it("P1 regression: the restore path expands a large pasted draft — abort hands back content, not a marker", async () => {
		const g = gate();
		// Abort-aware hold (see "an aborted turn clears the activity rows"):
		// the scripted g-promise ignores the signal, so a real-abort shape is
		// injected instead.
		const env = await startTuiRepl([], {
			provider: {
				name: "abort-hold",
				async *stream(request) {
					yield { type: "text_delta", text: "partial" };
					await new Promise<void>((resolve) => {
						const onAbort = () => resolve();
						request.signal?.addEventListener("abort", onAbort, { once: true });
						g.promise.then(() => {
							request.signal?.removeEventListener("abort", onAbort);
							resolve();
						});
					});
					if (request.signal?.aborted) return;
					yield { type: "message_end", message: reply("ok") };
				},
			},
		});
		await settle();
		env.terminal.data("first\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("(esc to interrupt"), 8000);
		env.terminal.data("held line\r");
		await settle();
		// a >10-line paste becomes the (draft) content under test
		const body = Array.from({ length: 11 }, (_, i) => `draft ${i + 1}`).join("\n");
		env.terminal.data(`\x1b[200~${body}\x1b[201~`);
		await settle();
		const abortMark = env.terminal.writes.length;
		env.terminal.data("\x03"); // abort → restore into the editor
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("restored 1 queued"));
		for (let i = 0; i < 8; i++) await settle();
		// post-abort window only: the pre-abort frames legitimately showed
		// the marker while the paste sat in the editor. The editor restores
		// scrolled to its end (cursor at bottom), so pin the VISIBLE tail:
		// the pasted DRAFT came back expanded — never as a dead marker.
		const frame = env.terminal.frameSince(abortMark);
		expect(frame).toContain("draft 11");
		expect(frame).not.toContain("[paste #");
		g.resolve();
		// clear the restored editor content before exiting (≈100 chars)
		env.terminal.data("\x7f".repeat(110));
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	describe("#thinking-levels TUI", () => {
		it("shift+tab cycles the level; the note lands and the footer repaints", async () => {
			const env = await startTuiRepl([reply("ok")], { model: "claude-sonnet-4-5" });
			await settle();
			env.terminal.data("\x1b[Z"); // shift+tab — pi's binding
			await settle();
			// pi's DEFAULT_THINKING_LEVEL is "medium" — the first cycle moves to high
			expect(env.transcript.completedLines().join("\n")).toContain("Thinking level: high");
			expect(env.terminal.frameSince(0)).toContain("think:high");
			env.terminal.data("\x1b[Z");
			await settle();
			expect(env.terminal.frameSince(0)).toContain("think:off"); // high wraps to off
			// CONSECUTIVE shift+tabs merge: two cycles, ONE status line (pi
			// showStatus reuses the slot; the input echo of a slash command
			// would break the run — merge chains only across bare switches)
			const joined = env.transcript.completedLines().join("\n");
			expect(joined.match(/Thinking level:/g)?.length).toBe(1);
			expect(joined).toContain("Thinking level: off"); // the latest won
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("ctrl+t hides traces: a replayed thinking block becomes the dim Thinking... label; the text is gone", async () => {
			// a session whose assistant turn carries a thinking block
			const seed = [
				{ role: "user" as const, content: "hi" },
				{
					role: "assistant" as const,
					blocks: [
						{ type: "thinking" as const, thinking: "very secret trace text", signature: "sig" },
						{ type: "text" as const, text: "public answer" },
					],
					usage: { inputTokens: 1, outputTokens: 1 },
					stopReason: "end_turn" as const,
				},
			];
			const env = await startTuiRepl([reply("ok")], { model: "claude-sonnet-4-5", seed });
			await settle();
			const before = stripAnsi(env.transcript.render(80).join("\n"));
			expect(before).toContain("very secret trace text"); // visible by default
			expect(before).toContain("public answer");
			env.terminal.data("\x14"); // ctrl+t — pi's app.thinking.toggle
			await settle();
			const after = stripAnsi(env.transcript.render(80).join("\n"));
			expect(after).toContain("Thinking..."); // the static label replaced the trace
			expect(after).not.toContain("very secret trace text");
			expect(after).toContain("public answer"); // the answer itself survives the toggle
			expect(after).toContain("replayed 2 messages");
			env.terminal.data("\x14");
			await settle();
			expect(stripAnsi(env.transcript.render(80).join("\n"))).toBe(before);
			expect(env.requests).toHaveLength(0);
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("ctrl+t DURING a run: presentation notice preserves the streaming turn", async () => {
			let releaseTurn: () => void = () => {};
			const gated = new Promise<void>((resolve) => {
				releaseTurn = resolve;
			});
			const env = await startTuiRepl([() => gated.then(() => reply("streamed answer"))], {
				model: "claude-sonnet-4-5",
			});
			await settle();
			env.terminal.data("hi\r");
			await settle();
			env.terminal.data("\x14"); // ctrl+t mid-run
			await settle();
			expect(env.terminal.frameSince(0)).toContain("Thinking blocks: hidden"); // pi's status line
			// the banner/startup content SURVIVES — no clear+replay happened
			expect(env.transcript.completedLines().join("\n")).toContain("Tips for getting started:");
			releaseTurn();
			await settle();
			await settle();
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("no-session toggles retain active thinking, buffered answers, folds and draft without model calls", async () => {
			const g = gate();
			const answerGate = gate();
			let calls = 0;
			const provider: LLMProvider = {
				name: "toggle-test",
				async *stream() {
					calls++;
					yield { type: "thinking_delta", text: "current partial thought" };
					await g.promise;
					yield { type: "text_delta", text: "unfinished answer" };
					await answerGate.promise;
					yield { type: "text_delta", text: " completed" };
					yield { type: "message_end", message: reply("unfinished answer completed") };
				},
			};
			const env = await startTuiRepl([], { provider, noSession: true, markdown: true });
			await settle();
			const clear = vi.spyOn(env.transcript, "clear");
			const view = () => stripAnsi(env.transcript.render(80).join("\n"));
			const prior = env.transcript.thinkingSink.begin();
			prior.append("prior retained thought");
			prior.end();
			const component = new Fold("tool result", ["expanded tool result"], false);
			component.setExpanded(true);
			env.transcript.appendChild(component);
			env.terminal.data("go\r");
			await waitUntil(() => view().includes("current partial thought"));
			env.terminal.data("preserved draft");
			env.terminal.data("\x14");
			await settle();
			expect(view().match(/Thinking\.\.\./g)).toHaveLength(2);
			expect(view()).not.toContain("retained thought");
			expect(view()).not.toContain("current partial thought");
			expect(view()).toContain("expanded tool result");
			expect(component.isExpanded()).toBe(true);
			expect(view()).not.toContain("Thinking blocks:");
			env.terminal.data("\x14");
			await settle();
			expect(view()).toContain("current partial thought");
			expect(view()).toContain("prior retained thought");
			g.resolve();
			await settle();
			const buffered = env.transcript.completedLines().join("\n");
			expect(buffered).not.toContain("unfinished answer");
			env.terminal.data("\x14\x14");
			await settle();
			expect(env.transcript.completedLines().join("\n")).toBe(buffered);
			answerGate.resolve();
			await waitUntil(() => view().includes("unfinished answer completed"));
			env.terminal.data("\x14\x14"); // idle, without a session
			await settle();
			expect(clear).not.toHaveBeenCalled();
			expect(calls).toBe(1);
			expect(env.runner.session).toBeNull();
			expect(env.terminal.frameSince(0)).toContain("preserved draft");
			env.terminal.data("\x7f".repeat("preserved draft".length));
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("/login: the secret prompt renders, Enter stores the key, Esc cancels; the typed key never enters history", async () => {
			const saved: Record<string, string | undefined> = {};
			for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ZAI_API_KEY"]) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
			const authPath = path.join(await mkdtemp(path.join(tmpdir(), "imp-login-")), "auth.json");
			process.env.IMP_AUTH_PATH = authPath;
			try {
				const env = await startTuiRepl([reply("ok")]);
				await settle();
				env.terminal.data("/login zai\r");
				await settle();
				// the question renders (pi's prompt form) — unmasked input,
				// exactly like pi's LoginDialog
				expect(env.terminal.frameSince(0)).toContain("Enter Z.AI API key");
				env.terminal.data("sk-tui-key\r"); // typed + Enter
				await settle();
				expect(env.terminal.frameSince(0)).toContain("Saved API key for Z.AI");
				expect(env.terminal.frameSince(0)).toContain("▪ switch with /model zai/glm-5.3");
				expect(loadApiKey("zai", authPath)).toBe("sk-tui-key");
				// history exclusion is pinned at the shell level (the asks test
				// there covers the same submit interception)
				// Esc path: a fresh prompt cancels silently — nothing stored
				// for another family
				env.terminal.data("/login openai\r");
				await settle();
				expect(env.terminal.frameSince(0)).toContain("Enter OpenAI API key");
				env.terminal.data("\x1b"); // Esc
				await settle();
				expect(loadApiKey("openai", authPath)).toBeNull();
				env.terminal.data("/exit\r");
				await expect(env.repl).resolves.toBe(0);
			} finally {
				for (const [key, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		});

		it("footer tell: a zai model shows its zai/ prefix in the persistent footer (compat stays bare)", async () => {
			const env = await startTuiRepl([reply("ok")], { model: "zai/glm-5.3" });
			await settle();
			// the P1 fix: refreshFooter uses modelReference() — the connection
			// tell lives in the footer, not only in /model output
			expect(env.terminal.frameSince(0)).toMatch(/zai\/glm-5\.3 · /);
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});

		it("shift+tab on a knob-less model: the teaching note, no state change", async () => {
			const env = await startTuiRepl([reply("ok")]); // test-model — no knob
			await settle();
			env.terminal.data("\x1b[Z");
			await settle();
			expect(env.transcript.completedLines().join("\n")).toContain("Current model does not support thinking");
			env.terminal.data("/exit\r");
			await expect(env.repl).resolves.toBe(0);
		});
	});

	it("/skill:name echoes one summary line while the full block reaches the model", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-skill-tui-"));
		const skillDir = path.join(baseDir, "ledger");
		await mkdir(skillDir, { recursive: true });
		const skillFile = path.join(skillDir, "SKILL.md");
		const body = "Keep PROJECT_PLAN.md as an append-only ledger.\nNewest entries first.";
		await writeFile(skillFile, `---\nname: ledger\ndescription: Ledger bookkeeping\n---\n${body}\n`, "utf8");
		const loaded = loadSkills({
			cwd: baseDir,
			home: baseDir, // hermetic: no user tiers
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [skillDir],
		});
		expect(loaded.skills).toHaveLength(1);
		const skill = loaded.skills[0];
		if (skill === undefined) throw new Error("fixture did not load");
		const commands = buildSkillCommands(loaded.skills, { enabled: true, reserved: new Set() });

		const env = await startTuiRepl([reply("done")], { commands });
		await settle();
		env.terminal.data("/skill:ledger add an entry\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("done"), 8000);

		// transcript: the summary echo, never the body
		const stream = env.transcript.completedLines().join("\n");
		expect(stream).toContain("▪ skill: ledger (add an entry)");
		expect(stream).not.toContain("append-only ledger");
		// model + session: the FULL expanded block (batch-2 acceptance)
		const first = env.requests[0];
		if (first === undefined) throw new Error("no provider call");
		const lastUser = [...first.messages].reverse().find((m) => m.role === "user");
		expect(lastUser?.content).toBe(expandSkillBlock(skill, "add an entry"));
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});
	// ── #compaction-ux F2: compacting phase row ──

	/** A seeded assistant message with usage (a valid anchor shape). */
	const assistantText = (text: string): AssistantMessage => ({
		role: "assistant",
		blocks: [{ type: "text", text }],
		usage: { inputTokens: 10, outputTokens: 10 },
		model: "test-model",
		stopReason: "end_turn",
	});

	it("/compact paints a 'compacting context…' spinner row; the row clears on settle", async () => {
		// Seed a long-enough history so /compact has something to summarize; the
		// summarizer is the same scripted provider (tools: [] request shape).
		// Big enough that findCutIndex keeps a real tail (DEFAULT keepRecent
		// is 20000 tokens ≈ 80k chars — seed well past it).
		const filler = (w: string) => `${w} `.repeat(12000);
		const seed: AgentMessage[] = [
			{ role: "user", content: filler("question") },
			assistantText(filler("answer")),
			{ role: "user", content: filler("more") },
			assistantText(filler("reply")),
		];
		// Hold the summarizer open: with a scripted instant reply the whole
		// command can finish inside one render tick and the row's frame and
		// the clear's frame coalesce — observable window = zero. The gate
		// guarantees the row is on screen while the request is in flight.
		const g = gate();
		const requests: LLMRequest[] = [];
		const held: LLMProvider = {
			name: "held",
			async *stream(request) {
				requests.push(request);
				if (request.tools.length === 0) {
					await g.promise; // the summarizer call — hold it open
					yield { type: "text_delta", text: "## Goal\nsummarized" };
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							blocks: [{ type: "text", text: "## Goal\nsummarized" }],
							usage: { inputTokens: 1, outputTokens: 1 },
							stopReason: "end_turn",
						},
					};
					return;
				}
				yield* scriptedProvider([reply("ok")], []).stream(request);
			},
		};
		const env = await startTuiRepl([], { seed, provider: held });
		// Wait for the seeded replay to fully paint (the /compact keystrokes
		// must not race the replay stream) — "reply" is the last seed word.
		await waitUntil(() => env.terminal.frameSince(0).includes("(/ for commands"));
		await settle();
		env.terminal.data("/compact\r");
		// The activity row renders wrapped; frameSince inserts synthetic \n at
		// write boundaries, so never match text across one. The static note
		// "▪ compacting…" would match a loose "/\S compacting/" — pin the
		// SPINNER FRAME specifically so only the activity row satisfies this.
		const SPINNER_COMPACTING = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] compacting/;
		await waitUntil(() => requests.some((r) => r.tools.length === 0), 3000); // summarizer in flight
		await waitUntil(() => SPINNER_COMPACTING.test(env.terminal.frameSince(0)), 3000);
		g.resolve();
		// Review P2: the clear assertion must not pass vacuously. The row's
		// death flush (returnToIdle → idle snapshot) rides the same render as
		// the banner, so mark BEFORE releasing the gate: frameSince(mark)
		// then spans banner + clear + everything after, and the spinner row
		// must be absent from all of it while the pre-mark frames carried it.
		const mark = env.terminal.writes.length;
		expect(SPINNER_COMPACTING.test(env.terminal.frameSince(0))).toBe(true); // row was up
		g.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("compacted:"));
		await settle(2);
		expect(env.terminal.frameSince(mark)).not.toMatch(SPINNER_COMPACTING);
		env.terminal.data("/exit\r");
		await settle();
	});

	// ── #footer-per-turn: the ctx%/usage footer refreshes at every assistant
	// message_end DURING a run (pi: interactive-mode.ts:3279), not only at
	// settleSuccess ──

	it("footer repaints at turn boundaries inside a still-open run", async () => {
		// Turn 1: a tool call (held open). Turn 2: final text. The footer's
		// cumulative ↑↓ segments change after turn 1's message_end even though
		// the run is still in flight (the tool is gated).
		const g = gate();
		const steps: ScriptStep[] = [
			assistant([{ type: "toolCall", id: "tc1", name: "gated", arguments: { hold: true } }], "tool_use"),
			reply("all finished"),
		];
		const env = await startTuiRepl(steps, { tools: [gatedTool(g)] });
		await settle();
		const before = env.terminal.frameSince(0);
		// sanity: the startup footer exists (model + 0.0%)
		expect(before).toContain("0.0%/131k");
		env.terminal.data("go\r");
		// turn 1's assistant message_end has landed once the activity row shows
		// the gated tool running (tool events only fire after the assistant
		// message completes).
		await waitUntil(() => env.terminal.frameSince(0).includes("gated"), 3000);
		const midRun = env.terminal.frameSince(0);
		// The footer already reflects turn 1's usage: ↑/↓ moved off zero before
		// the tool (and turn 2) resolved — the per-turn refresh.
		expect(midRun).toMatch(/↑[1-9]/);
		g.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("all finished"));
		env.terminal.data("/exit\r");
		await env.repl;
	});
});

describe("TuiShell presentation notices", () => {
	it("keeps draft, ask and interrupt hints independent; selectors suppress notices", async () => {
		const { terminal, shell, transcript } = makeShell();
		shell.start();
		shell.setText("draft text");
		shell.setActive(true);
		shell.showNotice("Thinking blocks: hidden");
		let mark = terminal.writes.length;
		shell.forceRender();
		await settle();
		expect(terminal.frameSince(mark)).toContain("Thinking blocks: hidden");
		expect(terminal.frameSince(mark)).toContain("esc to interrupt");
		expect(shell.getText()).toBe("draft text");
		const asked = shell.ask("Keep this question?");
		mark = terminal.writes.length;
		shell.forceRender();
		await settle();
		expect(terminal.frameSince(mark)).toContain("Keep this question?");
		expect(terminal.frameSince(mark)).toContain("Thinking blocks: hidden");
		const selected = shell.select({ items: [{ label: "choice" }] });
		mark = terminal.writes.length;
		shell.forceRender();
		await settle();
		expect(terminal.frameSince(mark)).not.toContain("Thinking blocks: hidden");
		expect(transcript.completedLines()).toEqual([]);
		shell.close();
		await expect(selected).resolves.toBeNull();
		await expect(asked).resolves.toBe(false);
		await shell.whenSettled();
	});

	it("replaces expiry, expires while suppressed, and cancels immediately on close", async () => {
		vi.useFakeTimers();
		const { shell } = makeShell();
		try {
			shell.start();
			const state = shell as unknown as {
				noticeText: string;
				noticeTimer: unknown;
				noticeRow: { render(width: number): string[] };
			};
			expect(state.noticeRow.render(80)).toEqual([]);
			shell.showNotice("expires while visible");
			expect(state.noticeRow.render(80)).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(2000);
			expect(state.noticeRow.render(80)).toEqual([]);
			shell.showNotice("first");
			await vi.advanceTimersByTimeAsync(1500);
			shell.showNotice("second");
			await vi.advanceTimersByTimeAsync(600);
			// Inspect presentation state, not the terminal byte log's old frames.
			expect(state.noticeText).toBe("second");
			expect(state.noticeRow.render(80)).toHaveLength(1);
			const selected = shell.select({ items: [{ label: "choice" }] });
			await vi.advanceTimersByTimeAsync(1400);
			expect(state.noticeText).toBe("");
			expect(state.noticeRow.render(80)).toEqual([]);
			shell.showNotice("last");
			shell.close();
			expect(state.noticeTimer).toBeNull();
			expect(state.noticeText).toBe("");
			shell.showNotice("after close");
			expect(state.noticeTimer).toBeNull();
			await vi.advanceTimersByTimeAsync(2500);
			await expect(selected).resolves.toBeNull();
			await shell.whenSettled();
		} finally {
			shell.close();
			vi.useRealTimers();
		}
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

	it("compacting phase paints its own spinner row (#compaction-ux F2)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setActivity({ phase: "compacting", tools: [], agents: [] });
		await settle(30);
		expect(terminal.frameSince(0)).toContain("compacting context…");
		const mark = terminal.writes.length;
		shell.setActivity({ phase: "idle", tools: [], agents: [] });
		await settle(30);
		expect(terminal.frameSince(mark)).not.toContain("compacting context…");
	});

	it("elapsed ticks reuse active payload previews and idle clears them", async () => {
		const { shell } = makeShell();
		const scan = vi.spyOn(toolPresentation, "sanitizeDisplay");
		const label = "payload".repeat(10000);
		const snapshot = {
			phase: "working" as const,
			tools: [{ id: "cached", name: "bash", label, startedAtMs: Date.now() }],
			agents: [],
		};
		try {
			shell.start();
			shell.setActivity(snapshot);
			await settle(300);
			expect(scan.mock.calls.filter(([text]) => text === `bash ${label}`)).toHaveLength(1);
			shell.setActivity({ phase: "idle", tools: [], agents: [] });
			shell.setActivity(snapshot);
			await settle(30);
			expect(scan.mock.calls.filter(([text]) => text === `bash ${label}`)).toHaveLength(2);
		} finally {
			shell.close();
			scan.mockRestore();
		}
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
		expect(frame).toContain("3 tools · last: bash echo deep · scout · explore the tree");
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
		shell.setQueue([{ label: "steer", preview: "ORDER-QUEUE" }]);
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

// ── queue parity: alt+enter follow-up routing + alt+up/esc+p dequeue ─────

describe("queue parity: follow-up routing and dequeue (shell keys)", () => {
	it("alt+enter (legacy \\x1b\\r) submits the editor text as mode followUp and clears the editor", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("hello");
		terminal.data("\x1b\r");
		await settle();
		expect(events).toEqual(["line:followUp:hello"]);
		// the editor was cleared by the alt+enter submit itself
		terminal.data("x");
		terminal.data("\r");
		await settle();
		expect(events).toEqual(["line:followUp:hello", "line:steer:x"]);
		shell.close();
	});

	it("esc+p — the no-Kitty alias — fires onDequeue; alt+enter on an empty editor is a no-op", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("\x1b\r"); // empty editor: nothing to submit
		await settle();
		expect(events).toEqual([]);
		terminal.data("\x1bp"); // esc+p = alt+up
		await settle();
		expect(events).toEqual(["dequeue"]);
		// the Kitty CSI-u form of alt+up lands on the same action
		terminal.data("\x1b[1;3A");
		await settle();
		expect(events).toEqual(["dequeue", "dequeue"]);
		shell.close();
	});
});

describe("queue parity: review findings", () => {
	it("P1 regression: alt+enter expands a large paste and trims — the follow-up carries the body, never the [paste #] marker", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		// A bracketed paste over the 10-line threshold becomes a marker in
		// the editor; the Enter pipeline expands it on submit, alt+enter must too.
		const body = Array.from({ length: 12 }, (_, i) => `pasted line ${i + 1}`).join("\n");
		terminal.data(`\x1b[200~${body}\x1b[201~`);
		await settle();
		// the RENDERED editor holds the marker (getText is expanded by design)
		expect(terminal.frameSince(0)).toContain("[paste #1");
		terminal.data("\x1b\r"); // alt+enter
		await settle();
		expect(events).toHaveLength(1);
		expect(events[0]).toBe(`line:followUp:${body}`);
		expect(events[0]).not.toContain("[paste #");
		shell.close();
	});
});

// ── Ctrl+V clipboard image paste (M13 batch 2) ────────────────────────────

describe("TuiShell ctrl+v image paste", () => {
	it("inserts the tmp-file path at the cursor and consumes the key", async () => {
		const { terminal, shell } = makeShell({
			pasteImage: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }),
		});
		shell.start();
		terminal.data("\x16"); // ctrl+v through the real stdin splitter
		await new Promise((r) => setTimeout(r, 20)); // async handler settles
		const text = shell.getText() ?? "";
		expect(text).toContain("imp-clipboard-");
		expect(text.endsWith(".png")).toBe(true);
		shell.close();
	});

	it("no image on the clipboard → nothing inserted", async () => {
		// pasteText stubbed too (review P1-2): without it the fallback really
		// runs pbpaste and the developer's clipboard leaks into the test.
		const { terminal, shell } = makeShell({
			pasteImage: async () => null,
			pasteText: async () => null,
		});
		shell.start();
		terminal.data("\x16");
		await new Promise((r) => setTimeout(r, 10));
		expect(shell.getText() ?? "").toBe("");
		shell.close();
	});
});
