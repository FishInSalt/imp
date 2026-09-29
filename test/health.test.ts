import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLoopHealth,
	DEFAULT_HEALTH_THRESHOLDS,
	type HealthSignal,
	healthEnabled,
	healthSignalText,
} from "../src/core/health.js";
import type { AgentEvent } from "../src/core/loop.js";
import type { AssistantMessage, ToolResult } from "../src/core/messages.js";

/** #loop-health unit suite (design §6 items 1-4, 18): the monitor is a pure
 *  consumer of the AgentEvent stream — no loop, no provider, no session. */

function turn(turnIndex: number, calls: Array<{ name: string; args: unknown }>): AgentEvent {
	const message: AssistantMessage = {
		role: "assistant",
		blocks: calls.map((call, index) => ({
			type: "toolCall" as const,
			id: `t${turnIndex}-c${index}`,
			name: call.name,
			arguments: call.args,
		})),
		usage: { inputTokens: 0, outputTokens: 0 },
		stopReason: "tool_use",
	};
	return { type: "message_end", message };
}

function start(toolCallId: string, name: string, args: Record<string, unknown> = {}): AgentEvent {
	return { type: "tool_start", toolCallId, name, args };
}

function end(toolCallId: string, toolName: string, isError = false): AgentEvent {
	const result: ToolResult = { toolCallId, toolName, content: "", isError };
	return { type: "tool_end", result };
}

const envNames = [
	"IMP_HEALTH",
	"IMP_HEALTH_REPEAT_TURNS",
	"IMP_HEALTH_MUTATION_FAILURES",
	"IMP_HEALTH_TOOL_OPEN_MS",
];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
	for (const name of envNames) savedEnv.set(name, process.env[name]);
});

afterEach(() => {
	for (const name of envNames) {
		const value = savedEnv.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	vi.useRealTimers();
});

describe("repeat-loop", () => {
	it("fires at exactly the threshold with the peak count", () => {
		const monitor = createLoopHealth({ thresholds: { repeatTurns: 5 } });
		for (let i = 0; i < 4; i++) monitor.observe(turn(i, [{ name: "bash", args: { command: "npm test" } }]));
		expect(monitor.signals()).toHaveLength(0);
		monitor.observe(turn(4, [{ name: "bash", args: { command: "npm test" } }]));
		const signals = monitor.signals();
		expect(signals).toHaveLength(1);
		expect(signals[0]).toMatchObject({ code: "repeat-loop", count: 5, turn: 5 });
		// Peak count tracks growth after the first fire; count/turn/detail move
		// together (no mixed-batch evidence), and there is no re-emit.
		monitor.observe(turn(5, [{ name: "bash", args: { command: "npm test" } }]));
		expect(monitor.signals()[0]).toMatchObject({ count: 6, turn: 6 });
	});

	it("peak growth updates count/turn/detail together — never mixed batches", () => {
		const monitor = createLoopHealth({ thresholds: { repeatTurns: 2 } });
		monitor.observe(turn(0, [{ name: "bash", args: { command: "AAA" } }]));
		monitor.observe(turn(1, [{ name: "bash", args: { command: "AAA" } }]));
		expect(monitor.signals()[0]).toMatchObject({ count: 2, turn: 2, detail: 'bash "AAA"' });
		for (let i = 2; i < 6; i++) monitor.observe(turn(i, [{ name: "bash", args: { command: "BBB" } }]));
		// The 4-run is BBB's: count, turn and detail all describe THAT batch.
		expect(monitor.signals()[0]).toMatchObject({ count: 4, turn: 6, detail: 'bash "BBB"' });
	});

	it("a differing turn resets the run; key order does not count as differing", () => {
		const monitor = createLoopHealth({ thresholds: { repeatTurns: 3 } });
		monitor.observe(turn(0, [{ name: "read", args: { path: "a.ts", limit: 5 } }]));
		monitor.observe(turn(1, [{ name: "read", args: { limit: 5, path: "a.ts" } }]));
		monitor.observe(turn(2, [{ name: "read", args: { limit: 5, path: "a.ts" } }]));
		expect(monitor.signals()).toHaveLength(1); // key order is not a difference
		const reset = createLoopHealth({ thresholds: { repeatTurns: 3 } });
		reset.observe(turn(0, [{ name: "read", args: { path: "a.ts" } }]));
		reset.observe(turn(1, [{ name: "read", args: { path: "b.ts" } }]));
		reset.observe(turn(2, [{ name: "read", args: { path: "a.ts" } }]));
		reset.observe(turn(3, [{ name: "read", args: { path: "a.ts" } }]));
		expect(reset.signals()).toHaveLength(0);
	});

	it("multi-call turns are order-sensitive and detected from message_end alone", () => {
		const monitor = createLoopHealth({ thresholds: { repeatTurns: 3 } });
		// No tool_start events at all: the signature source is the assembled
		// assistant message at message_end (design §4.2).
		monitor.observe(
			turn(0, [
				{ name: "grep", args: { pattern: "x" } },
				{ name: "read", args: { path: "a" } },
			]),
		);
		monitor.observe(
			turn(1, [
				{ name: "grep", args: { pattern: "x" } },
				{ name: "read", args: { path: "a" } },
			]),
		);
		monitor.observe(
			turn(2, [
				{ name: "grep", args: { pattern: "x" } },
				{ name: "read", args: { path: "a" } },
			]),
		);
		const signals = monitor.signals();
		expect(signals).toHaveLength(1);
		expect(signals[0]?.detail).toBe('read {"path":"a"}'); // last call of the batch, bounded preview
	});

	it("a tool-call-free turn breaks any run and never matches", () => {
		const monitor = createLoopHealth({ thresholds: { repeatTurns: 2 } });
		monitor.observe(turn(0, [{ name: "bash", args: { command: "ls" } }]));
		const noCalls: AssistantMessage = {
			role: "assistant",
			blocks: [{ type: "text", text: "done" }],
			usage: { inputTokens: 0, outputTokens: 0 },
			stopReason: "end_turn",
		};
		monitor.observe({ type: "message_end", message: noCalls });
		monitor.observe(turn(2, [{ name: "bash", args: { command: "ls" } }]));
		expect(monitor.signals()).toHaveLength(0);
	});

	it("previews are single-line and bounded", () => {
		const monitor = createLoopHealth({ thresholds: { repeatTurns: 2 } });
		const command = `npm test --filter ${"x".repeat(200)}\nsecond line`;
		monitor.observe(turn(0, [{ name: "bash", args: { command } }]));
		monitor.observe(turn(1, [{ name: "bash", args: { command } }]));
		const detail = monitor.signals()[0]?.detail ?? "";
		expect(detail.startsWith('bash "')).toBe(true);
		expect(detail).not.toContain("\n");
		expect(detail.length).toBeLessThanOrEqual(80);
	});
});

describe("mutation-failure-streak", () => {
	it("fires after consecutive failed edit/write results, non-mutating results allowed between", () => {
		const monitor = createLoopHealth({ thresholds: { mutationFailures: 3 } });
		monitor.observe(turn(0, [{ name: "edit", args: { path: "src/a.ts" } }]));
		monitor.observe(end("t0-c0", "edit", true));
		monitor.observe(turn(1, [{ name: "read", args: { path: "src/a.ts" } }]));
		monitor.observe(end("t1-c0", "read", false)); // non-mutating result: no reset
		monitor.observe(turn(2, [{ name: "write", args: { path: "src/b.ts" } }]));
		monitor.observe(end("t2-c0", "write", true));
		monitor.observe(turn(3, [{ name: "edit", args: { path: "src/a.ts" } }]));
		monitor.observe(end("t3-c0", "edit", true));
		const signals = monitor.signals();
		expect(signals).toHaveLength(1);
		expect(signals[0]).toMatchObject({ code: "mutation-failure-streak", count: 3 });
		expect(signals[0]?.detail).toBe("edit src/a.ts"); // path from the message_end block map
	});

	it("a mutation success resets the streak; other tools' failures are ignored", () => {
		const monitor = createLoopHealth({ thresholds: { mutationFailures: 3 } });
		for (const [i, ok] of [true, true, false].entries()) {
			monitor.observe(turn(i, [{ name: "edit", args: { path: "a" } }]));
			monitor.observe(end(`t${i}-c0`, "edit", ok));
		}
		expect(monitor.signals()).toHaveLength(0); // last success reset the streak
		const ignored = createLoopHealth({ thresholds: { mutationFailures: 3 } });
		for (const i of [0, 1, 2]) {
			ignored.observe(turn(i, [{ name: "bash", args: { command: "false" } }]));
			ignored.observe(end(`b${i}`, "bash", true));
		}
		expect(ignored.signals()).toHaveLength(0);
	});

	it("a >5-minute gap resets the streak", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const monitor = createLoopHealth({ thresholds: { mutationFailures: 3 } });
		monitor.observe(turn(0, [{ name: "edit", args: { path: "a" } }]));
		monitor.observe(end("t0-c0", "edit", true));
		vi.setSystemTime(6 * 60_000);
		for (const i of [1, 2]) {
			monitor.observe(turn(i, [{ name: "edit", args: { path: "a" } }]));
			monitor.observe(end(`t${i}-c0`, "edit", true));
		}
		expect(monitor.signals()).toHaveLength(0); // gap reset: streak restarted at 1, now 2
		monitor.observe(turn(3, [{ name: "edit", args: { path: "a" } }]));
		monitor.observe(end("t3-c0", "edit", true));
		expect(monitor.signals()[0]?.code).toBe("mutation-failure-streak");
	});
});

describe("removed signal (Amendment 1)", () => {
	it("tool_start is a no-op: no signals, no timers, nothing after settle", () => {
		vi.useFakeTimers();
		const monitor = createLoopHealth();
		monitor.observe(turn(0, [{ name: "bash", args: { command: "x" } }]));
		monitor.observe(start("t0-c0", "bash"));
		vi.advanceTimersByTime(60 * 60_000);
		expect(monitor.signals()).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		monitor.dispose();
	});
});

describe("facts contract and lifecycle", () => {
	it("dedupes by code, keeps first-fire order, and emits once per code", () => {
		const emitted: HealthSignal[] = [];
		const monitor = createLoopHealth({
			thresholds: { repeatTurns: 2 },
			emit: (signal) => emitted.push(signal),
		});
		monitor.observe(turn(0, [{ name: "bash", args: { command: "a" } }]));
		monitor.observe(turn(1, [{ name: "bash", args: { command: "a" } }]));
		expect(monitor.signals()).toHaveLength(1); // one entry per code
		expect(emitted).toHaveLength(1); // emit fires on first only
		monitor.observe(turn(2, [{ name: "bash", args: { command: "a" } }]));
		expect(monitor.signals()).toHaveLength(1); // peak growth adds no entry
		monitor.note("compaction-failures", 3, "3 consecutive summarizer failures");
		expect(monitor.signals().map((s) => s.code)).toEqual(["repeat-loop", "compaction-failures"]);
		expect(emitted.map((s) => s.code)).toEqual(["repeat-loop", "compaction-failures"]);
		monitor.note("compaction-failures", 3, "again");
		expect(emitted).toHaveLength(2);
	});

	it("note() works before any observe (turn 0) and observe/note are inert after dispose", () => {
		const monitor = createLoopHealth();
		monitor.note("compaction-failures", 3, "3 consecutive summarizer failures");
		expect(monitor.signals()[0]).toMatchObject({ code: "compaction-failures", turn: 0 });
		monitor.dispose();
		monitor.dispose(); // idempotent
		monitor.observe(turn(0, [{ name: "bash", args: { command: "x" } }]));
		monitor.note("repeat-loop", 1);
		expect(monitor.signals()).toHaveLength(1);
	});

	it("two monitors are independent (concurrent children)", () => {
		const a = createLoopHealth({ thresholds: { repeatTurns: 2 } });
		const b = createLoopHealth({ thresholds: { repeatTurns: 2 } });
		a.observe(turn(0, [{ name: "bash", args: { command: "x" } }]));
		a.observe(turn(1, [{ name: "bash", args: { command: "x" } }]));
		b.observe(turn(0, [{ name: "bash", args: { command: "y" } }]));
		expect(a.signals()).toHaveLength(1);
		expect(b.signals()).toHaveLength(0);
	});
});

describe("thresholds and env", () => {
	it("explicit thresholds win; env overrides apply when no explicit value is given", () => {
		process.env.IMP_HEALTH_REPEAT_TURNS = "2";
		const fromEnv = createLoopHealth();
		fromEnv.observe(turn(0, [{ name: "bash", args: { command: "x" } }]));
		fromEnv.observe(turn(1, [{ name: "bash", args: { command: "x" } }]));
		expect(fromEnv.signals()).toHaveLength(1);

		const explicit = createLoopHealth({ thresholds: { repeatTurns: 4 } });
		for (let i = 0; i < 3; i++) explicit.observe(turn(i, [{ name: "bash", args: { command: "x" } }]));
		expect(explicit.signals()).toHaveLength(0);
		delete process.env.IMP_HEALTH_REPEAT_TURNS;
	});

	it("malformed env values fall back with the envInt warning; IMP_HEALTH=0 disables at the call site", () => {
		const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		process.env.IMP_HEALTH_REPEAT_TURNS = "not-a-number";
		const monitor = createLoopHealth();
		for (let i = 0; i < 4; i++) monitor.observe(turn(i, [{ name: "bash", args: { command: "x" } }]));
		expect(monitor.signals()).toHaveLength(0); // default 5 not reached
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("IMP_HEALTH_REPEAT_TURNS"));
		warning.mockRestore();

		process.env.IMP_HEALTH = "0";
		expect(healthEnabled()).toBe(false);
		delete process.env.IMP_HEALTH;
		expect(healthEnabled()).toBe(true);
	});

	it("the removed IMP_HEALTH_TOOL_OPEN_MS is ignored (no env read, no warning)", () => {
		const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		process.env.IMP_HEALTH_TOOL_OPEN_MS = "not-a-number";
		try {
			const monitor = createLoopHealth();
			monitor.note("compaction-failures", 3, "x");
			expect(monitor.signals()).toHaveLength(1);
			expect(warning).not.toHaveBeenCalled();
			expect("toolOpenMs" in DEFAULT_HEALTH_THRESHOLDS).toBe(false);
		} finally {
			warning.mockRestore();
		}
	});

	it("healthSignalText renders the pinned human shapes", () => {
		expect(
			healthSignalText({
				code: "repeat-loop",
				count: 5,
				turn: 5,
				detail: 'bash "npm test"',
			}),
		).toBe('repeated identical tool calls ×5 (last: bash "npm test")');
		expect(
			healthSignalText({ code: "mutation-failure-streak", count: 3, turn: 2, detail: "edit src/a.ts" }),
		).toBe("3 consecutive failed edits (last: edit src/a.ts)");
		// Legacy read-only (Amendment 1): renders pre-removal records.
		expect(
			healthSignalText({
				code: "tool-open",
				count: 1,
				turn: 1,
				detail: 'bash "npm run build" was still open after 10m00s',
			}),
		).toBe('bash "npm run build" was still open after 10m00s');
		expect(healthSignalText({ code: "compaction-failures", count: 3, turn: 0 })).toBe(
			"child compaction disabled after 3 summarizer failures",
		);
	});
});

describe("removal sweep (design §6 item 16)", () => {
	it("no src/extensions reference to the health variant (M4 event set untouched)", async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const dir = new URL("../src/extensions/", import.meta.url);
		const hits: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			const text = readFileSync(new URL(entry.name, dir), "utf8");
			if (text.includes('"health"') || text.includes("HealthSignal")) hits.push(entry.name);
		}
		expect(hits).toEqual([]);
	});

	it("the removed turn-cap constant is referenced nowhere in src/ or test/", async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		// Built dynamically so this test file is not its own hit.
		const needle = `CHILD_MAX${"_TURNS"}`;
		const hits: string[] = [];
		const walk = (dir: URL): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					walk(new URL(`${entry.name}/`, dir));
					continue;
				}
				if (!entry.name.endsWith(".ts")) continue;
				if (readFileSync(new URL(entry.name, dir), "utf8").includes(needle)) {
					hits.push(`${dir.pathname}${entry.name}`);
				}
			}
		};
		for (const root of ["../src/", "../test/"]) walk(new URL(root, import.meta.url));
		expect(hits).toEqual([]);
	});

	it("no tool-open producer references remain in src/ (Amendment 1)", async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		// Producer tokens only — the string "tool-open" itself stays legal in the
		// legacy read-only arms (HealthCode, healthSignalText).
		const tokens = ["toolOpenMs", "onToolStart", "openTimers", "IMP_HEALTH_TOOL_OPEN_MS"];
		const hits: string[] = [];
		const walk = (dir: URL): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					walk(new URL(`${entry.name}/`, dir));
					continue;
				}
				if (!entry.name.endsWith(".ts")) continue;
				const text = readFileSync(new URL(entry.name, dir), "utf8");
				for (const token of tokens) {
					if (text.includes(token)) hits.push(`${dir.pathname}${entry.name}:${token}`);
				}
			}
		};
		walk(new URL("../src/", import.meta.url));
		expect(hits).toEqual([]);
	});
});
