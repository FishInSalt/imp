import { describe, expect, it } from "vitest";
import { currentToolCallContext, runWithToolCallContext } from "../src/extensions/call-context.js";
import { GateDecisionLog, UserInputLog } from "../src/extensions/user-input-log.js";

// #guardian-auto-mode Wave 1 (design D11/D18; §16/D32/D33): the HUMAN RECORD
// stores and the call-scoped snapshot carrier, unit level.

describe("UserInputLog (#guardian-auto-mode D11/D18; §16/D32)", () => {
	it("keeps raw non-empty submissions with timestamps, trimmed", () => {
		const log = new UserInputLog();
		expect(log.verified).toBe(false);
		expect(log.snapshot()).toEqual([]);
		log.record("  first  ", 1_000);
		log.record(""); // blanks never enter the log
		log.record("   ", 2_000);
		log.record("second", 3_000);
		expect(log.snapshot()).toEqual([
			{ text: "first", at: 1_000 },
			{ text: "second", at: 3_000 },
		]);
		expect(log.verified).toBe(true);
	});

	it("stores raw text — no storage-side trim or elision (§16/D32)", () => {
		const log = new UserInputLog();
		const big = "x".repeat(50_000);
		log.record(big, 42);
		const [entry] = log.snapshot();
		expect(entry).toEqual({ text: big, at: 42 });
	});

	it("snapshot is a copy; clear() empties the log", () => {
		const log = new UserInputLog();
		log.record("a", 1);
		const snap = log.snapshot();
		(snap as { text: string; at: number }[]).push({ text: "injected", at: 2 });
		expect(log.snapshot()).toEqual([{ text: "a", at: 1 }]);
		log.clear();
		expect(log.snapshot()).toEqual([]);
		expect(log.verified).toBe(false);
	});
});

describe("GateDecisionLog (#guardian-auto-mode §16/D33)", () => {
	it("records stamped outcomes, snapshots a copy, clear() empties", () => {
		const log = new GateDecisionLog();
		log.record({ tool: "bash", callIdentity: 'bash @ "/w" "rm -rf build"', outcome: "approved" }, 7);
		log.record({ tool: "bash", callIdentity: 'bash @ "/w" "rm -rf x"', outcome: "denied" }, 8);
		log.record(
			{ tool: "write", callIdentity: 'write @ "/w" "/etc/hosts"', outcome: "approved", remember: true },
			9,
		);
		const events = log.snapshot();
		expect(events).toHaveLength(3);
		expect(events[0]).toEqual({
			at: 7,
			tool: "bash",
			callIdentity: 'bash @ "/w" "rm -rf build"',
			outcome: "approved",
		});
		expect(events[2]?.remember).toBe(true);
		(events as unknown as { at: number }[]).push({ at: 10 });
		expect(log.snapshot()).toHaveLength(3);
		log.clear();
		expect(log.snapshot()).toEqual([]);
	});
});

describe("tool-call context (#guardian-auto-mode D15; §16/D33/D34)", () => {
	it("reads inside async descendants, is absent outside, and never crosses interleaved calls", async () => {
		expect(currentToolCallContext()).toBeUndefined();
		const seen: string[] = [];
		const first = runWithToolCallContext(
			{
				callId: "c1",
				subagent: false,
				cwd: "/a",
				tool: "bash",
				callIdentity: 'bash @ "/a" "go"',
				userInputs: [{ text: "go", at: 1 }],
				decisions: [],
			},
			async () => {
				// async gap: the store must survive the await (ALS semantics)
				await new Promise((resolve) => setTimeout(resolve, 5));
				const store = currentToolCallContext();
				seen.push(`${store?.callId}:${store?.userInputs.map((entry) => entry.text).join(",")}`);
			},
		);
		const second = runWithToolCallContext(
			{
				callId: "c2",
				subagent: true,
				agent: "worker",
				cwd: "/b",
				tool: "write",
				callIdentity: 'write @ "/b" "/x"',
				userInputs: [],
				decisions: [],
				workOrder: "do the thing",
			},
			async () => {
				const store = currentToolCallContext();
				seen.push(
					`${store?.callId}:${store?.userInputs.length}:${store?.agent ?? ""}:${store?.workOrder ?? ""}`,
				);
			},
		);
		await Promise.all([first, second]);
		expect(seen).toEqual(["c2:0:worker:do the thing", "c1:go"]);
		expect(currentToolCallContext()).toBeUndefined();
	});
});
