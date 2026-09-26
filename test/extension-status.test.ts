// test/extension-status.test.ts — the extension status channel end to end
// (task-timer design §4.2-§4.6): TuiShell rendering, the ReplMachine sink
// binding, the legacy-shell gate, and the shipped task-timer extension.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { ExtensionApi } from "../src/extensions/types.js";
import type { LLMProvider } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { runRepl } from "../src/repl/repl.js";
import { TuiShell } from "../src/repl/shell.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner, type Runner } from "../src/runner.js";
import { StdinBuffer, type Terminal } from "../src/tui.js";
import { scriptedProvider, ticks, waitUntil } from "./helpers/fakes.js";

// ── fakes (the repl-tui.test.ts harness, repeated for this suite) ─────────

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

	data(text: string): void {
		this.buffer?.process(text);
	}

	frameSince(mark: number): string {
		let out = "";
		for (const write of this.writes.slice(mark)) {
			const text = stripAnsi(write);
			if (out !== "" && !out.endsWith("\n") && !text.startsWith("\n")) out += "\n";
			out += text;
		}
		return out;
	}
}

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

const reply = (text: string): AssistantMessage => ({
	role: "assistant",
	blocks: [{ type: "text", text }],
	usage: { inputTokens: 5, outputTokens: 1 },
	stopReason: "end_turn",
});

function makeShell(columns = 80): { shell: TuiShell; terminal: FakeTerminal } {
	const terminal = new FakeTerminal(columns, 24);
	const transcript = new TranscriptSink();
	const shell = new TuiShell({
		transcript,
		terminal,
		onLine: () => {},
		onInterrupt: () => {},
		onEof: () => {},
		onDequeue: () => {},
		onCycleThinking: () => {},
		onToggleThinking: () => {},
	});
	return { shell, terminal };
}

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ── TuiShell.setExtensionStatus (design §4.3) ─────────────────────────────

describe("TuiShell extension status line", () => {
	it("a pre-start push is buffered and painted by start()", async () => {
		const { shell, terminal } = makeShell();
		shell.setExtensionStatus("running 0:01"); // before start() — must not be dropped
		shell.start();
		await settle();
		expect(terminal.frameSince(0)).toContain("running 0:01");
		shell.close();
	});

	it("an empty string hides the line (zero rows)", async () => {
		const { shell, terminal } = makeShell();
		shell.start();
		await settle();
		shell.setExtensionStatus("visible status");
		await settle();
		expect(terminal.frameSince(0)).toContain("visible status");
		const mark = terminal.writes.length;
		shell.setExtensionStatus("");
		await settle();
		expect(terminal.frameSince(mark)).not.toContain("visible status");
		shell.close();
	});

	it("untrusted text is sanitized: control sequences stripped, newlines folded to one line", async () => {
		const { shell, terminal } = makeShell();
		shell.start();
		await settle();
		const mark = terminal.writes.length;
		shell.setExtensionStatus("\x1b[31minjected-red\x1b[0m plain\nsecond line");
		await settle();
		const raw = terminal.writes.slice(mark).join("");
		expect(raw).not.toContain("\x1b[31m"); // the injection never reaches the terminal
		const frame = terminal.frameSince(mark);
		expect(frame).toContain("injected-red plain second line"); // one row, text intact
		shell.close();
	});

	it("over-width text is truncated with an ellipsis (the pi-tui width-throw guard)", async () => {
		const { shell, terminal } = makeShell(20); // budget: 19 columns
		shell.start();
		await settle();
		const mark = terminal.writes.length;
		shell.setExtensionStatus("x".repeat(100));
		await settle();
		const frame = terminal.frameSince(mark);
		expect(frame).toContain("…");
		expect(frame).not.toContain("x".repeat(20));
		shell.close();
	});

	it("pushes after close() are dropped without touching the torn-down shell", async () => {
		const { shell, terminal } = makeShell();
		shell.start();
		await settle();
		shell.close();
		const mark = terminal.writes.length;
		expect(() => shell.setExtensionStatus("late")).not.toThrow();
		await settle();
		expect(terminal.frameSince(mark)).not.toContain("late");
	});
});

// ── ReplMachine sink binding (design §4.2 step 2) ─────────────────────────

interface TuiEnv {
	runner: Runner;
	terminal: FakeTerminal;
	repl: Promise<number>;
}

async function startTuiWithRegistry(registry: ExtensionRegistry, scripts = [reply("ok")]): Promise<TuiEnv> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-extstatus-"));
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
		extensions: registry,
		exit: (code) => {
			throw new Error(`force-exit:${code}`);
		},
	});
	await ticks(2);
	return { runner, terminal, repl };
}

describe("ReplMachine status-sink binding", () => {
	it("statuses set before the machine exists are painted on bind; the sink binds exactly once", async () => {
		const registry = new ExtensionRegistry();
		registry.setExtensionStatus("global:clock", "time", "12:00"); // load-time write, no sink yet
		const sinkSpy = vi.spyOn(registry, "setStatusSink");
		const env = await startTuiWithRegistry(registry);
		await settle();
		expect(sinkSpy).toHaveBeenCalledTimes(1);
		expect(env.terminal.frameSince(0)).toContain("12:00");
		env.terminal.data("/exit\r");
		await env.repl;
	});

	it("writes during a run reach the screen through the bound sink", async () => {
		const registry = new ExtensionRegistry();
		const env = await startTuiWithRegistry(registry);
		await settle();
		registry.setExtensionStatus("cli:x", "k", "live-status");
		await waitUntil(() => env.terminal.frameSince(0).includes("live-status"));
		env.terminal.data("/exit\r");
		await env.repl;
	});

	it("the legacy shell binds no sink (capability gate); writes stay storage-only", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-extstatus-legacy-"));
		const registry = new ExtensionRegistry();
		const sinkSpy = vi.spyOn(registry, "setStatusSink");
		const renderer = new Renderer({ write: () => {}, ansi: false, liveTools: false, toolStyle: "one-line" });
		const runner = await createRunner({
			cwd: baseDir,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer,
			provider: scriptedProvider([reply("ok")]),
		});
		const input = new PassThrough();
		const repl = runRepl({
			runner,
			commands: [],
			interactive: false,
			input,
			output: { write: () => {} },
			extensions: registry,
			exit: (code) => {
				throw new Error(`force-exit:${code}`);
			},
		});
		await ticks(2);
		expect(sinkSpy).not.toHaveBeenCalled();
		registry.setExtensionStatus("cli:x", "k", "stored only"); // no throw, no render
		expect(registry.getExtensionStatusEntries()).toEqual([
			{ bucket: "cli:x", key: "k", text: "stored only" },
		]);
		input.end(); // EOF exits the REPL
		await repl;
	});
});

// ── the shipped consumer: examples/extensions/task-timer.mjs (design §4.5) ──

interface TimerFake {
	api: ExtensionApi;
	handlers: Map<string, () => void>;
	statuses: string[];
	unrefSpy: ReturnType<typeof vi.fn>;
	clearSpy: ReturnType<typeof vi.fn>;
	advance(ms: number): void;
	paint(): void;
}

async function loadTaskTimer(): Promise<(api: ExtensionApi) => void> {
	const mod = (await import(pathToFileURL(path.resolve("examples/extensions/task-timer.mjs")).href)) as {
		default: (api: ExtensionApi) => void;
	};
	return mod.default;
}

function timerFake(): TimerFake {
	let now = 1_700_000_000_000;
	let paintFn: (() => void) | null = null;
	const handlers = new Map<string, () => void>();
	const statuses: string[] = [];
	const unrefSpy = vi.fn();
	const clearSpy = vi.fn();
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.stubGlobal("setInterval", (fn: () => void) => {
		paintFn = fn;
		return { unref: unrefSpy };
	});
	vi.stubGlobal("clearInterval", clearSpy);
	const api = {
		cwd: "/tmp",
		version: "test",
		origin: "cli",
		registerTool: () => {},
		registerCommand: () => {},
		registerContext: () => {},
		on: (event: string, handler: () => void) => handlers.set(event, handler),
		setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "<cleared>"),
		confirm: async () => false,
	} as unknown as ExtensionApi;
	return {
		api,
		handlers,
		statuses,
		unrefSpy,
		clearSpy,
		advance: (ms) => {
			now += ms;
		},
		paint: () => paintFn?.(),
	};
}

describe("examples/extensions/task-timer.mjs", () => {
	it("paints running ticks, then done on run_end — and the interval is unref'd (design §4.5 liveness rule)", async () => {
		const taskTimer = await loadTaskTimer();
		const fake = timerFake();
		taskTimer(fake.api);
		fake.handlers.get("run_start")?.();
		expect(fake.statuses).toEqual(["running 0:00"]);
		expect(fake.unrefSpy).toHaveBeenCalledTimes(1); // a leaked tick must never hold the event loop

		fake.advance(3000);
		fake.paint();
		expect(fake.statuses.at(-1)).toBe("running 0:03");

		fake.advance(1000 * 3661); // 1h 1m 1s more → 3664s total
		fake.paint();
		expect(fake.statuses.at(-1)).toBe("running 1:01:04"); // H:MM:SS above an hour

		fake.handlers.get("run_end")?.();
		expect(fake.statuses.at(-1)).toBe("done in 1:01:04");
		expect(fake.clearSpy).toHaveBeenCalled();
	});

	it("an unpaired run_start (the previous run crashed) resets the clock", async () => {
		const taskTimer = await loadTaskTimer();
		const fake = timerFake();
		taskTimer(fake.api);
		fake.handlers.get("run_start")?.();
		fake.advance(5000);
		fake.paint();
		expect(fake.statuses.at(-1)).toBe("running 0:05");

		fake.handlers.get("run_start")?.(); // crash path: no run_end in between
		expect(fake.clearSpy).toHaveBeenCalledTimes(1); // the stale tick is gone
		expect(fake.statuses.at(-1)).toBe("running 0:00");
		fake.advance(2000);
		fake.paint();
		expect(fake.statuses.at(-1)).toBe("running 0:02");
	});

	it("run_end with no open round is a no-op", async () => {
		const taskTimer = await loadTaskTimer();
		const fake = timerFake();
		taskTimer(fake.api);
		fake.handlers.get("run_end")?.();
		expect(fake.statuses).toEqual([]);
	});
});
