import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { renderMdPrompt } from "../src/core/commands-md.js";
import type { AgentMessage, AssistantMessage, UserMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import type { SessionStore } from "../src/core/session/store.js";
import { buildSkillCommands, expandSkillBlock, loadSkills } from "../src/core/skills.js";
import { buildTaskRecord } from "../src/core/task-record.js";
import { detectBinary } from "../src/core/tools/bin-detect.js";
import { taskPresentation } from "../src/core/tools/presentation.js";
import type { Tool } from "../src/core/tools/types.js";
import { type LoadedExtensions, loadExtensions } from "../src/extensions/loader.js";
import type { RegisteredExtensionCommand } from "../src/extensions/types.js";
import { dim } from "../src/format.js";
import { loadApiKey } from "../src/provider/auth-store.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { Fold } from "../src/repl/components/fold.js";
import { SectionRule } from "../src/repl/components/section-rule.js";
import { TitleCountdown } from "../src/repl/components/title-countdown.js";
import { runRepl, TtyConfirm } from "../src/repl/repl.js";
import { replaySession } from "../src/repl/replay.js";
import { type AutocompleteOptions, countdownText, effectiveTimeoutMs, TuiShell } from "../src/repl/shell.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner } from "../src/runner.js";
import {
	type AutocompleteSlashCommand,
	StdinBuffer,
	type Terminal,
	truncateToWidth,
	visibleWidth,
} from "../src/tui.js";
import {
	assistant,
	gate,
	gatedTool,
	makeRenderer,
	type ScriptStep,
	scriptedProvider,
	ticks,
	waitUntil,
	writeExtensionFiles,
} from "./helpers/fakes.js";
import { mkTempDirAsync, tempFilePath } from "./helpers/mktemp.js";

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
/** #fresh-install-hint: every env var familyConfigured reads — scrubbed
 *  by the footer-behavior tests so the live probe answers from a clean
 *  world (plus a redirected INK_AUTH_PATH, set per-test). */
const CREDENTIAL_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"ZAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"MOONSHOT_API_KEY",
	"INK_MODEL",
] as const;

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

/** #ask-timeout-countdown (design §12 r6): the FIRST frame line starting with
 *  `title` — the opening frame's title row (later countdown ticks rewrite the
 *  same line, so "first" is the stable pick for shape pins). */
function firstTitleLine(frame: string, title: string): string | undefined {
	return frame.split("\n").find((line) => line.startsWith(title));
}

function makeShell(options?: {
	onLine?: (l: string, mode?: "steer" | "followUp") => void;
	onDequeue?: () => void;
	autocomplete?: AutocompleteOptions;
	historyPath?: string;
	toolColorResolver?: (name: string) => import("../src/repl/tool-colors.js").ToolColor | undefined;
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
		toolColorResolver: options?.toolColorResolver,
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
		onModelSelect: () => events.push("model-select"),
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

	it("Ctrl+L fires model-select; a pending ask or an open picker keeps the key", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		terminal.data("\x0c"); // ctrl+l — pi's app.model.select
		await settle();
		expect(events).toEqual(["model-select"]);
		// A pending question owns the input: a typed "/model" would answer the
		// question, so the key must not bypass the ask FIFO either.
		const question = shell.ask("proceed? [y/N] ");
		await settle(0);
		terminal.data("\x0c");
		await settle();
		expect(events).toEqual(["model-select"]); // still just the one
		terminal.data("n\r"); // decline — input becomes live again
		await settle();
		await expect(question).resolves.toBe(false);
		// An open picker keeps its keys too (its guard runs first); Esc still
		// cancels the picker, never the machine.
		const pick = shell.select({ items: [{ label: "a" }] });
		await settle(0);
		terminal.data("\x0c");
		await settle();
		expect(events).toEqual(["model-select"]);
		terminal.data("\x1b"); // cancel the picker
		await expect(pick).resolves.toBeNull();
		// Mid-run the key still opens the picker — /model parity
		// (allowedDuringRun: the switch applies from the next turn).
		shell.setActive(true);
		terminal.data("\x0c");
		await settle();
		expect(events).toEqual(["model-select", "model-select"]);
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
		transcript.feed("▪ session abc — saved, resume with: ink -r abc\n");
		shell.close(); // same-tick close, exactly like gracefulExit → finish()
		await settle(80); // deferred stop must let the pending paint land first
		expect(terminal.frameSince(0)).toContain("resume with: ink -r abc");
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
		expect(frame).toContain("→ 1. alpha"); // row 0 carries the selection marker and its number
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("renders the detail block between title and items (the confirm carrier): command + reason stay in the picker", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "[guardian] allow this bash command?",
			detail: "command: rm -rf node_modules\nwhy it matched: recursive force delete",
			items: [{ label: "Yes" }, { label: "No" }],
		});
		await settle();
		const frame = terminal.frameSince(0);
		expect(frame).toContain("command: rm -rf node_modules");
		expect(frame).toContain("why it matched: recursive force delete");
		// placement: detail sits AFTER the title, BEFORE the first item
		expect(frame.indexOf("[guardian] allow this bash command?")).toBeLessThan(
			frame.indexOf("command: rm -rf node_modules"),
		);
		expect(frame.indexOf("why it matched")).toBeLessThan(frame.indexOf("→ 1. Yes"));
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("wraps a long detail line to the viewport width — nothing exceeds it", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const longCommand = `cargo build --release --target x86_64-unknown-linux-gnu ${"--features very-long-feature-name ".repeat(6)}`;
		void shell.select({ title: "allow?", detail: longCommand, items: [{ label: "Yes" }] });
		await settle();
		const frame = terminal.frameSince(0);
		expect(frame).toContain("very-long-feature-name");
		// every rendered line honors the 80-column terminal (no horizontal spill)
		for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
		shell.close();
	});

	it("warn spans highlight the risky fragment in red bold — and the color carries across wrapped lines", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const command = "cargo build --release && cargo test --workspace && rm -rf target/debug node_modules";
		const hit = "rm -rf target/debug node_modules";
		const start = command.indexOf(hit);
		void shell.select({
			title: "[guardian] allow this bash command?",
			detail: `command: ${command}\nwhy it matched: recursive force delete`,
			warnSpans: [[`command: `.length + start, `command: `.length + start + hit.length]],
			items: [{ label: "Yes" }, { label: "No" }],
		});
		await settle();
		const raw = terminal.writes.join("");
		expect(raw).toContain("\x1b[1;31m"); // the warn color really renders
		// #confirm-prompt (Phase 3 D12): the detail is normal weight, so a warn
		// span closes with a plain reset (SGR 0), NOT the dim-restoring end.
		// The span wraps the 80-col line — the closing reset lands on the tail
		// fragment; the dim-restoring end (`\x1b[0m\x1b[2m`) must not appear.
		expect(raw).toContain("node_modules\x1b[0m");
		expect(raw).not.toContain("\x1b[0m\x1b[2m");
		shell.close();
	});

	it("#confirm-prompt (Phase 4 D13/D14): the title is bare and the rule carries the host label", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		// plain-title picker (no attribution): the title is unchanged, and the
		// rule is unlabeled (plain dashes)
		void shell.select({
			title: "plain picker",
			items: [{ label: "alpha" }, { label: "beta" }],
		});
		await settle();
		expect(terminal.frameSince(0)).not.toContain("plain picker · ");
		shell.close();

		const withTag = makeShell();
		withTag.shell.start();
		await settle(0);
		void withTag.shell.select({
			title: "allow this bash command?",
			attribution: "guardian",
			items: [{ label: "Yes" }, { label: "No" }],
		});
		await settle();
		const frame = withTag.terminal.frameSince(0);
		// D13: the title is the extension's words alone — no ` · <attribution>` tag
		expect(frame).toContain("allow this bash command?");
		expect(frame).not.toContain("allow this bash command? · ");
		// D14: the row above the title is the labeled rule, not the raw title
		const lines = frame.split("\n");
		const titleAt = lines.findIndex((l) => l.trim() === "allow this bash command?");
		expect(titleAt).toBeGreaterThan(0);
		// exact bytes at width 80 (A2.2 lead-in): `──── guardian ` + 66 dashes
		expect(lines[titleAt - 1]).toBe(`──── guardian ${"─".repeat(66)}`);
		// faint dashes around a yellow label (D12 split + A2.3 accent)
		expect(withTag.terminal.writes.join("")).toContain("\x1b[33mguardian\x1b[0m");
		withTag.shell.close();
	});

	it("#confirm-prompt (Phase 4 D14): a hostile attribution is sanitized in the rule label — no raw escape reaches the terminal", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		void shell.select({
			title: "allow this bash command?",
			// an SGR escape plus a bold-marker: sanitizeDisplay must strip the
			// CSI sequence, leaving only the plain label text inside the rule.
			attribution: "bad\x1b[31mname\x1b[1m",
			items: [{ label: "Yes" }],
		});
		await settle();
		const raw = terminal.writes.join("");
		const frame = terminal.frameSince(0);
		// D14: the label survives sanitized, surrounded by dashes — no `·`
		const lines = frame.split("\n");
		const ruleAt = lines.findIndex((l) => l.includes("badname"));
		expect(ruleAt).toBeGreaterThan(-1);
		expect(lines[ruleAt]).toContain(" badname ");
		expect(lines[ruleAt]).not.toContain("\u00b7");
		// A2.3: the accent wraps the sanitized plain text
		expect(raw).toContain("\x1b[33mbadname\x1b[0m");
		expect(raw).not.toContain("\x1b[31m"); // the injected color never reaches the terminal
		expect(raw).not.toContain("\x1b[1m"); // nor the injected bold
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
		expect(terminal.frameSince(mark)).toContain("→ 2. beta"); // marker moved
		expect(terminal.frameSince(mark)).not.toContain("→ 1. alpha");
		terminal.data("\x1b[B"); // Down again → gamma
		terminal.data("\r"); // confirm
		await settle();
		await expect(chosen).resolves.toBe(2);
		shell.close();
	});

	it("#confirm-prompt: a non-filterable picker numbers its rows and shows the key affordance below them (Phase 1)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "[guardian] allow this bash command?",
			detail: "rm -rf node_modules",
			items: [{ label: "Yes" }, { label: "Yes, don't ask again this session" }, { label: "No" }],
		});
		await settle();
		const frame = terminal.frameSince(0);
		expect(frame).toContain("→ 1. Yes"); // rows carry their number
		expect(frame).toContain("  2. Yes, don't ask again this session");
		expect(frame).toContain("(↑/↓ move · enter select · esc cancel · 1-3 quick pick)");
		// the affordance sits BELOW the items (D5)
		expect(frame.indexOf("→ 1. Yes")).toBeLessThan(frame.indexOf("(↑/↓ move"));
		// and a real blank row separates the detail block from the first item
		const lines = frame.split("\n");
		const firstRowAt = lines.findIndex((line) => line.includes("→ 1. Yes"));
		expect(lines[firstRowAt - 1]?.trim()).toBe("");
		terminal.data("3"); // a digit picks item index 2
		await expect(chosen).resolves.toBe(2);
		shell.close();
	});

	it("#confirm-prompt: digits above the item count are ignored (Phase 1 D3)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({ items: [{ label: "a" }, { label: "b" }] });
		await settle();
		terminal.data("9"); // no ninth row: resolves nothing
		await settle();
		let settled: number | null | "timeout" | undefined;
		void chosen.then((value) => {
			settled = value;
		});
		await settle(0);
		expect(settled).toBeUndefined();
		terminal.data("\r"); // the highlighted row still answers
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("#confirm-prompt: a filterable picker keeps digits in its query, gains no hint, and keeps the list last (Phase 1 D2/D3/D5)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({ items: [{ label: "alpha" }, { label: "beta" }], filterable: true });
		await settle(0);
		terminal.data("a"); // a matching query: both rows survive the refilter
		await settle();
		const frame = terminal.frameSince(0);
		expect(frame).toContain("filter: a");
		expect(frame).not.toContain("quick pick"); // no affordance row here
		expect(frame).not.toContain("1. alpha"); // and no numbering
		// child order (D5): the refiltered list renders below the filter row, and
		// NO picker chrome follows it — the next non-empty line is the editor rule.
		// (applyFilter re-appends the list; chrome added after it would end up
		// ABOVE a refiltered list, which is what this pin discriminates.)
		const lines = frame.split("\n");
		const filterAt = lines.findIndex((line) => line.includes("filter: a"));
		const lastRowAt = lines.reduce(
			(last, line, index) => (line.includes("alpha") || line.includes("beta") ? index : last),
			-1,
		);
		expect(filterAt).toBeGreaterThanOrEqual(0);
		expect(lastRowAt).toBeGreaterThan(filterAt);
		const after = lines.slice(lastRowAt + 1).filter((line) => line.trim() !== "");
		expect(after[0]?.trimStart().startsWith("─")).toBe(true);
		terminal.data("\x1b"); // Esc cancels
		await expect(chosen).resolves.toBeNull();
		shell.close();
	});

	it("#confirm-prompt (Phase 2): the command preview renders once in the call-header idiom, warn span colored, no completion suffix (D7)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "[guardian] allow this bash command?",
			detail: "why it matched: recursive force delete",
			preview: { kind: "command", tool: "bash", text: "rm -rf node_modules && npm i", warnSpans: [[0, 16]] },
			items: [{ label: "Yes" }, { label: "No" }],
		});
		await settle();
		const frame = terminal.frameSince(0);
		expect(frame).toContain("● bash  rm -rf node_modules && npm i");
		// exactly one header and exactly one occurrence of the command across the picker
		expect(frame.split("● bash").length - 1).toBe(1);
		expect(frame.split("rm -rf node_modules").length - 1).toBe(1);
		// the warn span is host-colored (byte-exact pin lives in
		// test/confirm-preview.test.ts — the TUI splits a styled row across writes)
		const raw = terminal.writes.join("");
		expect(raw).toContain("\x1b[1;31m");
		// a call that has not run never carries the completion suffix
		expect(frame).not.toContain("✓");
		expect(frame).not.toContain("2.3s");
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("#confirm-prompt (Phase 2): malformed previews render nothing and never throw (D7)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const hostile = { kind: "diff", tool: 7, text: null, warnSpans: [[-5, 10 ** 6]] } as unknown as {
			kind: "command";
			tool: string;
			text: string;
		};
		const chosen = shell.select({ title: "allow?", preview: hostile, items: [{ label: "Yes" }] });
		await settle();
		const frame = terminal.frameSince(0);
		expect(frame).toContain("→ 1. Yes"); // the picker still rendered
		expect(frame).not.toContain("●"); // and the bad preview drew nothing
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("#confirm-prompt (Phase 2): control bytes are stripped and a long command stays inside the width (D7)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const hostile = `echo \x1b[31mred\x1b[0m\x07 ${"x".repeat(200)}`;
		const chosen = shell.select({
			preview: { kind: "command", tool: "bash", text: hostile },
			items: [{ label: "Yes" }],
		});
		await settle();
		const frame = terminal.frameSince(0);
		expect(frame).not.toContain("\x1b"); // sanitized before rendering
		expect(frame).toContain("echo red"); // the ANSI escape is consumed whole, the text survives
		for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
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
	it("defaults to the tui shell; INK_REPL=legacy selects the readline path", async () => {
		const { resolveShell: rs } = await import("../src/tui.js");
		vi.stubEnv("INK_REPL", "legacy");
		expect(rs()).toBe("legacy");
		vi.stubEnv("INK_REPL", "");
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
		let secondSettled: (value: number | null | "timeout") => void = () => {};
		const second = new Promise<number | null | "timeout">((resolve) => {
			secondSettled = resolve;
		});
		void shell.select({ items: [{ label: "x" }] }).then(secondSettled);
		await settle(0);
		expect(terminal.frameSince(0)).toContain("→ 1. a"); // the FIRST list is still mounted
		expect(terminal.frameSince(0)).not.toContain("→ 1. x"); // the second is queued, not stacked
		terminal.data("\x1b[B");
		terminal.data("\r");
		await expect(first).resolves.toBe(1);
		await settle();
		expect(terminal.frameSince(0)).toContain("→ 1. x"); // now the queued picker opened
		terminal.data("\r");
		await expect(second).resolves.toBe(0);
		shell.close();
	});

	it("close() drains a queued picker to null (no hang past the terminal stop)", async () => {
		const { shell } = makeShell();
		shell.start();
		await settle(0);
		const first = shell.select({ items: [{ label: "a" }] });
		let secondSettled: (value: number | null | "timeout") => void = () => {};
		const second = new Promise<number | null | "timeout">((resolve) => {
			secondSettled = resolve;
		});
		void shell.select({ items: [{ label: "x" }] }).then(secondSettled);
		shell.close(); // tears the first down, drains the queued one
		await expect(first).resolves.toBe(null);
		await expect(second).resolves.toBe(null);
	});

	it('#ask-timeout: an unanswered picker resolves "timeout", tears down like a cancel, and a late answer goes to the editor', async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({ title: "q", items: [{ label: "a" }], timeoutMs: 150 });
		await settle(); // the picker repaint lands (16ms minimum render interval)
		expect(terminal.frameSince(0)).toContain("→ 1. a");
		await expect(chosen).resolves.toBe("timeout");
		const mark = terminal.writes.length; // everything from here on is post-timeout
		await settle();
		expect(terminal.frameSince(mark)).not.toContain("→ 1. a"); // torn down
		terminal.data("late\r"); // the editor owns keys again — no ghost picker
		await settle(0);
		expect(events).toContain("line:steer:late");
		shell.close();
	});

	it("#ask-timeout: an answer arriving first disarms the deadline (no late settle)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({ items: [{ label: "a" }], timeoutMs: 150 });
		await settle();
		expect(terminal.frameSince(0)).toContain("→ 1. a");
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		const mark = terminal.writes.length;
		await settle(200); // well past the deadline: the funnel already settled, nothing re-fires
		expect(terminal.frameSince(mark)).not.toContain("→ 1. a");
		shell.close();
	});

	it("#ask-timeout: non-positive / non-finite deadlines mean no deadline (manual answer still rules)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "500" as unknown as number]) {
			const chosen = shell.select({ items: [{ label: "a" }], timeoutMs: value });
			await settle(0);
			terminal.data("\r");
			await expect(chosen).resolves.toBe(0);
			await settle(0);
		}
		// #ask-timeout-countdown: one RENDERED titled invalid-deadline picker — the
		// loop above answers before a frame flushes, so this is the pin with teeth.
		const rendered = shell.select({
			title: "allow this bash command?",
			items: [{ label: "a" }],
			timeoutMs: Number.NaN,
		});
		await settle();
		expect(terminal.frameSince(0)).toContain("→ 1. a"); // positive control
		expect(firstTitleLine(terminal.frameSince(0), "allow this bash command?")?.trimEnd()).toBe(
			"allow this bash command?",
		); // no time tail on an invalid deadline (the plain Text row pads to the box — trimEnd is normal here)
		terminal.data("\r");
		await expect(rendered).resolves.toBe(0);
		// Titleless + a valid deadline: no orphan countdown row either (r6).
		const orphan = shell.select({ items: [{ label: "a" }], timeoutMs: 600000 });
		await settle();
		expect(terminal.frameSince(0)).not.toContain("10:00");
		terminal.data("\r");
		await expect(orphan).resolves.toBe(0);
		shell.close();
	});

	it("#ask-timeout: a queued pick's deadline starts at its opening — queue time does not count (D7)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		let secondValue: number | null | "timeout" | undefined;
		const first = shell.select({ items: [{ label: "a" }], timeoutMs: 400 });
		const second = shell.select({ items: [{ label: "x" }], timeoutMs: 150 });
		void second.then((value) => {
			secondValue = value;
		});
		await settle(); // the first picker repaint lands
		expect(terminal.frameSince(0)).toContain("→ 1. a");
		await expect(first).resolves.toBe("timeout"); // ~400ms, B still queued
		await settle(30);
		// B opened when A settled and must still be waiting: a queue-time clock
		// would have fired long ago (B's 150ms vs. A's 400ms) — a fresh window
		// starts at the opening, never at queue entry.
		expect(secondValue).toBeUndefined();
		expect(terminal.frameSince(0)).toContain("→ 1. x"); // B opened
		await expect(second).resolves.toBe("timeout"); // ~150ms after opening
		shell.close();
	});

	it("#ask-timeout: close() with an armed deadline resolves null — the timer fires nothing later", async () => {
		const { shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({ items: [{ label: "a" }], timeoutMs: 30 });
		await settle(0);
		shell.close();
		await expect(chosen).resolves.toBe(null);
		await settle(60); // past the deadline: the close path disarmed it
		// no second settlement is possible; reaching here without a crash is the pin
	});

	it("#ask-timeout: process SIGINT with an armed deadline cancels (null), it does not time out", async () => {
		const { shell, events } = makeShell();
		shell.start();
		await settle(0);
		const pick = shell.select({ items: [{ label: "a" }], timeoutMs: 60 });
		await settle(0);
		process.emit("SIGINT");
		await expect(pick).resolves.toBe(null);
		expect(events).toEqual(["interrupt"]);
		shell.close();
	});

	it("#ask-timeout: an over-ceiling deadline clamps instead of overflowing into an instant fire", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		// 2^31 + 5000: an unclamped setTimeout fires oversized delays after ~1 ms,
		// so the picker would already have resolved "timeout" before the answer.
		// With the clamp the manual answer must still win.
		const chosen = shell.select({ items: [{ label: "a" }], timeoutMs: 2 ** 31 + 5000 });
		await settle();
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("#ask-timeout: stdin end with an armed deadline cancels (null), it does not time out", async () => {
		const { shell, events } = makeShell();
		shell.start();
		await settle(0);
		const pick = shell.select({ items: [{ label: "a" }], timeoutMs: 60 });
		await settle(0);
		process.stdin.emit("end");
		await expect(pick).resolves.toBe(null);
		expect(events).toEqual(["eof"]);
		shell.close();
	});

	it("#ask-timeout: integration — TtyConfirm + TuiShell fire the deadline end to end", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const { renderer, output } = makeRenderer();
		const confirm = new TtyConfirm(renderer);
		confirm.bindSelect(shell.select.bind(shell));
		await expect(
			confirm.handler(
				"allow this bash command?",
				"why it matched: recursive force delete",
				{ timeoutMs: 30, preview: { kind: "command", tool: "bash", text: "rm -rf x" } },
				"guardian",
			),
		).resolves.toBe("timeout");
		expect(output()).toContain("▪ confirm: guardian — allow this bash command? — timed out (declined)");
		const mark = terminal.writes.length; // post-timeout writes only
		await settle();
		expect(terminal.frameSince(mark)).not.toContain("→ 1. Yes"); // the picker died with the deadline
		shell.close();
	});

	it("#ask-timeout-countdown: format boundaries (pure function)", () => {
		const cases: Array<[number, string]> = [
			[600000, "10:00"],
			[59999, "1:00"],
			[60000, "1:00"],
			[61000, "1:01"],
			[59000, "0:59"],
			[3599999, "1h 00m"],
			[3600000, "1h 00m"],
			[3661000, "1h 01m"],
			[86399000, "23h 59m"],
			[86400000, "1d 00h"],
			[2147483647, "24d 20h"],
			[0, "0:01"],
			[-5000, "0:01"],
			[Number.NaN, "0:01"],
			[Number.POSITIVE_INFINITY, "0:01"],
		];
		for (const [ms, want] of cases) {
			expect(countdownText(ms)).toBe(want);
		}
	});

	it("#ask-timeout-countdown: effectiveTimeoutMs is the single validated source", () => {
		expect(effectiveTimeoutMs(undefined)).toBeNull();
		expect(effectiveTimeoutMs(0)).toBeNull();
		expect(effectiveTimeoutMs(-5)).toBeNull();
		expect(effectiveTimeoutMs(Number.NaN)).toBeNull();
		expect(effectiveTimeoutMs(Number.POSITIVE_INFINITY)).toBeNull();
		expect(effectiveTimeoutMs("500" as unknown as number)).toBeNull();
		expect(effectiveTimeoutMs(2147483648)).toBe(2147483647);
		expect(effectiveTimeoutMs(600000)).toBe(600000);
	});

	it("#ask-timeout-countdown: the opening frame carries the bare time in parens next to the title; it ticks down", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "allow this bash command?",
			items: [{ label: "a" }],
			timeoutMs: 600000,
		});
		await settle();
		const frame = terminal.frameSince(0);
		const titleLine = firstTitleLine(frame, "allow this bash command?");
		expect(titleLine).toBeDefined();
		// Strict shape (r6): the time sits in parens right next to the question —
		// no right-edge padding, no gap arithmetic (untrimmed equality).
		expect(titleLine).toBe("allow this bash command? (10:00)");
		expect(terminal.writes.join("")).toContain("\x1b[2m(10:00)\x1b[0m"); // forced dim (non-TTY too)
		// The countdown contract is "it ticks down", not millisecond precision: a
		// first tick delayed by system load renders 9:58 and would skip the exact
		// 9:59 frame (flake observed live) — poll for the 9-minute window instead.
		// The opening "(10:00)" row stays in the history and never matches
		// `9:\d\d\)` — a dead interval cannot satisfy this poll (non-vacuous).
		const start = Date.now();
		let ticked: string | undefined;
		while (Date.now() - start < 5000) {
			const hit = terminal
				.frameSince(0)
				.split("\n")
				.find((line) => line.startsWith("allow this bash command?") && /9:\d\d\)$/u.test(line));
			if (hit !== undefined) {
				ticked = hit;
				break;
			}
			await settle(15);
		}
		expect(ticked).toBeDefined();
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		const mark = terminal.writes.length;
		await settle();
		expect(firstTitleLine(terminal.frameSince(mark), "allow this bash command?")).toBeUndefined(); // left with the picker
		shell.close();
	});

	it("#ask-timeout-countdown: no deadline → the title stays the plain Text (byte-exact, no tail)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const plain = shell.select({ title: "allow this bash command?", items: [{ label: "a" }] });
		await settle();
		expect(terminal.frameSince(0)).toContain("→ 1. a"); // positive control: the picker rendered
		expect(firstTitleLine(terminal.frameSince(0), "allow this bash command?")?.trimEnd()).toBe(
			"allow this bash command?",
		); // no tail; the row still shows the plain Text padding
		const rule = terminal
			.frameSince(0)
			.split("\n")
			.find((l) => l.includes("─"));
		expect(visibleWidth(firstTitleLine(terminal.frameSince(0), "allow this bash command?") ?? "")).toBe(
			visibleWidth(rule ?? ""),
		); // padded to the box width exactly like the rule (plain Text, not the component)
		terminal.data("\r");
		await expect(plain).resolves.toBe(0);
		shell.close();
	});

	it("#ask-timeout-countdown: titles that flatten to empty carry no countdown (no orphan tail)", async () => {
		for (const title of ["   ", "\x1b[2K", "\u200b", "\u0301", "\u2060"]) {
			const { terminal, shell } = makeShell();
			shell.start();
			await settle(0);
			const chosen = shell.select({ title, items: [{ label: "a" }], timeoutMs: 300 });
			await settle();
			expect(terminal.frameSince(0)).toContain("→ 1. a"); // positive control
			expect(terminal.frameSince(0)).not.toMatch(/\(\d?\d:\d\d\)$/mu); // no countdown tail anywhere
			await expect(chosen).resolves.toBe("timeout"); // the deadline still fires (D9 r6)
			shell.close();
		}
	});

	it("#ask-timeout-countdown: a timed-out picker never shows 0:00 and the ticks die with it", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "allow this bash command?",
			items: [{ label: "a" }],
			timeoutMs: 1000,
		});
		await settle();
		expect(firstTitleLine(terminal.frameSince(0), "allow this bash command?")?.endsWith("(0:01)")).toBe(true);
		await expect(chosen).resolves.toBe("timeout");
		expect(terminal.frameSince(0)).not.toMatch(/\b0:00\b/u); // lifetime history — structurally unreachable
		const mark = terminal.writes.length;
		await settle(1200); // past several ticks: the interval was cleared in finish
		expect(firstTitleLine(terminal.frameSince(mark), "allow this bash command?")).toBeUndefined();
		shell.close();
	});

	it("#ask-timeout-countdown: the tick skips unchanged text (>=1h format: one repaint, then quiet)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "allow this bash command?",
			items: [{ label: "a" }],
			timeoutMs: 7200000,
		});
		await settle();
		// The 2 h format rolls once (2h 00m -> 1h 59m) at the first tick, then the
		// text is stable for a minute. The skip guard must hold setRight back —
		// note the differential renderer writes nothing for an unchanged frame,
		// so the write count cannot see a guard-less mutant; the spy can.
		const spy = vi.spyOn(TitleCountdown.prototype, "setRight");
		try {
			const start = Date.now();
			while (!terminal.frameSince(0).includes("(1h 59m)") && Date.now() - start < 5000) await settle(15);
			expect(terminal.frameSince(0)).toContain("(1h 59m)");
			const calls = spy.mock.calls.length;
			await settle(2400); // two more ticks
			expect(spy.mock.calls.length).toBe(calls); // unchanged text -> no setRight
		} finally {
			spy.mockRestore();
		}
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("#ask-timeout-countdown: close() disarms the countdown with the deadline", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "allow this bash command?",
			items: [{ label: "a" }],
			timeoutMs: 600000,
		});
		await settle();
		expect(firstTitleLine(terminal.frameSince(0), "allow this bash command?")?.endsWith("(10:00)")).toBe(
			true,
		);
		shell.close();
		await expect(chosen).resolves.toBe(null);
		const mark = terminal.writes.length;
		await settle(1200);
		expect(firstTitleLine(terminal.frameSince(mark), "allow this bash command?")).toBeUndefined();
	});

	it("#ask-timeout-countdown: finish clears the interval handle (spy pin)", async () => {
		const setSpy = vi.spyOn(globalThis, "setInterval");
		const clearSpy = vi.spyOn(globalThis, "clearInterval");
		try {
			const { terminal, shell } = makeShell();
			shell.start();
			await settle(0);
			const before = setSpy.mock.calls.length;
			const chosen = shell.select({
				title: "allow this bash command?",
				items: [{ label: "a" }],
				timeoutMs: 600000,
			});
			await settle();
			expect(setSpy.mock.calls.length).toBeGreaterThan(before); // the countdown interval armed
			const handle = setSpy.mock.results[before]?.value;
			expect(handle).toBeDefined();
			terminal.data("\r");
			await expect(chosen).resolves.toBe(0);
			expect(clearSpy.mock.calls.some((call) => call[0] === handle)).toBe(true);
			// D14: a titleless timed picker arms NO interval — there is no
			// component to repaint (the deadline timer still fires).
			const afterTitled = setSpy.mock.calls.length;
			const titleless = shell.select({ items: [{ label: "b" }], timeoutMs: 600000 });
			await settle();
			expect(setSpy.mock.calls.length).toBe(afterTitled);
			terminal.data("\r");
			await expect(titleless).resolves.toBe(0);
			shell.close();
		} finally {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});

	it("#ask-timeout-countdown: a filterable picker carries the time on its title; refilter keeps the list last", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "allow this bash command?",
			items: [{ label: "alpha" }, { label: "beta" }],
			filterable: true,
			timeoutMs: 600000,
		});
		await settle(); // the initial FULL frame lands (pi-tui repaints changed rows only later)
		expect(firstTitleLine(terminal.frameSince(0), "allow this bash command?")?.endsWith("(10:00)")).toBe(
			true,
		);
		const mark = terminal.writes.length; // only the REFILTER diff region from here on
		terminal.data("a"); // refilter: the list rebuilds via remove+append
		await settle();
		// The refilter repaints CHANGED rows only (observed: filter row + list rows
		// + editor rules). Contract pins: the query row leads, the list rows follow
		// it directly, and no picker chrome follows the last row (the Phase-1 D5
		// list-last pin; the old countdown-position pin is superseded by the title
		// shape pin above — r5.1).
		const lines = terminal
			.frameSince(mark)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		expect(lines[0]).toContain("filter: a");
		expect(lines[1] ?? "").toMatch(/alpha|beta/u);
		const lastRowAt = lines.reduce(
			(last, line, index) => (line.includes("alpha") || line.includes("beta") ? index : last),
			-1,
		);
		expect(lastRowAt).toBeGreaterThanOrEqual(0);
		const after = lines.slice(lastRowAt + 1);
		expect(after.some((line) => line.includes("quick pick"))).toBe(false);
		terminal.data("\x1b"); // cancel
		await expect(chosen).resolves.toBeNull();
		shell.close();
	});

	it("#ask-timeout-countdown: a narrow terminal truncates the title, keeping the time whole", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		terminal.resize(40);
		await settle();
		const title = `allow this bash command? ${"x".repeat(60)}`;
		const chosen = shell.select({ title, items: [{ label: "a" }], timeoutMs: 600000 });
		await settle();
		const line = terminal
			.frameSince(0)
			.split("\n")
			.find((l) => l.startsWith("allow this bash command? "));
		expect(line).toBeDefined();
		expect(line?.includes("…")).toBe(true);
		expect(line?.endsWith("(10:00)")).toBe(true);
		expect(visibleWidth(line ?? "")).toBe(40);
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("#ask-timeout-countdown: without a deadline a long title still wraps (no … substitution)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const long = "T".repeat(120);
		const pick = shell.select({ title: long, items: [{ label: "a" }] });
		await settle();
		const frame = terminal.frameSince(0);
		const tLines = frame
			.split("\n")
			.filter((line) => /^T+ *$/u.test(line))
			.map((line) => line.trimEnd());
		expect(tLines.length).toBeGreaterThanOrEqual(2); // wrapped, multi-row
		expect(tLines.join("")).toBe(long); // nothing dropped
		expect(frame).not.toContain("…"); // and no truncation ellipsis anywhere
		terminal.data("\r");
		await expect(pick).resolves.toBe(0);
		shell.close();
	});

	it("#ask-timeout-countdown: TitleCountdown — fits next to the title, NOT padded to width", () => {
		const raw = new TitleCountdown("allow this bash command?", "10:00").render(80)[0] ?? "";
		const line = stripAnsi(raw);
		expect(line).toBe("allow this bash command? (10:00)");
		// Natural width — the r6 no-pad pin (a right-align/right-edge mutant
		// would grow this to 80).
		expect(visibleWidth(raw)).toBe(visibleWidth("allow this bash command?") + 1 + visibleWidth("(10:00)"));
	});

	it("#ask-timeout-countdown: TitleCountdown — long ASCII title truncates, time whole, fills the width", () => {
		const raw = new TitleCountdown("x".repeat(200), "10:00").render(40)[0] ?? "";
		const line = stripAnsi(raw);
		expect(line).toContain("…");
		expect(line.endsWith("(10:00)")).toBe(true);
		expect(line).not.toContain("\n");
		expect(visibleWidth(raw)).toBe(40);
	});

	it("#ask-timeout-countdown: TitleCountdown — degenerate clip: clip first, style after (raw bytes)", () => {
		const raw = new TitleCountdown("x", "9:59").render(5)[0] ?? "";
		// The ellipsis lives INSIDE the dim span (D10: 先裁后样式) — a
		// clip-after-dim mutant changes these bytes.
		expect(raw).toBe(dim(truncateToWidth("(9:59)", 5, "…"), true));
		expect(stripAnsi(raw).endsWith("…")).toBe(true);
	});

	it("#ask-timeout-countdown: TitleCountdown — wide glyphs: one-column shortfall allowed, never over", () => {
		// "界"×30 truncates to 31 columns at budget 32 (odd budgets cannot fill
		// with width-2 glyphs) — line = 31 + space + "(10:00)" = 39 ≤ 40.
		const raw = new TitleCountdown("界".repeat(30), "10:00").render(40)[0] ?? "";
		const line = stripAnsi(raw);
		expect(line.endsWith("(10:00)")).toBe(true);
		expect(visibleWidth(raw)).toBe(39);
	});

	it("#ask-timeout-countdown: TitleCountdown — a multi-line title flattens to one row", () => {
		const line = stripAnsi(new TitleCountdown("a\nb", "0:30").render(20)[0] ?? "");
		expect(line).not.toContain("\n");
		expect(line).toBe("a b (0:30)");
	});

	it("#ask-timeout-countdown: TitleCountdown — width sweep: never wider; above natural width NOT padded", () => {
		const left = "allow this?";
		const component = new TitleCountdown(left, "10:00");
		const parenWidth = visibleWidth("(10:00)");
		const natural = visibleWidth(left) + 1 + parenWidth;
		for (let width = 0; width <= natural + 3; width++) {
			const line = component.render(width)[0] ?? "";
			expect(line).not.toContain("\n");
			const w = visibleWidth(line);
			expect(w).toBeLessThanOrEqual(width);
			if (width <= parenWidth) {
				// Degenerate: no room for title + space — identical to the
				// empty-title render.
				expect(stripAnsi(line)).toBe(stripAnsi(new TitleCountdown("", "10:00").render(width)[0] ?? ""));
			} else {
				if (width === parenWidth + 1) {
					// budget == 0: the title is dropped with NO leading space (D10).
					expect(stripAnsi(line)).toBe("(10:00)");
				}
				expect(stripAnsi(line).endsWith("(10:00)")).toBe(true); // the time stays whole
				// Above the natural width the line stays at natural width — the
				// r6 no-pad beat: a pad/right-align mutant grows it to `width`.
				if (width >= natural) expect(w).toBe(natural);
			}
		}
	});

	it("a question queued while a picker is open renders only after the picker resolves", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const pick = shell.select({ items: [{ label: "a" }] });
		await settle(0);
		const question = shell.ask("proceed? [y/N] ");
		await settle();
		expect(terminal.frameSince(0)).toContain("→ 1. a"); // positive control: picker rendered
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
		const dir = await mkTempDirAsync("ink-ac-");
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

	it("SA-05: child-only usage never moves the context segment", async () => {
		const ctxOf = async (withChild: boolean): Promise<string | undefined> => {
			const env = await startTuiRepl([reply("ok")], {
				seedSession: (store) => {
					store.appendMessage({ role: "user", content: "hello" });
					store.appendMessage({
						role: "assistant",
						blocks: [{ type: "text", text: "hi" }],
						usage: { inputTokens: 100, outputTokens: 10 },
						model: "test-model",
						stopReason: "end_turn",
					});
					// identical content either way — only the record differs
					store.appendMessage({
						role: "toolResult",
						results: [
							{
								toolCallId: "t1",
								toolName: "task",
								content: "",
								isError: false,
								...(withChild && {
									taskRecord: buildTaskRecord({
										attemptId: "att-ctx",
										sourceId: "src-ctx",
										launched: true,
										cwd: "/tmp",
										status: "completed",
										turns: 2,
										textPresent: true,
										usage: { inputTokens: 50, outputTokens: 7 },
										binding: { providerName: "zai", wireModelId: "glm-5.3", reference: "zai/glm-5.3" },
									}),
								}),
							},
						],
					});
				},
			});
			await settle();
			const frame = env.terminal.frameSince(0);
			env.terminal.data("/exit\r");
			await env.repl;
			return /\d+\.\d%\/[0-9.]+[km]?/.exec(frame)?.[0];
		};
		const control = await ctxOf(false);
		const withChild = await ctxOf(true);
		expect(control).toBeDefined();
		expect(withChild).toBe(control); // child usage feeds work totals only — never ctx%
	});

	it("SA-05 R1: the footer keeps compacted-away usage (whole-session totals)", async () => {
		const usageAssistant = (text: string, inputTokens: number, outputTokens: number): AssistantMessage => ({
			role: "assistant",
			blocks: [{ type: "text", text }],
			usage: { inputTokens, outputTokens },
			model: "test-model",
			stopReason: "end_turn",
		});
		const env = await startTuiRepl([reply("ok")], {
			seedSession: (store) => {
				store.appendMessage({ role: "user", content: "long analysis please" });
				store.appendMessage(usageAssistant("long analysis", 100, 10));
				store.appendCompaction("## Goal\nsummary", [], 500);
				store.appendMessage(usageAssistant("after", 5, 5));
			},
		});
		await settle();
		// The live history is post-compaction (summary + "after") — the footer
		// must still count the compacted-away 100/10 call.
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("↑105");
		expect(frame).toContain("↓15");
		env.terminal.data("/exit\r");
		await env.repl;
	});

	async function startTuiRepl(
		scripts: ScriptStep[],
		options?: {
			commands?: RegisteredExtensionCommand[];
			tools?: Tool[];
			confirm?: boolean;
			agentsHomeDir?: string;
			provider?: LLMProvider; // inject an abort-aware hold stream when needed
			/** #fresh-install-hint: skip the scripted injection entirely — the
			 *  runner resolves a REAL provider so the D7 seam stays OFF (footer
			 *  tests for the unusable state). No turn is submitted on that path. */
			realProvider?: boolean;
			model?: string; // default test-model is knob-less; Claude opts into thinking
			seed?: AgentMessage[]; // pre-written session history (replayed at startup)
			seedSession?: (store: SessionStore) => void; // raw seeding (entries incl. compaction)
			noSession?: boolean;
			markdown?: boolean;
			/** #tool-name-colors: real .mjs fixtures loaded by the real loader,
			 *  written to <cwd>/.ink/extensions before the runner starts. */
			extensionFiles?: Record<string, string>;
			/** #tui-tool-elapsed: deterministic sink clock for duration pins. */
			clock?: () => number;
		},
	) {
		const baseDir = await mkTempDirAsync("ink-tui-");
		const seeded =
			options?.seedSession !== undefined || (options?.seed !== undefined && options.seed.length > 0);
		if (seeded) {
			const store = createSession(baseDir, baseDir); // runner cwd is baseDir — same bucket
			options?.seedSession?.(store);
			for (const message of options?.seed ?? []) store.appendMessage(message);
		}
		const requests: LLMRequest[] = [];
		let loaded: LoadedExtensions | undefined;
		if (options?.extensionFiles !== undefined) {
			await writeExtensionFiles(baseDir, options.extensionFiles);
			loaded = await loadExtensions({
				cwd: baseDir,
				cliPaths: [],
				home: path.join(baseDir, "ext-home"), // hermetic: never the real dir
				onDiagnostic: () => {},
			});
		}
		const provider: LLMProvider | undefined =
			options?.provider ?? (options?.realProvider === true ? undefined : scriptedProvider(scripts, requests));
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink(options?.clock === undefined ? {} : { clock: options.clock });
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
			continueRecent: seeded ? true : undefined,
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
			extensions: loaded?.runtime,
			exit: (code: number) => {
				throw new Error(`force-exit:${code}`);
			},
		});
		await ticks(2);
		return { runner, terminal, transcript, repl, requests, baseDir, confirm };
	}

	it("rejects a tui shell without the transcript (wiring guard)", async () => {
		const baseDir = await mkTempDirAsync("ink-tui-guard-");
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
		expect(env.terminal.frameSince(0)).toContain("working…"); // activity row while the turn runs
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
		for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "INK_AUTH_PATH"]) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.INK_AUTH_PATH = "/nonexistent-imp-auth.json";
		try {
			const env = await startTuiRepl([reply("ok")]);
			await settle();
			env.terminal.data("/model\r");
			await settle();
			const frame = env.terminal.frameSince(0);
			expect(frame).toContain("models — switch applies from the next turn"); // title
			expect(frame).toContain("→ 1. test-model"); // current id first, preselected
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

	// ── #fresh-install-hint: real footer behavior pins (design tests 2/10/11;
	// implementation review F3 — the unit-suite footer test only pinned the
	// constants, not the gating) ────────────────────────────────────────

	it("#fresh-install-hint: unusable model — footer shows 'no model — /login' and DROPS the think segment", async () => {
		// scrubbed credentials + a REAL provider (no injection — the D7 seam
		// must NOT mask the gating). claude-sonnet-4-5 HAS a thinking meta, so
		// a missing think segment is the F7 pin (a reverted `usable &&` gate
		// would render `no model — /login think:medium` and fail this).
		const saved: Record<string, string | undefined> = { INK_AUTH_PATH: process.env.INK_AUTH_PATH };
		for (const key of CREDENTIAL_ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.INK_AUTH_PATH = tempFilePath("ink-fresh-tui-");
		try {
			// NO provider injection — the runner resolves a REAL anthropic
			// provider; no turn is ever submitted, so nothing reaches the
			// network. Injecting would trip the D7 seam (usable) and mask the
			// gating this test pins.
			const env = await startTuiRepl([], { model: "claude-sonnet-4-5", realProvider: true });
			await settle();
			const frame = env.terminal.frameSince(0);
			expect(frame).toContain("no model — /login");
			expect(frame).not.toContain("think:"); // F7: no knob beside "no model"
			expect(frame).not.toContain("claude-sonnet-4-5 ·"); // dead id never renders as in use
			env.terminal.data("/exit\r");
			await env.repl;
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("#fresh-install-hint test 11: /model to an unconfigured family mid-session flips the footer back", async () => {
		const saved: Record<string, string | undefined> = { INK_AUTH_PATH: process.env.INK_AUTH_PATH };
		for (const key of CREDENTIAL_ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.INK_AUTH_PATH = tempFilePath("ink-fresh-tui-");
		try {
			// start USABLE (env key on) so the initial footer shows the model;
			// then drop the key and switch family — the live probe must flip it.
			process.env.OPENAI_API_KEY = "test-key";
			const env = await startTuiRepl([reply("ok")], { model: "openai/gpt-5.2" });
			await settle();
			expect(env.terminal.frameSince(0)).toContain("openai/gpt-5.2");
			delete process.env.OPENAI_API_KEY;
			env.terminal.data("/model zai/glm-5.3\r");
			await settle();
			const frame = env.terminal.frameSince(0);
			expect(frame).toContain("Model: zai/glm-5.3"); // the switch itself worked
			expect(frame).toContain("no model — /login"); // footer re-probed (post-switch provider is REAL)
			env.terminal.data("/exit\r");
			await env.repl;
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("#fresh-install-hint: terminal title — startup default keyless shows the pointer; an explicit /model pick shows the id", async () => {
		const saved: Record<string, string | undefined> = { INK_AUTH_PATH: process.env.INK_AUTH_PATH };
		for (const key of CREDENTIAL_ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.INK_AUTH_PATH = tempFilePath("ink-fresh-tui-");
		try {
			const env = await startTuiRepl([], { model: "claude-sonnet-4-5", realProvider: true });
			await settle();
			// Startup default, no credential: the title (OSC 2 bytes in the raw
			// stream — shell.setTitle writes them directly) mirrors the /login
			// pointer (F5) — never the dead id.
			const bytes = () => env.terminal.writes.join("");
			expect(bytes()).toContain("\x1b]2;Ink — no model — /login\x07");
			expect(bytes()).not.toContain("\x1b]2;Ink — claude-sonnet-4-5\x07");
			// An explicit /model pick is the user's choice: the id shows even
			// though zai holds no credential (modelSelectedExplicitly).
			env.terminal.data("/model glm-4.6\r");
			await settle();
			expect(bytes()).toContain("\x1b]2;Ink — glm-4.6\x07");
			env.terminal.data("/exit\r");
			await env.repl;
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("#fresh-install-hint test 10: /login success repaints the footer (credential change flips the segment)", async () => {
		const saved: Record<string, string | undefined> = { INK_AUTH_PATH: process.env.INK_AUTH_PATH };
		for (const key of CREDENTIAL_ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.INK_AUTH_PATH = tempFilePath("ink-fresh-tui-");
		try {
			const env = await startTuiRepl([], { model: "deepseek/deepseek-v4-pro", realProvider: true });
			await settle();
			expect(env.terminal.frameSince(0)).toContain("no model — /login"); // unusable start
			// /login deepseek → the shell's secret prompt (readline-style TUI)
			env.terminal.data("/login deepseek\r");
			await settle();
			env.terminal.data("a-test-key-123\r"); // the key prompt's answer
			await settle();
			const frame = env.terminal.frameSince(0);
			expect(frame).toContain("Saved API key for DeepSeek");
			expect(frame).toContain("deepseek/deepseek-v4-pro"); // D6: footer flipped on login success
			env.terminal.data("/exit\r");
			await env.repl;
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
		for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "INK_AUTH_PATH"]) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.INK_AUTH_PATH = "/nonexistent-imp-auth.json";
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

	it("Ctrl+L opens the model picker (pi's app.model.select); held-key repeats queue no second picker", async () => {
		// #model-discovery hermeticity (same pin as the /model tests above)
		const saved: Record<string, string | undefined> = {};
		for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "INK_AUTH_PATH"]) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.INK_AUTH_PATH = "/nonexistent-imp-auth.json";
		try {
			const env = await startTuiRepl([reply("first"), reply("second")]);
			await settle();
			// A held key repeats the byte; all three arrive before the async
			// list build reaches select() — exactly ONE picker may open (the
			// latch in selectModel; without it select() QUEUES a second).
			env.terminal.data("\x0c\x0c\x0c");
			await frameContains(env, "models — switch applies from the next turn");
			const frame = env.terminal.frameSince(0);
			expect(frame).toContain("→ 1. test-model"); // current id first, preselected
			expect(frame).toContain("claude-sonnet-4-5");
			env.terminal.data("\x1b[B"); // Down → claude-sonnet-4-5 (row 1)
			await settle();
			env.terminal.data("\r"); // pick
			await settle();
			expect(env.runner.model).toBe("claude-sonnet-4-5");
			expect(env.transcript.completedLines().join("\n")).toContain("Model: claude-sonnet-4-5");
			// Repeat-guard proof (behavioral): the editor — not a stray queued
			// picker — consumes the next line. A stray picker would swallow
			// "hello…" as a filter query and Enter would pick a row instead.
			env.terminal.data("hello after pick\r");
			await settle();
			expect(env.requests).toHaveLength(1);
			expect(env.requests[0]?.messages.at(-1)).toMatchObject({ role: "user", content: "hello after pick" });
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

	it("Ctrl+L DURING a run: the picker opens mid-stream; Esc leaves the turn running", async () => {
		let releaseTurn: () => void = () => {};
		const gated = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const env = await startTuiRepl([() => gated.then(() => reply("streamed answer"))]);
		await settle();
		env.terminal.data("hi\r");
		await settle();
		env.terminal.data("\x0c"); // ctrl+l mid-run — /model's allowedDuringRun parity
		await frameContains(env, "models — switch applies from the next turn");
		env.terminal.data("\x1b"); // cancel the picker — NOT an interrupt
		await settle();
		expect(env.runner.model).toBe("test-model"); // a cancelled pick changes nothing
		releaseTurn();
		await settle();
		await settle();
		expect(env.transcript.completedLines().join("\n")).toContain("streamed answer"); // the run survived
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
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

	it("semantic tools: concurrent results render under their own call, live and on replay", async () => {
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
		// #tool-settle: b's own settle renders its result immediately — the
		// display no longer waits for the chunk to drain. a is still running.
		await waitUntil(() => env.transcript.toolFolds.some((f) => f.block.kind === "output"));
		expect(env.transcript.toolFolds.map((f) => [f.block.id, f.block.kind])).toEqual([
			["a", "input"],
			["b", "input"],
			["b", "output"],
		]);
		first.resolve();
		await frameContains(env, "parallel done");
		// The fold ARRAY is now settle-ordered (b settled first). What is retained
		// regardless of completion timing is the RENDERED order, asserted below.
		expect(env.transcript.toolFolds.map((f) => f.block.id)).toEqual(["a", "b", "b", "a"]);
		// #tool-result-follows-call: each result RENDERS under its own call.
		const rendered = env.transcript.render(80).map(stripAnsi);
		const atRow = (needle: string) => rendered.findIndex((row) => row.includes(needle));
		expect(atRow('"id": "a"')).toBeLessThan(atRow("a result"));
		expect(atRow("a result")).toBeLessThan(atRow('"id": "b"'));
		expect(atRow('"id": "b"')).toBeLessThan(atRow("b result"));
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
		expect(env.transcript.toolFolds.map((f) => f.block.id)).toEqual(["a", "b", "a", "b"]);
		// replay reproduces the live grouping: result under its own call.
		const replayed = env.transcript.render(80).map(stripAnsi);
		const atReplay = (needle: string) => replayed.findIndex((row) => row.includes(needle));
		expect(atReplay('"id": "a"')).toBeLessThan(atReplay("a result"));
		expect(atReplay("a result")).toBeLessThan(atReplay('"id": "b"'));
		expect(atReplay('"id": "b"')).toBeLessThan(atReplay("b result"));
		env.terminal.data("\x0f");
		await waitUntil(() => env.transcript.toolFolds.every((f) => f.isExpanded()));
		env.terminal.data("/new\r");
		await frameContains(env, "new session");
		expect(env.transcript.toolFolds).toHaveLength(0);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("autocomplete is live in production wiring: Ink's COMMANDS feed the panel, Enter completes and runs /help", async () => {
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
		expect(runFrame).toContain("working…"); // activity row while gated
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

	it("working phase paints a spinner row while the model is gated; it clears on settle", async () => {
		const g = gate();
		const env = await startTuiRepl([() => g.promise.then(() => reply("hello"))]);
		await settle();
		env.terminal.data("go\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("working…"); // the activity row, not a byte-stream spinner
		const mark = env.terminal.writes.length;
		g.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("hello"));
		await settle();
		expect(env.terminal.frameSince(mark)).not.toContain("working"); // row cleared on settle
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
				emit({
					type: "tool_start",
					toolCallId: id,
					name: "task",
					args: { agent: "same", prompt: "shared prompt" },
				});
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
			const a2 = { ...a, sourceId: "source-a2" };
			emit(start("a2"), a2);
			let mark = env.terminal.writes.length;
			env.terminal.resize(100);
			await settle();
			const frame = env.terminal.frameSince(mark);
			expect(frame).toContain("pending #1.1 same");
			expect(frame).toContain("pending #1.2 same");
			expect(frame).toContain("pending #2.1 same");
			expect(frame.split("shared prompt").length - 1).toBeGreaterThanOrEqual(3);
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
			expect(call).toHaveBeenCalledTimes(3);
			mark = env.terminal.writes.length;
			env.terminal.resize(90);
			await settle();
			const remaining = env.terminal.frameSince(mark);
			expect(remaining).toContain("pending #2.1 same");
			expect(remaining).not.toContain("pending #1");
			expect(remaining).toContain("last: child_tool child-b");
			expect(remaining).not.toContain("child-a");
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
		expect(call).toHaveBeenCalledTimes(3);
		expect(env.transcript.toolFolds.every((f) => f.block.name === "task")).toBe(true);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});
	it("#sliding-window: a queued task row upgrades to running on tool_running; the timer starts at admission (test 11/13/13b)", async () => {
		// 6 concurrency-safe task calls: the loop would run 5 and queue the 6th.
		// Here the run is mocked at runTurn, so the events drive the tap exactly
		// as the real loop would (tool_start pre-issued for all, tool_running
		// for the first five, the 6th admitted later).
		const env = await startTuiRepl([reply("done")]);
		const seen: Parameters<TuiShell["setActivity"]>[0][] = [];
		const realSetActivity = TuiShell.prototype.setActivity;
		const spy = vi.spyOn(TuiShell.prototype, "setActivity").mockImplementation(function (
			this: TuiShell,
			snapshot,
		) {
			seen.push(snapshot);
			realSetActivity.call(this, snapshot);
		});
		onTestFinished(() => spy.mockRestore());
		let queuedSnapshot: Parameters<TuiShell["setActivity"]>[0] | undefined;
		let upgradedSnapshot: Parameters<TuiShell["setActivity"]>[0] | undefined;
		const original = env.runner.runTurn.bind(env.runner);
		vi.spyOn(env.runner, "runTurn").mockImplementationOnce(async (options) => {
			const emit = options.onEvent!;
			for (let i = 1; i <= 6; i++)
				emit({ type: "tool_start", toolCallId: `t${i}`, name: "task", args: { prompt: `p${i}` } });
			// Only the first five are admitted immediately.
			for (let i = 1; i <= 5; i++) emit({ type: "tool_running", toolCallId: `t${i}` });
			queuedSnapshot = seen.at(-1);
			// The 6th is admitted only now — its stamp must move.
			emit({ type: "tool_running", toolCallId: "t6" });
			upgradedSnapshot = seen.at(-1);
			for (let i = 1; i <= 6; i++) {
				emit({
					type: "tool_settled",
					result: {
						toolCallId: `t${i}`,
						toolName: "task",
						content: `R${i}`,
						isError: false,
						durationMs: 100 * i,
					},
				});
				emit({
					type: "tool_end",
					result: {
						toolCallId: `t${i}`,
						toolName: "task",
						content: `R${i}`,
						isError: false,
						durationMs: 100 * i,
					},
				});
			}
			return original(options);
		});
		await settle();
		env.terminal.data("fan out\r");
		await waitUntil(() => env.transcript.completedLines().join().includes("done"));
		await settle();
		// Queued phase (13b, the wave-red assertion): all six rows exist — the
		// 6th is visible AND flagged queued; the first five are running.
		const queuedRows = (queuedSnapshot?.agents ?? []).filter((a) => a.taskToolId !== "");
		expect(queuedRows.map((a) => a.taskToolId)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
		expect(queuedRows.filter((a) => a.queued === true).map((a) => a.taskToolId)).toEqual(["t6"]);
		// Upgrade phase: the 6th row loses the flag; its stamp moved (>= the
		// admission moment — not the pre-issue moment). The five siblings keep
		// their original stamps (tool_running for an already-running row is a
		// no-op by the queued guard).
		const upgradedRows = (upgradedSnapshot?.agents ?? []).filter((a) => a.taskToolId !== "");
		expect(upgradedRows.every((a) => a.queued !== true)).toBe(true);
		const q6 = queuedRows.find((a) => a.taskToolId === "t6");
		const u6 = upgradedRows.find((a) => a.taskToolId === "t6");
		expect(q6).toBeDefined();
		expect(u6).toBeDefined();
		if (q6 !== undefined && u6 !== undefined) expect(u6.startedAtMs).toBeGreaterThanOrEqual(q6.startedAtMs);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("#sliding-window: renderActivity paints `└─ queued` and omits the closing suffix for queued calls (test 12)", async () => {
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink({});
		const noop = (): void => {};
		const shell = new TuiShell({
			transcript,
			terminal,
			onLine: noop,
			onInterrupt: noop,
			onEof: noop,
			onDequeue: noop,
			onCycleThinking: noop,
			onToggleThinking: noop,
			onModelSelect: noop,
		});
		shell.start();
		const liveRows = new Map<string, readonly string[]>();
		const suffixes = new Map<string, string>();
		transcript.setCallLiveRows = (key, rows) => liveRows.set(key, rows ?? []);
		transcript.setCallSuffix = (key, text) => {
			if (text === null) suffixes.delete(key);
			else suffixes.set(key, text);
		};
		shell.setActivity({
			phase: "working",
			tools: [
				{ id: "a", name: "task", label: "running one", startedAtMs: Date.now() - 4000 },
				{ id: "b", name: "task", label: "queued one", startedAtMs: Date.now(), queued: true },
			],
			agents: [
				{
					agent: "scout",
					task: "job a",
					taskToolId: "a",
					cwd: null,
					lastTool: null,
					toolCount: 0,
					startedAtMs: Date.now() - 4000,
				},
				{
					agent: "scout",
					task: "job b",
					taskToolId: "b",
					cwd: null,
					lastTool: null,
					toolCount: 0,
					startedAtMs: Date.now(),
					queued: true,
				},
			],
		});
		await settle(30); // first paint (16ms render interval), like the M10 B tests
		// Task live rows are pushed to the call's fold via the resolver channel
		// (this bare shell has no folds, so assert on the pushed payloads):
		// the queued parent renders the `└─ queued` caption, NOT `└─ pending`.
		expect(liveRows.get("a")?.[0]).toContain("└─ pending");
		expect(liveRows.get("b")?.[0]).toContain("└─ queued");
		expect(liveRows.get("b")?.[0]).not.toContain("└─ pending");
		// The queued call gets NO closing suffix; the running one does.
		expect(suffixes.has("a")).toBe(true);
		expect(suffixes.has("b")).toBe(false);
		shell.close();
		await shell.whenSettled();
	});

	it("#readonly-parallel: a real-named read row derives queued from the roster flag and upgrades on tool_running (design §4.8, runTurn-mock)", async () => {
		// The tap's non-task derivation (queued ← getTool(name).concurrencySafe)
		// is live code this batch activates. Drive it with the REAL tool name
		// "read" — 6 read calls, 5 admitted, the 6th queued then upgraded.
		const env = await startTuiRepl([reply("done")]);
		const seen: Parameters<TuiShell["setActivity"]>[0][] = [];
		const realSetActivity = TuiShell.prototype.setActivity;
		const spy = vi.spyOn(TuiShell.prototype, "setActivity").mockImplementation(function (
			this: TuiShell,
			snapshot,
		) {
			seen.push(snapshot);
			realSetActivity.call(this, snapshot);
		});
		onTestFinished(() => spy.mockRestore());
		let queuedSnapshot: Parameters<TuiShell["setActivity"]>[0] | undefined;
		let upgradedSnapshot: Parameters<TuiShell["setActivity"]>[0] | undefined;
		const original = env.runner.runTurn.bind(env.runner);
		vi.spyOn(env.runner, "runTurn").mockImplementationOnce(async (options) => {
			const emit = options.onEvent!;
			for (let i = 1; i <= 6; i++)
				emit({ type: "tool_start", toolCallId: `r${i}`, name: "read", args: { path: `f${i}` } });
			for (let i = 1; i <= 5; i++) emit({ type: "tool_running", toolCallId: `r${i}` });
			queuedSnapshot = seen.at(-1);
			emit({ type: "tool_running", toolCallId: "r6" });
			upgradedSnapshot = seen.at(-1);
			for (let i = 1; i <= 6; i++) {
				const result = {
					toolCallId: `r${i}`,
					toolName: "read",
					content: `R${i}`,
					isError: false,
					durationMs: 100 * i,
				};
				emit({ type: "tool_settled", result });
				emit({ type: "tool_end", result });
			}
			return original(options);
		});
		await settle();
		env.terminal.data("fan out reads\r");
		await waitUntil(() => env.transcript.completedLines().join().includes("done"));
		await settle();
		// The roster flag drove the queued derivation on the TOOLS channel:
		// exactly the 6th row carries queued === true in the pre-admission snap.
		const queuedRows = queuedSnapshot?.tools ?? [];
		expect(queuedRows.map((t) => t.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
		expect(queuedRows.filter((t) => t.queued === true).map((t) => t.id)).toEqual(["r6"]);
		// After admission nobody is queued.
		expect((upgradedSnapshot?.tools ?? []).every((t) => t.queued !== true)).toBe(true);
	});

	it("#readonly-parallel: a middle refusal stays queued until the straggler settles — pinned drift (design §4.9/§5.4)", async () => {
		// Shape: [gated straggler r1, refused middle r2 (invalid read args),
		// trailing safe r3]. The refusal settles in phase 1 (settled[1] now),
		// but its tool_end is held by the cursor behind r1; until then its
		// row shows queued. Accepted-and-documented drift (sliding-window
		// §3.6.1); this pins it so a future change is conscious.
		const env = await startTuiRepl([reply("done")]);
		const seen: Parameters<TuiShell["setActivity"]>[0][] = [];
		const realSetActivity = TuiShell.prototype.setActivity;
		const spy = vi.spyOn(TuiShell.prototype, "setActivity").mockImplementation(function (
			this: TuiShell,
			snapshot,
		) {
			seen.push(snapshot);
			realSetActivity.call(this, snapshot);
		});
		onTestFinished(() => spy.mockRestore());
		const original = env.runner.runTurn.bind(env.runner);
		vi.spyOn(env.runner, "runTurn").mockImplementationOnce(async (options) => {
			const emit = options.onEvent!;
			// All three pre-issued; the middle one will be refused by the loop
			// (validation), never admitted (no tool_running).
			emit({ type: "tool_start", toolCallId: "r1", name: "read", args: { path: "a" } });
			emit({ type: "tool_start", toolCallId: "r2", name: "read", args: { path: "b", offset: -1 } });
			emit({ type: "tool_start", toolCallId: "r3", name: "read", args: { path: "c" } });
			emit({ type: "tool_running", toolCallId: "r1" });
			emit({ type: "tool_running", toolCallId: "r3" });
			await settle(30);
			// Straggler settles → the prefix (r1, refused r2, r3) flushes.
			const mk = (id: string, content: string, isError: boolean) => ({
				toolCallId: id,
				toolName: "read",
				content,
				isError,
			});
			emit({ type: "tool_settled", result: mk("r1", "A", false) });
			emit({ type: "tool_end", result: mk("r1", "A", false) });
			emit({
				type: "tool_end",
				result: mk("r2", "Error: offset must be a positive safe integer (1-indexed), got -1", true),
			});
			emit({ type: "tool_settled", result: mk("r3", "C", false) });
			emit({ type: "tool_end", result: mk("r3", "C", false) });
			return original(options);
		});
		await settle();
		env.terminal.data("mixed reads\r");
		await waitUntil(() => env.transcript.completedLines().join().includes("done"));
		// THE PIN: while the straggler held the cursor, the refused middle row
		// displayed queued (it never gets a tool_running). Captured via the
		// activity snapshot inside the mock.
		const snapshot = seen.find(
			(snap) =>
				snap.tools.some((t) => t.id === "r2" && t.queued === true) &&
				snap.tools.some((t) => t.id === "r1" && t.queued !== true),
		);
		expect(snapshot, "middle refusal was queued while the straggler ran").toBeDefined();
	});

	it("#readonly-parallel: queued NON-task tool rows paint `└─ queued` (live row), running ones keep the suffix (design §4.8)", async () => {
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink({});
		const noop = (): void => {};
		const shell = new TuiShell({
			transcript,
			terminal,
			onLine: noop,
			onInterrupt: noop,
			onEof: noop,
			onDequeue: noop,
			onCycleThinking: noop,
			onToggleThinking: noop,
			onModelSelect: noop,
		});
		shell.start();
		const liveRows = new Map<string, readonly string[]>();
		const suffixes = new Map<string, string>();
		transcript.setCallLiveRows = (key, rows) => liveRows.set(key, rows ?? []);
		transcript.setCallSuffix = (key, text) => {
			if (text === null) suffixes.delete(key);
			else suffixes.set(key, text);
		};
		shell.setActivity({
			phase: "working",
			tools: [
				{ id: "a", name: "read", label: "reading a", startedAtMs: Date.now() - 4000 },
				{ id: "f", name: "read", label: "sixth read", startedAtMs: Date.now(), queued: true },
			],
			agents: [],
		});
		await settle(30);
		// The queued non-task row renders via the LIVE-ROW channel (task-row
		// precedent) — NOT a closing suffix; the running row keeps its suffix.
		expect(liveRows.get("f")?.[0]).toBe("└─ queued");
		expect(suffixes.has("f")).toBe(false);
		expect(suffixes.has("a")).toBe(true);
		expect(liveRows.has("a")).toBe(false); // running non-task rows never enter live rows
		shell.close();
		await shell.whenSettled();
	});

	it("#readonly-parallel: queued rows survive an open picker (D10 exemption), running suffixes stay suppressed (design §4.9b)", async () => {
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink({});
		const noop = (): void => {};
		const shell = new TuiShell({
			transcript,
			terminal,
			onLine: noop,
			onInterrupt: noop,
			onEof: noop,
			onDequeue: noop,
			onCycleThinking: noop,
			onToggleThinking: noop,
			onModelSelect: noop,
		});
		shell.start();
		const liveRows = new Map<string, readonly string[]>();
		const suffixes = new Map<string, string>();
		transcript.setCallLiveRows = (key, rows) => liveRows.set(key, rows ?? []);
		transcript.setCallSuffix = (key, text) => {
			if (text === null) suffixes.delete(key);
			else suffixes.set(key, text);
		};
		// Simulate an open picker the same way production opens one: an
		// unresolved select() holds the selector until Enter/Esc.
		const pick = shell.select({ title: "pick", items: [{ label: "x" }] });
		await settle(30);
		shell.setActivity({
			phase: "working",
			tools: [
				{ id: "a", name: "read", label: "reading a", startedAtMs: Date.now() - 4000 },
				{ id: "f", name: "read", label: "sixth read", startedAtMs: Date.now(), queued: true },
			],
			agents: [],
		});
		await settle(30);
		// D10: no `running` claim while the picker is open — the running row's
		// suffix is suppressed. The queued row makes no such claim and stays.
		expect(suffixes.has("a")).toBe(false);
		expect(liveRows.get("f")?.[0]).toBe("└─ queued");
		shell.close(); // close() settles the open selector
		await Promise.allSettled([pick, shell.whenSettled()]);
	});

	it("#tool-settle: a settled call clears its row and renders its result before the chunk ends", async () => {
		const env = await startTuiRepl([reply("done")]);
		// Observe the activity snapshots the shell receives (the region's own
		// rendering is differential and not a stable assertion surface).
		const seen: Parameters<TuiShell["setActivity"]>[0][] = [];
		const realSetActivity = TuiShell.prototype.setActivity;
		const spy = vi.spyOn(TuiShell.prototype, "setActivity").mockImplementation(function (
			this: TuiShell,
			snapshot,
		) {
			seen.push(snapshot);
			realSetActivity.call(this, snapshot);
		});
		// Restore even when an assertion fails, or the spy leaks into the sibling
		// test and stacks a second wrapper on the already-mocked method.
		onTestFinished(() => spy.mockRestore());
		const lastAgents = (): string[] => (seen.at(-1)?.agents ?? []).map((a) => a.taskToolId);
		const original = env.runner.runTurn.bind(env.runner);
		// Captured inside the run and asserted below: an assertion thrown inside the
		// mocked runTurn is swallowed by the REPL and surfaces as a downstream
		// waitUntil timeout, hiding the real cause (code-review finding 3).
		let mid: { agents: string[]; folds: [string, string][]; rendered: string } | undefined;
		let starts: string[] | undefined;
		let childFolds: [number, number] | undefined;
		vi.spyOn(env.runner, "runTurn").mockImplementationOnce(async (options) => {
			const emit = options.onEvent!;
			for (const id of ["t1", "t2"])
				emit({ type: "tool_start", toolCallId: id, name: "task", args: { agent: "scout", prompt: id } });
			starts = lastAgents();
			const t2 = {
				toolCallId: "t2",
				toolName: "task",
				content: "TWO-RESULT",
				isError: false,
				durationMs: 2100,
			};
			// A child-sourced settle must be inert (top-level only): it may not
			// reach the transcript, and it may not touch the child's call record.
			const childInfo = { sourceId: "child-src", taskToolCallId: "t1" };
			emit(
				{ type: "tool_start", toolCallId: "child-1", name: "child_tool", args: { value: "x" } },
				childInfo,
			);
			childFolds = [env.transcript.toolFolds.length, env.transcript.toolFolds.length];
			emit(
				{
					type: "tool_settled",
					result: { toolCallId: "child-1", toolName: "child_tool", content: "CHILD-OUT", isError: false },
				},
				childInfo,
			);
			childFolds[1] = env.transcript.toolFolds.length;
			// t2 settles while t1 is still running.
			emit({ type: "tool_settled", result: t2 });
			const foldsAfterSettle = env.transcript.toolFolds.map(
				(f) => [f.block.id, f.block.kind] as [string, string],
			);
			await settle();
			mid = {
				agents: lastAgents(),
				folds: foldsAfterSettle,
				rendered: stripAnsi(env.transcript.render(80).join("\n")),
			};
			// The authoritative tool_end repeats nothing.
			emit({ type: "tool_end", result: t2 });
			emit({
				type: "tool_end",
				result: { toolCallId: "t1", toolName: "task", content: "ONE-RESULT", isError: false },
			});
			return original(options);
		});
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.transcript.completedLines().join().includes("done"));
		await settle();
		// t2's own runtime and result rendered while t1 was still running; only
		// t1's row survived the settle.
		expect(starts).toEqual(["t1", "t2"]);
		expect(mid?.folds).toEqual([
			["t1", "input"],
			["t2", "input"],
			["t2", "output"],
		]);
		expect(mid?.rendered).toContain("2.1s");
		expect(mid?.rendered).toContain("TWO-RESULT");
		expect(mid?.agents).toEqual(["t1"]);
		// The child-sourced settle added no fold (the child's start never reaches
		// the transcript, so an inert settle is the only reason nothing appeared).
		expect(childFolds?.[1]).toBe(childFolds?.[0]);
		expect(env.transcript.toolFolds.some((f) => f.block.id === "child-1")).toBe(false);
		// One marker and one result per call after the authoritative tool_ends.
		expect(env.transcript.toolFolds.map((f) => [f.block.id, f.block.kind])).toEqual([
			["t1", "input"],
			["t2", "input"],
			["t2", "output"],
			["t1", "output"],
		]);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("#tool-settle: a non-task concurrency-safe row is cleared by its own settle", async () => {
		const env = await startTuiRepl([reply("done")]);
		const seen: Parameters<TuiShell["setActivity"]>[0][] = [];
		const realSetActivity = TuiShell.prototype.setActivity;
		const spy = vi.spyOn(TuiShell.prototype, "setActivity").mockImplementation(function (
			this: TuiShell,
			snapshot,
		) {
			seen.push(snapshot);
			realSetActivity.call(this, snapshot);
		});
		// Restore even when an assertion fails, or the spy leaks into the sibling
		// test and stacks a second wrapper on the already-mocked method.
		onTestFinished(() => spy.mockRestore());
		const lastTools = (): string[] => (seen.at(-1)?.tools ?? []).map((t) => t.id);
		const original = env.runner.runTurn.bind(env.runner);
		let mid: string[] | undefined;
		let starts: string[] | undefined;
		vi.spyOn(env.runner, "runTurn").mockImplementationOnce(async (options) => {
			const emit = options.onEvent!;
			emit({ type: "tool_start", toolCallId: "h1", name: "held", args: { message: "x" } });
			starts = lastTools();
			emit({
				type: "tool_settled",
				result: { toolCallId: "h1", toolName: "held", content: "H1", isError: false },
			});
			mid = lastTools();
			emit({
				type: "tool_end",
				result: { toolCallId: "h1", toolName: "held", content: "H1", isError: false },
			});
			return original(options);
		});
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.transcript.completedLines().join().includes("done"));
		await settle();
		// The plain (non-task) row is deleted by the settle arm, not only the task
		// branch — the reason the two events share one condition.
		expect(starts).toEqual(["h1"]);
		expect(mid).toEqual([]);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("each concurrent task's live rows sit under its own header in launch order", async () => {
		const child: Tool = {
			name: "child_tool",
			description: "test",
			parameters: Type.Object({}),
			execute: async () => ({ output: "unused" }),
		};
		const env = await startTuiRepl([reply("done")], { tools: [child] });
		const original = env.runner.runTurn.bind(env.runner);
		const g = gate();
		vi.spyOn(env.runner, "runTurn").mockImplementationOnce(async (options) => {
			const emit = options.onEvent!;
			for (const p of [
				{ id: "p1", prompt: "PROMPT-ONE" },
				{ id: "p2", prompt: "PROMPT-TWO" },
				{ id: "p3", prompt: "PROMPT-THREE" },
			])
				emit({
					type: "tool_start",
					toolCallId: p.id,
					name: "task",
					args: { agent: "scout", prompt: p.prompt },
				});
			const start = (value: string) => ({
				type: "tool_start" as const,
				toolCallId: `call-${value}`,
				name: "child_tool",
				args: { value },
			});
			const info = (source: string, parent: string) => ({
				sourceId: source,
				taskToolCallId: parent,
				agent: "scout",
				cwd: "/x",
			});
			// Child events arrive TWO, ONE, THREE — deliberately not launch order.
			emit(start("two"), info("s2", "p2"));
			emit(start("one"), info("s1", "p1"));
			emit(start("three"), info("s3", "p3"));
			await g.promise;
			return original(options);
		});
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => stripAnsi(env.terminal.frameSince(0)).includes("pending #"));
		await settle();
		const mark = env.terminal.writes.length;
		env.terminal.resize(110);
		await settle();
		const lines = stripAnsi(env.terminal.frameSince(mark))
			.split("\n")
			.map((line) => line.trimEnd());
		// Each header is immediately followed by its OWN rows, in launch order.
		for (const [prompt, discriminator] of [
			["PROMPT-ONE", "#1.1"],
			["PROMPT-TWO", "#2.1"],
			["PROMPT-THREE", "#3.1"],
		] as const) {
			const header = lines.findIndex((line) => line.startsWith("\u25cf task") && line.includes(prompt));
			expect(header).toBeGreaterThanOrEqual(0);
			expect(lines[header + 1]).toContain(`pending ${discriminator}`);
			expect(lines[header + 2]).toContain(prompt);
		}
		g.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("done"));
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("replaying a stored task call creates folds but never live rows", async () => {
		const env = await startTuiRepl([reply("ok")], {
			seed: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "task", arguments: { agent: "scout", prompt: "explore" } }],
					"tool_use",
				),
				{
					role: "toolResult",
					results: [{ toolCallId: "t1", toolName: "task", content: "child answer", isError: false }],
				},
			],
		});
		await settle();
		expect(env.transcript.toolFolds.some((fold) => fold.block.name === "task")).toBe(true);
		expect(stripAnsi(env.terminal.frameSince(0))).not.toContain("pending #");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("replaying a stored tool call creates folds but never live rows (#tool-inline-live-rows)", async () => {
		const env = await startTuiRepl([reply("ok")], {
			seed: [
				assistant(
					[{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo saved" } }],
					"tool_use",
				),
				{
					role: "toolResult",
					results: [{ toolCallId: "b1", toolName: "bash", content: "saved output", isError: false }],
				},
			],
		});
		await settle();
		expect(env.transcript.toolFolds.some((fold) => fold.block.name === "bash")).toBe(true);
		expect(stripAnsi(env.terminal.frameSince(0))).not.toMatch(/echo saved \d+s/);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("cancels emitted calls in place and rejects abandoned run events after clear and id reuse", async () => {
		const env = await startTuiRepl([reply("next epoch")]);
		const original = env.runner.runTurn.bind(env.runner);
		let late: (() => void) | undefined;
		const spy = vi.spyOn(env.runner, "runTurn").mockImplementationOnce(async (options) => {
			const emit = options.onEvent!;
			emit({ type: "tool_start", toolCallId: "reuse", name: "task", args: { prompt: "cancel this" } });
			late = () =>
				emit({
					type: "tool_end",
					result: { toolCallId: "reuse", toolName: "task", content: "stale result", isError: false },
				});
			await new Promise<void>((resolve) =>
				options.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw new Error("interrupted test run");
		});
		env.terminal.data("go\r");
		await waitUntil(() => env.transcript.toolFolds.length === 1);
		const fold = env.transcript.toolFolds[0]!;
		env.terminal.data("\x0f");
		await waitUntil(() => fold.isExpanded());
		env.terminal.data("\x1bo");
		await settle();
		env.terminal.data("\x03");
		await waitUntil(() => fold.block.title.includes("interrupted"));
		expect(env.transcript.toolFolds).toEqual([fold]);
		expect(fold.isExpanded()).toBe(true);
		expect(stripAnsi(fold.render(80).join("\n"))).toContain("interrupted (no result)");
		env.transcript.clear();
		env.transcript.toolSink.start("reuse", "task", { prompt: "new epoch" });
		late?.();
		expect(env.transcript.toolFolds.map((f) => f.block.kind)).toEqual(["input"]);
		expect(env.transcript.toolFolds[0]!.block.title).not.toContain("interrupted");
		spy.mockImplementation(original);
		env.terminal.data("next\r");
		await waitUntil(() => env.transcript.completedLines().join().includes("next epoch"));
		late?.();
		expect(env.transcript.toolFolds).toHaveLength(1);
		env.terminal.data("/exit\r");
		await env.repl;
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
	it("a running tool's live row sits in its own fold; the ✓/⎿ completion follows", async () => {
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
		const pending = stripAnsi(env.terminal.frameSince(0));
		expect(pending).toMatch(/(?<![.\dm])\d+s/); // #call-closing-status: the fold's closing slot
		expect(pending).toContain("●"); // immediate inspectable input fold
		expect(env.transcript.toolFolds.map((f) => f.block.kind)).toEqual(["input"]);
		const mark = env.terminal.writes.length;
		g.resolve();
		// M11: success results fold — the ⎿ preview is replaced by a ▸ fold title
		await waitUntil(() =>
			env.transcript.toolFolds.some((f) => f.block.name === "gated" && f.block.kind === "output"),
		);
		await settle();
		// one-frame handoff: the live row is gone and the call row carries ✓
		const after = stripAnsi(env.terminal.frameSince(mark));
		expect(after).not.toMatch(/(?<![.\dm])\d+s/);
		expect(after).toContain("✓");
		const stream = env.transcript.completedLines().join("\n");
		expect(env.transcript.toolFolds.map((f) => f.block.kind)).toEqual(["input", "output"]);
		expect(stream).not.toContain("⎿"); // M11: folded — the preview moved to the fold title
		expect(env.terminal.frameSince(0)).toContain("⎿"); // the fold itself
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("aborting a running tool clears its live row (real run)", async () => {
		const g = gate();
		const slow: Tool = {
			name: "slow",
			description: "resolves on the gate or abort",
			parameters: Type.Object({}),
			async execute(_args, signal) {
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
					void g.promise.then(() => resolve());
				});
				return { output: "done-after-abort" };
			},
		};
		const env = await startTuiRepl(
			[assistant([{ type: "toolCall", id: "s1", name: "slow", arguments: {} }], "tool_use"), reply("after")],
			{ tools: [slow] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => /\b\d+s\b/.test(stripAnsi(env.terminal.frameSince(0))));
		const mark = env.terminal.writes.length;
		env.terminal.data("\x1b"); // Esc aborts the turn; the tool resolves on the signal
		// positive control: the post-abort fold paints (the result can never be skipped silently)
		await waitUntil(() => stripAnsi(env.terminal.frameSince(mark)).includes("done-after-abort"), 8000);
		await settle(30);
		expect(stripAnsi(env.terminal.frameSince(mark))).not.toMatch(/(?<![.\dm])\d+s/);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("a reused tool_call id within one run never paints a live row (e2e, #tool-inline-live-rows)", async () => {
		const first = gate();
		const second = gate();
		let calls = 0;
		const held: Tool = {
			name: "held",
			description: "held",
			parameters: Type.Object({ n: Type.Number() }),
			async execute() {
				calls++;
				if (calls === 1) await first.promise;
				else await second.promise;
				return { output: `out${calls}` };
			},
		};
		const env = await startTuiRepl(
			[
				assistant([{ type: "toolCall", id: "dup", name: "held", arguments: { n: 1 } }], "tool_use"),
				assistant([{ type: "toolCall", id: "dup", name: "held", arguments: { n: 2 } }], "tool_use"),
				reply("done"),
			],
			{ tools: [held] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => calls === 1);
		first.resolve();
		await waitUntil(() => calls === 2);
		await settle(400); // several 120ms ticks: a leaked slot would repaint
		expect(stripAnsi(env.transcript.render(80).join("\n"))).not.toMatch(/(?<![.\dm])\d+s/);
		second.resolve();
		await waitUntil(() => env.terminal.frameSince(0).includes("done"));
		// The suppressed duplicate renders no fold of its own (pre-existing sink
		// suppression; this batch only ensures it cannot paint live rows).
		expect(env.transcript.toolFolds.map((f) => f.block.kind)).toEqual(["input", "output"]);
		expect(stripAnsi(env.transcript.render(80).join("\n"))).not.toMatch(/(?<![.\dm])\d+s/);
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

	it("#tui-tool-elapsed: a slow call shows its duration on the call row", async () => {
		const clock = { now: 1_000 };
		const slow: Tool = {
			name: "bash",
			description: "duration stand-in",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				clock.now += 2_300;
				return { output: "ok" };
			},
		};
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "build" } }],
					"tool_use",
				),
				reply("done"),
			],
			{ tools: [slow], clock: () => clock.now },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("done"), 8000);
		await settle();
		expect(env.transcript.toolFolds.find((f) => f.block.kind === "input")?.block.elapsedMs).toBe(2300);
		expect(env.terminal.frameSince(0)).toContain("✓ 2.3s");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("#tui-tool-elapsed: fast calls show the bare ✓; failed calls show the ✗ with the time", async () => {
		const fast: Tool = {
			name: "bash",
			description: "fast stand-in",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				return { output: "ok" };
			},
		};
		const env = await startTuiRepl(
			[
				assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "fast" } }], "tool_use"),
				reply("done"),
			],
			{ tools: [fast], clock: () => 5_000 },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.frameSince(0).includes("done"), 8000);
		await settle();
		// constant clock -> elapsed 0; Amendment 2 keeps this path covered: the
		// update fires and the row carries the bare ✓ with no time text.
		expect(env.transcript.toolFolds.find((f) => f.block.kind === "input")?.block.elapsedMs).toBe(0);
		const callLine = env.terminal
			.frameSince(0)
			.split("\n")
			.find((l) => l.includes("● bash"));
		expect(callLine).toBeTruthy();
		expect(callLine ?? "").toContain("✓");
		expect(callLine ?? "").not.toMatch(/[0-9]/);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);

		const clock = { now: 0 };
		const failing: Tool = {
			name: "bash",
			description: "failing stand-in",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				clock.now += 5_000;
				return { output: "Error: boom", isError: true };
			},
		};
		const env2 = await startTuiRepl(
			[
				assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "fail" } }], "tool_use"),
				reply("done"),
			],
			{ tools: [failing], clock: () => clock.now },
		);
		await settle();
		env2.terminal.data("go\r");
		await waitUntil(() => env2.terminal.frameSince(0).includes("done"), 8000);
		await settle();
		// Amendment 3: the failed call carries the red ✗ and its 5.0s time.
		const failedFold = env2.transcript.toolFolds.find((f) => f.block.kind === "input");
		expect(failedFold?.block.elapsedMs).toBe(5000);
		expect(failedFold?.block.failed).toBe(true);
		const callLine2 = env2.terminal
			.frameSince(0)
			.split("\n")
			.find((l) => l.includes("● bash"));
		expect(callLine2).toBeTruthy();
		expect(callLine2 ?? "").not.toContain("✓");
		expect(callLine2 ?? "").toContain("✗");
		expect(callLine2 ?? "").toContain("5.0s");
		env2.terminal.data("/exit\r");
		await expect(env2.repl).resolves.toBe(0);
	});

	it("#tui-tool-elapsed: replayed history renders no durations", async () => {
		const clock = { now: 10_000 };
		const replayTool: Tool = {
			name: "bash",
			description: "replay stand-in",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				return { output: "ok" };
			},
		};
		const env = await startTuiRepl([], {
			tools: [replayTool],
			// Every clock read advances: a missed replay gate would fabricate a
			// duration from nothing but the read count.
			clock: () => {
				clock.now += 2_000;
				return clock.now;
			},
			seed: [
				assistant(
					[{ type: "toolCall", id: "old", name: "bash", arguments: { command: "saved" } }],
					"tool_use",
				),
				{
					role: "toolResult",
					results: [{ toolCallId: "old", toolName: "bash", content: "saved raw", isError: false }],
				},
			],
		});
		await waitUntil(() => env.transcript.toolFolds.length === 2);
		expect(env.transcript.toolFolds.find((f) => f.block.kind === "input")?.block.elapsedMs).toBeUndefined();
		await waitUntil(
			() =>
				env.terminal
					.frameSince(0)
					.split("\n")
					.some((l) => l.includes("● bash")),
			4000,
		);
		const callLine = env.terminal
			.frameSince(0)
			.split("\n")
			.find((l) => l.includes("● bash"));
		expect(callLine).toBeTruthy();
		expect(callLine ?? "").not.toContain("✓");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("real task shows generic pending input after unknown scout, before child completion", async () => {
		const home = await mkTempDirAsync("ink-task-live-");
		const hold = gate();
		let entered = false;
		const fake: Tool = {
			name: "bash_like",
			description: "offline label only",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				entered = true;
				await hold.promise;
				return { output: "child output" };
			},
		};
		const env = await startTuiRepl(
			[
				assistant(
					[
						{
							type: "toolCall",
							id: "bad",
							name: "task",
							arguments: { agent: "scout", prompt: "old request" },
						},
					],
					"tool_use",
				),
				assistant(
					[{ type: "toolCall", id: "good", name: "task", arguments: { prompt: "inspect current request" } }],
					"tool_use",
				),
				assistant(
					[
						{
							type: "toolCall",
							id: "child",
							name: "bash_like",
							arguments: { command: "long child command ".repeat(100) },
						},
					],
					"tool_use",
				),
				reply("child complete"),
				reply("parent continuation"),
			],
			{ agentsHomeDir: home, tools: [fake] },
		);
		try {
			env.terminal.data("go\r");
			await waitUntil(() => entered, 8000);
			expect(env.transcript.toolFolds.map((f) => [f.block.id, f.block.kind])).toEqual([
				["bad", "input"],
				["bad", "output"],
				["good", "input"],
			]);
			const input = env.transcript.toolFolds[2]!;
			expect(env.transcript.toolFolds[1]!.block.error).toBe(true);
			env.terminal.data("\x0f");
			await waitUntil(() => input.isExpanded());
			expect(stripAnsi(input.render(80).join("\n"))).toContain("inspect current request");
			const mark = env.terminal.writes.length;
			env.terminal.resize(100); // forced full fresh frame, not historical activity
			await settle();
			const frame = env.terminal.frameSince(mark);
			expect(frame).toMatch(/pending #2\.1 task/);
			expect(frame).toContain("inspect current request");
			expect(frame).toContain("1 tool starts · last: bash_like");
			expect(frame).not.toMatch(/pending .*scout/);
			hold.resolve();
			await waitUntil(() => env.transcript.completedLines().join().includes("parent continuation"), 8000);
			expect(env.transcript.toolFolds[2]).toBe(input);
			expect(env.transcript.toolFolds.map((f) => [f.block.id, f.block.kind])).toEqual([
				["bad", "input"],
				["bad", "output"],
				["good", "input"],
				["good", "output"],
			]);
			const endMark = env.terminal.writes.length;
			env.terminal.resize(80);
			await settle();
			expect(env.terminal.frameSince(endMark)).not.toContain("pending #");
		} finally {
			hold.resolve();
			env.terminal.data("/exit\r");
			await env.repl;
		}
	});

	it("a subagent paints a tree row held on screen; it leaves with the task", async () => {
		const agentsHome = await mkTempDirAsync("ink-agents-");
		await mkdir(path.join(agentsHome, ".ink", "agents"), { recursive: true });
		await writeFile(
			path.join(agentsHome, ".ink", "agents", "scout.md"),
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
		expect(env.terminal.frameSince(mark)).not.toContain("pending #"); // the live block left with the task call
		// M11: the task result folds — the report is the fold body/title now
		expect(env.terminal.frameSince(0)).toContain("⎿");
		expect(env.terminal.frameSince(0)).toContain("scout done");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("the task slot timer never resets when the provisional row is replaced (#call-closing-status A1.2)", async () => {
		const agentsHome = await mkTempDirAsync("ink-agents-");
		await mkdir(path.join(agentsHome, ".ink", "agents"), { recursive: true });
		await writeFile(
			path.join(agentsHome, ".ink", "agents", "scout.md"),
			"---\nname: scout\ndescription: test scout\n---\nYou are a test scout.\n",
			"utf-8",
		);
		// The child's first response is HELD so the provisional `task:` row ages
		// untouched; the held child tool then keeps the swapped-in source row on
		// screen while the slot is read.
		const first = gate();
		const tool = gate();
		const env = await startTuiRepl(
			[
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
				() =>
					first.promise.then(() =>
						assistant(
							[{ type: "toolCall", id: "c1", name: "gated", arguments: { message: "slow" } }],
							"tool_use",
						),
					),
				() => tool.promise.then(() => reply("scout done")),
				reply("all done"),
			],
			{ agentsHomeDir: agentsHome, tools: [gatedTool(tool)] },
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => stripAnsi(env.terminal.frameSince(0)).includes("● task"), 8000);
		await settle(1300); // the call's own start ages past one second
		first.resolve(); // the child's first event materializes the source row
		await waitUntil(() => stripAnsi(env.terminal.frameSince(0)).includes("pending #1.1"), 8000);
		await settle(30);
		// The newest slot reading must still measure the CALL's age (>= 1s); a
		// base reset at the swap would paint `0s` here.
		const latest = [
			...stripAnsi(env.terminal.frameSince(0)).matchAll(/● task {2}scout · explore the tree (\d+)s/g),
		];
		expect(Number(latest.at(-1)?.[1])).toBeGreaterThanOrEqual(1);
		tool.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("all done"), 8000);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("no extension leaves call-header names uncolored (#tool-name-colors A1)", async () => {
		const env = await startTuiRepl([
			assistant(
				[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo painted" } }],
				"tool_use",
			),
			reply("painted"),
		]);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => stripAnsi(env.terminal.writes.join("")).includes("echo painted"), 8000);
		const raw = env.terminal.writes.join("");
		// the exact legacy header bytes — no hue anywhere on the name span
		expect(raw).toContain("\u001b[2m●\u001b[0m \u001b[1mbash\u001b[0m  echo painted");
		expect(raw).not.toContain("\u001b[1m\u001b[33mbash");
		expect(raw).not.toContain("\u001b[1m\u001b[96mtask");
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("an extension overrides defaults, a wildcard paints the unlisted tool, none de-colors (#tool-name-colors)", async () => {
		const tool = gate();
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo plain" } }],
					"tool_use",
				),
				assistant(
					[{ type: "toolCall", id: "t2", name: "gated", arguments: { message: "wild" } }],
					"tool_use",
				),
				() => tool.promise.then(() => reply("colored")),
			],
			{
				tools: [gatedTool(tool, "gated")],
				extensionFiles: {
					"hue.mjs": `export default function (api) {
	api.registerToolColor("*", "blue");
	api.registerToolColor("bash", "none");
	api.registerToolColor("gated", "brightCyan");
}
`,
				},
			},
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.writes.join("").includes("\u001b[1m\u001b[96mgated"), 8000);
		const raw = env.terminal.writes.join("");
		expect(raw).toContain("\u001b[1m\u001b[96mgated"); // the exact token beats the wildcard
		expect(raw).toContain("\u001b[1mbash\u001b[0m"); // none → bold-only, no default yellow
		expect(raw).not.toContain("\u001b[1m\u001b[33mbash");
		expect(raw).not.toContain("\u001b[1m\u001b[34mgated");
		tool.resolve();
		await waitUntil(() => stripAnsi(env.terminal.writes.join("")).includes("colored"), 8000);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("absolute tokens paint exact wire bytes (#tool-name-colors A2)", async () => {
		const tool = gate();
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hexed" } }],
					"tool_use",
				),
				assistant([{ type: "toolCall", id: "t2", name: "gated", arguments: { message: "idx" } }], "tool_use"),
				() => tool.promise.then(() => reply("absolute")),
			],
			{
				tools: [gatedTool(tool, "gated")],
				extensionFiles: {
					"hue.mjs": `export default function (api) {
	api.registerToolColor("bash", "#d97757");
	api.registerToolColor("gated", "ansi256:173");
}
`,
				},
			},
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.writes.join("").includes("\u001b[1m\u001b[38;5;173mgated"), 8000);
		const raw = env.terminal.writes.join("");
		expect(raw).toContain("\u001b[1m\u001b[38;2;217;119;87mbash"); // truecolor hex on the wire
		expect(raw).toContain("\u001b[1m\u001b[38;5;173mgated"); // 256-index on the wire
		tool.resolve();
		await waitUntil(() => stripAnsi(env.terminal.writes.join("")).includes("absolute"), 8000);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("author suggestions paint below user registrations (#tool-name-colors A3)", async () => {
		const tool = gate();
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo authored" } }],
					"tool_use",
				),
				assistant(
					[{ type: "toolCall", id: "t2", name: "gated", arguments: { message: "overridden" } }],
					"tool_use",
				),
				() => tool.promise.then(() => reply("tiers")),
			],
			{
				tools: [gatedTool(tool, "gated")],
				extensionFiles: {
					"suggest.mjs": `export default function (api) {
	api.suggestToolColor("bash", "#d97757");
	api.suggestToolColor("gated", "ansi256:173");
}
`,
					"theme.mjs": `export default function (api) {
	api.registerToolColor("gated", "brightCyan");
}
`,
				},
			},
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.writes.join("").includes("\u001b[1m\u001b[96mgated"), 8000);
		const raw = env.terminal.writes.join("");
		expect(raw).toContain("\u001b[1m\u001b[38;2;217;119;87mbash"); // the suggestion paints
		expect(raw).toContain("\u001b[1m\u001b[96mgated"); // the user registration overrides
		expect(raw).not.toContain("\u001b[1m\u001b[38;5;173mgated");
		tool.resolve();
		await waitUntil(() => stripAnsi(env.terminal.writes.join("")).includes("tiers"), 8000);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("the task call takes its hue from the shipped example theme (#tool-name-colors A1)", async () => {
		const agentsHome = await mkTempDirAsync("ink-agents-");
		await mkdir(path.join(agentsHome, ".ink", "agents"), { recursive: true });
		await writeFile(
			path.join(agentsHome, ".ink", "agents", "scout.md"),
			"---\nname: scout\ndescription: test scout\n---\nYou are a test scout.\n",
			"utf-8",
		);
		const tool = gate();
		const env = await startTuiRepl(
			[
				assistant(
					[{ type: "toolCall", id: "t1", name: "task", arguments: { prompt: "explore", agent: "scout" } }],
					"tool_use",
				),
				() => tool.promise.then(() => reply("scout done")),
				reply("all done"),
			],
			{
				agentsHomeDir: agentsHome,
				tools: [gatedTool(tool, "gated")],
				extensionFiles: {
					"tool-colors.mjs": readFileSync(path.resolve("examples/extensions/tool-colors.mjs"), "utf8"),
				},
			},
		);
		await settle();
		env.terminal.data("go\r");
		await waitUntil(() => env.terminal.writes.join("").includes("\u001b[1m\u001b[96mtask"), 8000);
		tool.resolve();
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("all done"), 8000);
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
	});

	it("child edit results never reach the Renderer or fold — zero ⎿, the one ▸ is the task result (P2#3)", async () => {
		const agentsHome = await mkTempDirAsync("ink-agents-");
		await mkdir(path.join(agentsHome, ".ink", "agents"), { recursive: true });
		await writeFile(
			path.join(agentsHome, ".ink", "agents", "scout.md"),
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

	it("debt clearance: error results fold too — the ⎿ failed status stays, expand works", async () => {
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
		const dir = await mkTempDirAsync("ink-hist-e2e-");
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
		await waitUntil(() => env.terminal.frameSince(0).includes("working…"));
		env.terminal.data("\x03");
		// zero-turn aborts skip run stats — the interrupt note plus the restored
		// placeholder (idle marker repaint) are the settle signal
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("(interrupt"), 5000);
		await waitUntil(() => env.terminal.frameSince(0).includes("(/ for commands"), 5000);
		const mark = env.terminal.writes.length;
		env.terminal.data("x"); // editor change → repaint; the row is gone if cleared
		await settle(30);
		expect(env.terminal.frameSince(mark)).not.toContain("working");
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
			const authPath = path.join(await mkTempDirAsync("ink-login-"), "auth.json");
			process.env.INK_AUTH_PATH = authPath;
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
		const baseDir = await mkTempDirAsync("ink-skill-tui-");
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

// ── Phase 3 A1: the approval moment (D10/D11/D12) ────────────────────────

describe("D10 — no live tool rows while a picker is open", () => {
	/** A shell with a running turn: the spinner row AND one tool row on screen. */
	function runningShell() {
		const env = makeShell();
		env.shell.start();
		// #tool-inline-live-rows: the live row addresses the call's own fold, so
		// create it — otherwise the synthetic snapshot renders no row at all.
		env.transcript.toolSink.start("t1", "bash", { command: "echo hi" });
		return env;
	}
	const activity = (): Parameters<TuiShell["setActivity"]>[0] => ({
		phase: "thinking",
		tools: [{ id: "t1", name: "bash", label: "echo hi", startedAtMs: Date.now() }],
		agents: [],
	});

	it("the frame with a confirm picker open holds no running text; the spinner stays and the call header remains", async () => {
		const { terminal, shell } = runningShell();
		await settle(0);
		shell.setActivity(activity());
		await settle(150);
		const before = terminal.frameSince(0);
		expect(before).toMatch(/echo hi \d+s/); // the fold's closing slot really rendered pre-picker
		expect(before).toContain("echo hi"); // the call header (the row itself carries no label)
		shell.forceRender();
		await settle();
		const mark = terminal.writes.length;
		const chosen = shell.select({ title: "approve?", items: [{ label: "Yes" }, { label: "No" }] });
		await settle(150);
		shell.forceRender(); // full repaint: prove the header stays and the row is gone
		await settle();
		const frame = terminal.frameSince(mark);
		expect(frame).toContain("approve?"); // the picker itself is up
		expect(frame).not.toMatch(/echo hi \d+s/); // D10: no false running claim (the slot was pulled)
		expect(frame).toContain("echo hi"); // the call header stays inspectable
		expect(frame).toContain("working…"); // the turn-level spinner is untouched
		terminal.data("\r"); // pick Yes
		await expect(chosen).resolves.toBe(0);
		await settle(150);
		const after = terminal.frameSince(mark);
		expect(after).toMatch(/echo hi \d+s/); // the slot comes back on pick
		shell.close();
	});

	it("#confirm-prompt (Phase 3 D10): the picker's repaint alone clears the live row — <20ms, before the 120ms ticker", async () => {
		const { terminal, shell } = runningShell();
		await settle(0);
		shell.setActivity(activity());
		// Let the live row paint ONCE, then act well inside one 120ms tick so the
		// ticker cannot mask a missing repaint in setSelector (the recorded bug).
		await settle(20);
		expect(terminal.frameSince(0)).toMatch(/echo hi \d+s/);
		void shell.select({ title: "approve?", items: [{ label: "Yes" }] });
		await settle(20); // < the 120ms ticker: only setSelector's own repaint can act
		// Frames are differential — force one full repaint of the CURRENT container
		// tree, still inside the ticker window. If setSelector did not clear the
		// fold's live row, the stale row still renders and this repaint shows it.
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(20);
		const frame = terminal.frameSince(mark);
		expect(frame).toContain("approve?"); // the picker mounted
		expect(frame).not.toMatch(/echo hi \d+s/); // D10 pulled the slot at once
		expect(frame).toContain("echo hi"); // the call header itself stays inspectable
		shell.close();
	});

	it("a picker keeps the task timer ticking while the tool slot is suppressed (#call-closing-status A1.2)", async () => {
		const { terminal, shell, transcript } = makeShell();
		shell.start();
		await settle(0);
		transcript.toolSink.setResolver((name) => (name === "task" ? taskPresentation : undefined));
		transcript.toolSink.start("t1", "bash", { command: "echo hi" });
		transcript.toolSink.start("t9", "task", { agent: "scout", prompt: "explore" });
		shell.setActivity({
			phase: "thinking",
			tools: [{ id: "t1", name: "bash", label: "echo hi", startedAtMs: Date.now() }],
			agents: [
				{
					agent: "scout",
					task: "explore",
					taskToolId: "t9",
					cwd: null,
					lastTool: null,
					toolCount: 0,
					startedAtMs: Date.now(),
				},
			],
		});
		await settle(150);
		const before = stripAnsi(terminal.frameSince(0));
		expect(before).toMatch(/echo hi \d+s/); // the tool slot while no picker
		expect(before).toMatch(/● task {2}scout · explore \d+s/); // the task slot
		shell.forceRender();
		await settle();
		const mark = terminal.writes.length;
		void shell.select({ title: "approve?", items: [{ label: "Yes" }] });
		await settle(150);
		shell.forceRender(); // full repaint: both rows' current state must be visible
		await settle();
		const frame = stripAnsi(terminal.frameSince(mark));
		expect(frame).not.toMatch(/echo hi \d+s/); // the tool slot is suppressed (D10)
		expect(frame).toMatch(/● task {2}scout · explore \d+s/); // the task slot is exempt (A1.2)
		shell.close();
	});

	it("#tool-name-colors: the confirm preview name follows the shell's resolver", async () => {
		const { terminal, shell } = makeShell({
			toolColorResolver: (name) => (name === "bash" ? "yellow" : undefined),
		});
		shell.start();
		await settle(0);
		const chosen = shell.select({
			title: "allow?",
			preview: { kind: "command", tool: "bash", text: "rm -rf x" },
			items: [{ label: "Yes" }],
		});
		await settle();
		const raw = terminal.writes.join("");
		expect(raw).toContain("\u001b[2m●\u001b[0m \u001b[1m\u001b[33mbash\u001b[0m  rm -rf x");
		terminal.data("\r");
		await expect(chosen).resolves.toBe(0);
		shell.close();
	});

	it("Esc restores the running timer", async () => {
		const { terminal, shell } = runningShell();
		await settle(0);
		shell.setActivity(activity());
		await settle(150);
		const mark = terminal.writes.length;
		void shell.select({ title: "approve?", items: [{ label: "Yes" }] });
		await settle(150);
		expect(terminal.frameSince(mark)).not.toMatch(/echo hi \d+s/);
		terminal.data("\x1b"); // Esc cancels
		await settle(150);
		expect(terminal.frameSince(mark)).toMatch(/echo hi \d+s/);
		shell.close();
	});

	it("Ctrl+C restores the running timer", async () => {
		const { terminal, shell } = runningShell();
		await settle(0);
		shell.setActivity(activity());
		await settle(150);
		const mark = terminal.writes.length;
		void shell.select({ title: "approve?", items: [{ label: "Yes" }] });
		await settle(150);
		expect(terminal.frameSince(mark)).not.toMatch(/echo hi \d+s/);
		terminal.data("\x03"); // Ctrl+C aborts
		await settle(150);
		expect(terminal.frameSince(mark)).toMatch(/echo hi \d+s/);
		shell.close();
	});

	it("a denied gate answers the picker and leaves no running timer (same-chain clear)", async () => {
		const { terminal, shell } = runningShell();
		await settle(0);
		shell.setActivity(activity());
		const denied = shell.select({ title: "approve?", items: [{ label: "Yes" }, { label: "No" }] });
		await settle(150); // picker open: the row is suppressed
		const mark = terminal.writes.length;
		terminal.data("2"); // quick-pick: No (denied)
		// The production chain: the picker's close repaints (the row would reappear)
		// and the blocked tool_end lands in the same event chain, before any 16ms
		// paint — the final state may never carry a running row.
		shell.setActivity({ phase: "working", tools: [], agents: [] });
		await expect(denied).resolves.toBe(1); // the denial really answered the picker
		shell.forceRender(); // full repaint of the final state (a leaked row would show)
		await settle(30);
		const frame = stripAnsi(terminal.frameSince(mark));
		expect(frame).not.toMatch(/echo hi \d+s/);
		expect(frame).not.toContain("approve?"); // the picker is gone too
		shell.close();
	});

	it("close() tears the picker down and the rows are gone with the shell (no stale rows)", async () => {
		const { terminal, shell } = runningShell();
		await settle(0);
		shell.setActivity(activity());
		await settle(150);
		void shell.select({ title: "approve?", items: [{ label: "Yes" }] });
		await settle(150);
		shell.close();
		await settle(60);
		// close() idles the activity and tears the picker down; nothing hangs.
		expect(terminal.frameSince(0)).toContain("approve?");
	});
});

// #confirm-prompt (Phase 4 D14): the D11 blank row stays, and the rule is
// inserted between it and the title — the row above the title is now the
// rule, not the blank. Layout: blank → rule → title.
describe("D11/D14 — a blank row and a rule before a picker box", () => {
	it("the generic picker strips blank → rule → title", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		void shell.select({ title: "pick a model", items: [{ label: "alpha" }] });
		await settle(150);
		const lines = terminal.frameSince(0).split("\n");
		const titleAt = lines.findIndex((l) => l.trim() === "pick a model");
		expect(titleAt).toBeGreaterThan(1);
		expect(lines[titleAt - 1]).toBe("─".repeat(80)); // D14: the unlabeled rule
		expect(lines[titleAt - 2]?.trim()).toBe(""); // D11: a blank row precedes the rule
		shell.close();
	});

	it("the login dialog leaves an empty row between the transcript and its title (no host rule added)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		const mark = terminal.writes.length;
		void shell.openLoginDialog({ title: "Login to Z.AI", run: () => new Promise<void>(() => {}) });
		await settle(150);
		const lines = terminal.frameSince(mark).split("\n");
		const titleAt = lines.findIndex((l) => l.includes("Login to Z.AI"));
		expect(titleAt).toBeGreaterThan(1);
		// the dialog opens with a border rule, then the title — the blank row
		// D11 adds sits directly above that rule.
		expect(lines[titleAt - 1]).toContain("─");
		expect(lines[titleAt - 2]?.trim()).toBe("");
		// D14: the login dialog gets nothing new — it still renders exactly its
		// own two DialogBorder rows (dim; the editor box's plain rules are the
		// only other `─` rows in this frame).
		const dimRule = `\x1b[2m${"─".repeat(80)}\x1b[0m`;
		const raw = terminal.writes.slice(mark).join("");
		const dimRules = raw.split(dimRule).length - 1;
		expect(dimRules).toBe(2);
		shell.close();
	});

	it("the session tree gets an unlabeled rule between the blank row and the box", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		void shell.treeSelect({
			title: "session tree title",
			roots: [
				{
					entry: {
						type: "message",
						id: "e1",
						parentId: null,
						timestamp: new Date().toISOString(),
						message: { role: "user", content: "hello" },
					},
					children: [],
				},
			],
			leafId: "e1",
		});
		await settle(150);
		const lines = terminal.frameSince(0).split("\n");
		const titleAt = lines.findIndex((l) => l.includes("session tree title"));
		expect(titleAt).toBeGreaterThan(1);
		expect(lines[titleAt - 1]).toBe("─".repeat(80)); // D14: the unlabeled tree rule
		expect(lines[titleAt - 2]?.trim()).toBe(""); // D11: a blank row precedes the rule
		shell.close();
	});

	it("a titleless picker still gains an unlabeled rule above its first row", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		void shell.select({ items: [{ label: "alpha" }, { label: "beta" }] });
		await settle(150);
		const lines = terminal.frameSince(0).split("\n");
		const firstRowAt = lines.findIndex((l) => l.includes("alpha"));
		expect(firstRowAt).toBeGreaterThan(1);
		// D14: the rule is unconditional — even a titleless picker gets it. The
		// picker's own blank row (Phase 1 D5, above the numbered items) sits
		// between the rule and the first row.
		expect(lines[firstRowAt - 1]?.trim()).toBe("");
		expect(lines[firstRowAt - 2]).toBe("─".repeat(80));
		shell.close();
	});
});

// #confirm-prompt (Phase 4 D14): the rule component in isolation — exact
// bytes, the narrow/empty fallbacks, and the width contract.
describe("D14 — SectionRule render contract", () => {
	it("an absent or empty label renders plain dim dashes", () => {
		expect(new SectionRule().render(10)).toEqual([`\x1b[2m${"─".repeat(10)}\x1b[0m`]);
		expect(new SectionRule("").render(10)).toEqual([`\x1b[2m${"─".repeat(10)}\x1b[0m`]);
	});

	it("a labeled rule is four dim dashes, a yellow label, then dim dashes", () => {
		// A2.1 left-anchored, A2.2 nudged right, A2.3 accent. width 20, label
		// "tui": LEAD_DASHES(4) + 1 + 3 + 1 + right(11) = 20
		const row = new SectionRule("tui").render(20)[0] ?? "";
		expect(row).toBe(`\x1b[2m────\x1b[0m \x1b[33mtui\x1b[0m \x1b[2m${"─".repeat(11)}\x1b[0m`);
	});

	it("a label wider than avail is clipped, and a full row ends after the label", () => {
		// avail = 20 - 6 = 14: truncateToWidth clips the label to 14 (11 'a' + "...";
		// its own resets ride inside), so right = 0: the row ends after the label's
		// trailing space, with no closing dashes (A2.1, §16.13 N1). The accent adds
		// its own closing reset after the clipped label's, hence the doubled
		// `\x1b[0m` before the trailing space.
		const row = new SectionRule("a".repeat(60)).render(20)[0] ?? "";
		expect(row).toBe(`\x1b[2m────\x1b[0m \x1b[33m${"a".repeat(11)}\x1b[0m...\x1b[0m\x1b[0m `);
		expect(visibleWidth(row)).toBe(20);
	});

	it("a sanitized escape is stripped from the label", () => {
		const row = new SectionRule("\x1b[31mred\x1b[1m").render(20)[0] ?? "";
		expect(row).not.toContain("\x1b[31m");
		expect(row).not.toContain("\x1b[1m");
		// A2.3: the accent wraps the sanitized plain text
		expect(row).toContain("\x1b[33mred\x1b[0m");
	});

	it("avail < 2 falls back to plain dashes (width 7 and below)", () => {
		expect(new SectionRule("tui").render(7)).toEqual([`\x1b[2m${"─".repeat(7)}\x1b[0m`]);
		expect(new SectionRule("tui").render(4)).toEqual([`\x1b[2m${"─".repeat(4)}\x1b[0m`]);
		expect(new SectionRule("tui").render(1)).toEqual([`\x1b[2m─\x1b[0m`]);
	});

	it("the label threshold is exact in both directions (width 7 plain, width 8 labelled)", () => {
		// A2.2: avail = width - LEAD_DASHES(4) - 2; avail < 2 → plain. These two rows
		// pin the boundary in both directions. At width 8 the clipped 2-wide label
		// leaves right = 0, so the row ends after the space.
		expect(new SectionRule("tui").render(7)).toEqual([`\x1b[2m${"─".repeat(7)}\x1b[0m`]);
		const clipped = truncateToWidth("tui", 2);
		expect(new SectionRule("tui").render(8)[0]).toBe(`\x1b[2m────\x1b[0m \x1b[33m${clipped}\x1b[0m `);
		expect(visibleWidth(clipped)).toBe(2);
	});

	it("visibleWidth(row) === width for a range of widths and labels", () => {
		for (const width of [5, 6, 7, 12, 20, 80]) {
			for (const label of ["x", "tui", "guardian", "龍龍龍龍", "a".repeat(200)]) {
				const row = new SectionRule(label).render(width)[0] ?? "";
				expect(visibleWidth(row)).toBe(width);
			}
		}
	});
});

describe("D12 — decision content is normal weight", () => {
	it("the picker detail row is not faint (no leading dim on the detail line)", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		void shell.select({
			title: "approve?",
			detail: "command: rm -rf node_modules",
			items: [{ label: "Yes" }],
		});
		await settle(150);
		const raw = terminal.writes.join("");
		// D12: the detail line opens at normal weight — no \x1b[2m before it.
		expect(raw).toContain("command: rm -rf node_modules");
		expect(raw).not.toContain("\x1b[2mcommand: rm -rf node_modules");
		shell.close();
	});
});

describe("TuiShell activity region (M10 B)", () => {
	it("working paints a spinner row that ticks, then clears on idle", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle(0);
		shell.setActivity({ phase: "thinking", tools: [], agents: [] });
		await settle(30); // first paint (16ms render interval), before any 120ms tick
		const first = terminal.frameSince(0);
		expect(first).toContain("working…");
		await settle(300); // ≥2 ticker frames
		const ticked = terminal.frameSince(0);
		expect(ticked).toContain("working…");
		expect(ticked).not.toBe(first); // the spinner frame advanced
		const mark = terminal.writes.length;
		shell.setActivity({ phase: "idle", tools: [], agents: [] });
		await settle(30);
		expect(terminal.frameSince(mark)).not.toContain("working");
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

	it("task snapshots retain ordinal epochs in the fold-backed live rows", async () => {
		const { shell, terminal, transcript } = makeShell();
		shell.start();
		// #task-inline-live-rows (B1): task rows render inside the task's own
		// transcript fold, so the fold must exist for them to be visible.
		transcript.toolSink.start("parent", "task", { agent: "same", prompt: "independent prompt" });
		transcript.toolSink.start("new-parent", "task", { agent: "same", prompt: "independent prompt" });
		const agent = {
			agent: "same",
			task: "independent prompt",
			taskToolId: "parent",
			cwd: null,
			lastTool: null,
			toolCount: 0,
			startedAtMs: Date.now(),
		};
		shell.setActivity({
			phase: "working",
			tools: [],
			agents: [
				{ ...agent, sourceId: "one" },
				{ ...agent, sourceId: "two" },
			],
		});
		await settle(150);
		let mark = terminal.writes.length;
		shell.forceRender();
		await settle();
		const frame = terminal.frameSince(mark);
		expect(frame).toContain("pending #1.1 same");
		expect(frame).toContain("pending #1.2 same");
		shell.setActivity({ phase: "idle", tools: [], agents: [] });
		shell.setActivity({ phase: "working", tools: [], agents: [{ ...agent, taskToolId: "new-parent" }] });
		mark = terminal.writes.length;
		terminal.resize(100);
		await settle();
		expect(terminal.frameSince(mark)).toContain("pending #1 same");
		shell.close();
	});

	it("working rows render the tool timer in its call row and subagent tree lines", async () => {
		const { terminal, shell, transcript } = makeShell();
		shell.start();
		await settle(0);
		// #tool-inline-live-rows / #call-closing-status: both call types need
		// their fold — the timer addresses the call's own transcript entry.
		transcript.toolSink.start("t1", "bash", { command: "echo hi" });
		transcript.toolSink.start("t9", "task", { agent: "scout", prompt: "explore the tree" });
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
		const lines = stripAnsi(terminal.frameSince(0))
			.split("\n")
			.map((line) => line.trimEnd());
		const header = lines.findIndex((line) => line.includes("● bash") && line.includes("echo hi"));
		expect(header).toBeGreaterThanOrEqual(0);
		// #call-closing-status: the timer closes the call info row itself.
		expect(lines[header]).toMatch(/echo hi \d+s/);
		expect(lines.filter((line) => /echo hi \d+s/.test(line))).toHaveLength(1); // inline, never duplicated
		const taskHeader = lines.findIndex((line) => line.includes("● task"));
		expect(taskHeader).toBeGreaterThanOrEqual(0);
		expect(lines[taskHeader + 1]).toContain("pending #1 scout");
		expect(stripAnsi(terminal.frameSince(0))).toContain("explore the tree");
		expect(stripAnsi(terminal.frameSince(0))).toContain("3 tool starts · last: bash echo deep");
		shell.close();
	});

	it("fold-backed tool rows tick their elapsed seconds", async () => {
		const { terminal, shell, transcript } = makeShell();
		shell.start();
		await settle(0);
		transcript.toolSink.start("t1", "bash", { command: "echo hi" });
		shell.setActivity({
			phase: "working",
			tools: [{ id: "t1", name: "bash", label: "echo hi", startedAtMs: Date.now() - 4000 }],
			agents: [],
		});
		// Parse the rendered seconds rather than an exact string: the assertion must
		// hold whether the ticker fires on time or late under load.
		const latestSeconds = (text: string): number => {
			const matches = [...text.matchAll(/echo hi (\d+)s/g)];
			return Number(matches.at(-1)?.[1]);
		};
		await settle(30);
		const before = latestSeconds(stripAnsi(terminal.frameSince(0)));
		expect(before).toBeGreaterThanOrEqual(4);
		const mark = terminal.writes.length;
		await settle(1300);
		expect(latestSeconds(stripAnsi(terminal.frameSince(mark)))).toBeGreaterThan(before);
		shell.close();
	});

	it("idle clears the tool's live row (the clearActivity push path)", async () => {
		const { terminal, shell, transcript } = makeShell();
		shell.start();
		await settle(0);
		transcript.toolSink.start("t1", "bash", { command: "echo hi" });
		shell.setActivity({
			phase: "working",
			tools: [{ id: "t1", name: "bash", label: "echo hi", startedAtMs: Date.now() }],
			agents: [],
		});
		await settle(30);
		expect(stripAnsi(terminal.frameSince(0))).toMatch(/echo hi \d+s/);
		const mark = terminal.writes.length;
		shell.setActivity({ phase: "idle", tools: [], agents: [] });
		await settle(30);
		expect(stripAnsi(terminal.frameSince(mark))).not.toMatch(/echo hi \d+s/);
		shell.close();
	});

	it("call closing slot shape: zero seconds as `0s`, count capped", async () => {
		const { terminal, shell, transcript } = makeShell();
		shell.start();
		await settle(0);
		transcript.toolSink.start("t1", "bash", { command: "echo hi" });
		shell.setActivity({
			phase: "working",
			tools: [{ id: "t1", name: "bash", label: "echo hi", startedAtMs: Date.now() }],
			agents: [],
		});
		await settle(30);
		const zero = stripAnsi(terminal.frameSince(0))
			.split("\n")
			.find((line) => /echo hi \d+s/.test(line));
		expect(zero?.trim()).toBe("● bash  echo hi 0s"); // #call-closing-status A1.1: `0s` is shown
		const mark = terminal.writes.length;
		shell.setActivity({
			phase: "working",
			tools: [{ id: "t1", name: "bash", label: "echo hi", startedAtMs: Date.now() - 10_000_000 }],
			agents: [],
		});
		await settle(30);
		expect(stripAnsi(terminal.frameSince(mark))).toContain("9999+s");
		shell.close();
	});

	it("the task timer ticks in the call's closing slot (#call-closing-status A1.2)", async () => {
		const { terminal, shell, transcript } = makeShell();
		shell.start();
		await settle(0);
		transcript.toolSink.setResolver((name) => (name === "task" ? taskPresentation : undefined));
		transcript.toolSink.start("t9", "task", { agent: "scout", prompt: "explore" });
		shell.setActivity({
			phase: "working",
			tools: [],
			agents: [
				{
					agent: "scout",
					task: "explore",
					taskToolId: "t9",
					cwd: null,
					lastTool: null,
					toolCount: 0,
					startedAtMs: Date.now() - 4000,
				},
			],
		});
		// #call-closing-status A1.2: the task timer rides the call's closing slot,
		// not the `pending` row; parse the rendered seconds (ticker timing under
		// load is not exact).
		const latestSeconds = (text: string): number => {
			const matches = [...text.matchAll(/● task {2}scout · explore (\d+)s/g)];
			return Number(matches.at(-1)?.[1]);
		};
		await settle(30);
		expect(stripAnsi(terminal.frameSince(0))).toContain("pending #1 scout");
		expect(stripAnsi(terminal.frameSince(0))).not.toMatch(/pending #1 scout \d+s/); // seconds moved off the row
		const before = latestSeconds(stripAnsi(terminal.frameSince(0)));
		expect(before).toBeGreaterThanOrEqual(4);
		const mark = terminal.writes.length;
		await settle(1300);
		expect(latestSeconds(stripAnsi(terminal.frameSince(mark)))).toBeGreaterThan(before);
		shell.close();
	});

	it("a reused tool_call id clears the superseded fold's live rows", async () => {
		const { shell, transcript } = makeShell();
		shell.start();
		await settle(0);
		const agent = {
			agent: "scout",
			task: "explore",
			taskToolId: "call_0",
			cwd: null,
			lastTool: null,
			toolCount: 0,
			startedAtMs: Date.now(),
		};
		// Turn 1: the task runs and ends; its fold stays in the transcript.
		transcript.toolSink.start("call_0", "task", { agent: "scout", prompt: "OLD" });
		shell.setActivity({ phase: "working", tools: [], agents: [agent] });
		await settle(30);
		transcript.toolSink.end({ toolCallId: "call_0", toolName: "task", content: "done", isError: false });
		shell.setActivity({ phase: "idle", tools: [], agents: [] });
		transcript.toolSink.finalize(); // clearActivity's run boundary: ids become reusable
		await settle(30);
		// Turn 2: a provider that omits ids reuses `call_0` (openai-completions.ts:431).
		// The push runs before the new fold exists, so it resolves to turn 1's fold.
		shell.setActivity({ phase: "working", tools: [], agents: [agent] });
		transcript.toolSink.start("call_0", "task", { agent: "scout", prompt: "NEW" });
		await settle(30);
		transcript.toolSink.end({ toolCallId: "call_0", toolName: "task", content: "done", isError: false });
		shell.setActivity({ phase: "working", tools: [], agents: [] });
		await settle(30);
		expect(stripAnsi(transcript.render(80).join("\n"))).not.toContain("pending #");
		shell.close();
	});

	it("a stopped shell leaves the successor's live-rows resolver bound (shared sink)", async () => {
		const transcript = new TranscriptSink();
		const noop = (): void => {};
		const mk = (terminal: FakeTerminal) =>
			new TuiShell({
				transcript,
				terminal,
				onLine: noop,
				onInterrupt: noop,
				onEof: noop,
				onDequeue: noop,
				onCycleThinking: noop,
				onToggleThinking: noop,
				onModelSelect: noop,
			});
		const first = mk(new FakeTerminal());
		first.start();
		const second = mk(new FakeTerminal());
		second.start();
		await settle(0);
		first.close();
		await first.whenSettled();
		expect(transcript.callLiveRowsResolver).not.toBeNull(); // the guard kept the successor's
		expect(transcript.callSuffixResolver).not.toBeNull(); // and its closing-slot resolver
		transcript.toolSink.start("t9", "task", { agent: "scout", prompt: "explore" });
		second.setActivity({
			phase: "working",
			tools: [],
			agents: [
				{
					agent: "scout",
					task: "explore",
					taskToolId: "t9",
					cwd: null,
					lastTool: null,
					toolCount: 0,
					startedAtMs: Date.now(),
				},
			],
		});
		await settle(30);
		expect(stripAnsi(transcript.render(80).join("\n"))).toContain("pending #1 scout");
		second.close();
		await second.whenSettled();
	});
});

describe("M10 review regressions (wave 1 + B)", () => {
	it("layout order: transcript < folds < activity < ask, and queue < hint < editor box (P2#6)", async () => {
		const { terminal, transcript, shell } = makeShell();
		shell.start();
		await settle(0);
		transcript.feed("ORDER-TRANSCRIPT\n");
		shell.addFold("ORDER-FOLD", ["+ a", "- b"]);
		// #tool-inline-live-rows: tool rows moved into the transcript folds, so
		// the region's position is probed with the turn-level spinner row.
		shell.setActivity({ phase: "thinking", tools: [], agents: [] });
		const asked = shell.ask("ORDER-ASK");
		let mark = terminal.writes.length;
		shell.forceRender();
		await settle(30);
		const frameA = terminal.frameSince(mark);
		const t = frameA.indexOf("ORDER-TRANSCRIPT");
		const f = frameA.indexOf("ORDER-FOLD");
		const a = frameA.indexOf("working…");
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
		expect(text).toContain("ink-clipboard-");
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
