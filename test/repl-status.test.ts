import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Usage } from "../src/core/messages.js";
import type { LLMProvider } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { ReplInput } from "../src/repl/input.js";
import type { LineInput } from "../src/repl/line-input.js";
import { runRepl } from "../src/repl/repl.js";
import { TuiShell } from "../src/repl/shell.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner, type Runner } from "../src/runner.js";
import { StdinBuffer, type Terminal } from "../src/tui.js";
import { type ScriptStep, scriptedProvider, ticks, waitUntil } from "./helpers/fakes.js";

// ── fakes (the repl-tui.test.ts harness, repeated for this suite) ─────────

/** The pi-tui Terminal contract, captured: writes logged (raw, so the OSC
 *  title sequences stay assertable), input injectable through the real
 *  splitter. */
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
		const buffer = new StdinBuffer();
		buffer.on("data", (sequence: string) => onInput(sequence));
		buffer.on("paste", (content: string) => onInput(`\x1b[200~${content}\x1b[201~`));
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

	/** Inject keystrokes through the real splitter (like stdin bursts). */
	data(text: string): void {
		this.buffer?.process(text);
	}

	/** Everything written since `mark`, ANSI/control-stripped. */
	frameSince(mark: number): string {
		return stripAnsi(this.writes.slice(mark).join(""));
	}
}

/** Remove escape sequences (CSI/OSC/APC), cursor markers, and \r. */
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
			i += 2;
			while (i < text.length && !/[A-Za-z]/.test(text[i] ?? "")) i++;
		} else if (next === "]") {
			i += 2;
			while (i < text.length && text[i] !== "\x07" && text[i] !== "\x1b") i++;
			if (text[i] === "\x1b" && text[i + 1] === "\\") i++;
		} else {
			i += 1;
		}
	}
	return out;
}

/** Settle TUI renders: nextTick + the 16ms minimum render interval. */
async function settle(extraMs = 30): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, extraMs));
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const LOW_NOTE = "▪ context 80% used — /compact to summarize older turns";

function reply(text: string, usage: Usage): AssistantMessage {
	return { role: "assistant", blocks: [{ type: "text", text }], usage, stopReason: "end_turn" };
}

interface StatusEnv {
	runner: Runner;
	terminal: FakeTerminal;
	transcript: TranscriptSink;
	repl: Promise<number>;
}

/** runRepl on the TUI shell — the machine's footer/title pushes land on the
 *  FakeTerminal's write log. */
async function startTuiRepl(scripts: ScriptStep[]): Promise<StatusEnv> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-status-"));
	const provider: LLMProvider = scriptedProvider(scripts);
	const terminal = new FakeTerminal();
	const transcript = new TranscriptSink();
	const renderer = new Renderer({
		write: transcript.feed,
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
		markdown: false,
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
		deferInit: false,
	});
	const repl = runRepl({
		runner,
		commands: [],
		shell: "tui",
		transcript,
		terminal,
		interactive: true,
		exit: (code) => {
			throw new Error(`force-exit:${code}`);
		},
	});
	await ticks(2);
	return { runner, terminal, transcript, repl };
}

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

// ── footer: context percentage ───────────────────────────────────────────

describe("footer context percentage", () => {
	it("appends ctx {p}% from the live history; startup reads 0%, rounding is half-up", async () => {
		vi.stubEnv("IMP_CONTEXT_WINDOW", "30");
		const env = await startTuiRepl([reply("ok", { inputTokens: 5, outputTokens: 0 })]);
		await settle();
		expect(env.terminal.frameSince(0)).toContain("ctx 0%"); // empty history at startup
		env.terminal.data("hi\r");
		// anchored on the reply's usage: 5/30 = 16.67% → 17
		await waitUntil(() => env.terminal.frameSince(0).includes("ctx 17%"));
		env.terminal.data("/exit\r");
		await env.repl;
	});

	it("p ≥ 80 appends the low hint and notes ONCE per crossing; /new drops it and re-arms the latch", async () => {
		vi.stubEnv("IMP_CONTEXT_WINDOW", "100");
		const env = await startTuiRepl([reply("ok", { inputTokens: 80, outputTokens: 0 })]);
		await settle();
		env.terminal.data("hi\r");
		// the note fires in the same refreshFooter as the footer push; the
		// frame repaint follows on the next render tick
		await waitUntil(() => env.terminal.frameSince(0).includes("ctx 80%"));
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("low — /compact");

		// a second turn stays above the threshold — the note must not repeat
		env.terminal.data("again\r");
		const RUN_STATS = "— test-model · 1 turns"; // per-run stats: one occurrence per completed turn
		await waitUntil(() => count(env.transcript.completedLines().join("\n"), RUN_STATS) === 2);
		expect(count(env.transcript.completedLines().join("\n"), LOW_NOTE)).toBe(1);

		// /new empties the live history: ctx drops to 0, the hint leaves the
		// footer — and (debt clearance) the transcript itself starts over
		const mark = env.terminal.writes.length;
		env.terminal.data("/new\r");
		await waitUntil(() => env.terminal.frameSince(mark).includes("ctx 0%"));
		expect(env.terminal.frameSince(mark)).not.toContain("low — /compact");
		expect(count(env.transcript.completedLines().join("\n"), LOW_NOTE)).toBe(0); // wiped with the view

		// crossing the threshold again fires the note — the latch re-armed
		env.terminal.data("hi\r");
		await waitUntil(() => count(env.transcript.completedLines().join("\n"), LOW_NOTE) === 1);
		env.terminal.data("/exit\r");
		await env.repl;
	});

	it("IMP_CONTEXT_WINDOW falls back to 131072 on an invalid value", async () => {
		vi.stubEnv("IMP_CONTEXT_WINDOW", "abc");
		const env = await startTuiRepl([reply("ok", { inputTokens: 80, outputTokens: 0 })]);
		await settle();
		env.terminal.data("hi\r");
		await waitUntil(() => env.transcript.completedLines().join("\n").includes("1 turns"));
		// 80 tokens of a 131072 window — no visible fill, no low hint
		expect(env.terminal.frameSince(0)).toContain("ctx 0%");
		expect(env.terminal.frameSince(0)).not.toContain("low — /compact");
		env.terminal.data("/exit\r");
		await env.repl;
	});
});

// ── terminal title (OSC 2) ───────────────────────────────────────────────

describe("terminal title", () => {
	it("paints after start (buffered machine push), follows /model, and close clears it", async () => {
		const env = await startTuiRepl([reply("ok", { inputTokens: 10, outputTokens: 5 })]);
		await settle();
		// The machine's constructor-time setTitle arrives BEFORE start();
		// start() must paint the buffered title.
		expect(env.terminal.writes.join("")).toContain("\x1b]2;imp — test-model\x07");

		env.terminal.data("/model glm-4.6\r");
		await waitUntil(() => env.terminal.writes.join("").includes("\x1b]2;imp — glm-4.6\x07"));

		env.terminal.data("/exit\r");
		await env.repl;
		await settle(80); // the deferred terminal stop clears the title
		expect(env.terminal.writes.join("")).toContain("\x1b]2;\x07");
	});
});

// ── LineInput.setTitle: the interface contract ───────────────────────────

describe("LineInput.setTitle contract", () => {
	it("is optional: TuiShell implements it; the legacy shell simply lacks it", () => {
		const tui: LineInput = new TuiShell({
			transcript: new TranscriptSink(),
			onLine: () => {},
			onInterrupt: () => {},
			onEof: () => {},
		});
		expect(typeof tui.setTitle).toBe("function");
		const legacy: LineInput = new ReplInput({
			input: new PassThrough(),
			output: { write: () => {} },
			interactive: false,
			onLine: () => {},
			onInterrupt: () => {},
			onEof: () => {},
		});
		expect(legacy.setTitle).toBeUndefined();
	});
});
