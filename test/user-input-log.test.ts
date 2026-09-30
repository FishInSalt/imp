import { describe, expect, it } from "vitest";
import { currentToolCallContext, runWithToolCallContext } from "../src/extensions/call-context.js";
import { UserInputLog } from "../src/extensions/user-input-log.js";

// #guardian-auto-mode Wave 1 (design D11/D15/D18): the provenance-verified
// user-input log and the call-scoped snapshot carrier, unit level.

describe("UserInputLog (#guardian-auto-mode D11/D18)", () => {
	it("keeps the newest three non-empty submissions, trimmed", () => {
		const log = new UserInputLog();
		expect(log.verified).toBe(false);
		expect(log.snapshot()).toEqual([]);
		log.record("  first  ");
		log.record(""); // blanks never enter the log
		log.record("   ");
		log.record("second");
		log.record("third");
		log.record("fourth");
		expect(log.snapshot()).toEqual(["second", "third", "fourth"]);
		expect(log.verified).toBe(true);
	});

	it("snapshot is a copy; clear() empties the log", () => {
		const log = new UserInputLog();
		log.record("a");
		const snap = log.snapshot();
		(snap as string[]).push("injected");
		expect(log.snapshot()).toEqual(["a"]);
		log.clear();
		expect(log.snapshot()).toEqual([]);
		expect(log.verified).toBe(false);
	});
});

describe("tool-call context (#guardian-auto-mode D15)", () => {
	it("reads inside async descendants, is absent outside, and never crosses interleaved calls", async () => {
		expect(currentToolCallContext()).toBeUndefined();
		const seen: string[] = [];
		const first = runWithToolCallContext(
			{ callId: "c1", subagent: false, cwd: "/a", userInputs: ["go"] },
			async () => {
				// async gap: the store must survive the await (ALS semantics)
				await new Promise((resolve) => setTimeout(resolve, 5));
				const store = currentToolCallContext();
				seen.push(`${store?.callId}:${store?.userInputs.join(",")}`);
			},
		);
		const second = runWithToolCallContext(
			{ callId: "c2", subagent: true, agent: "worker", cwd: "/b", userInputs: [] },
			async () => {
				const store = currentToolCallContext();
				seen.push(`${store?.callId}:${store?.userInputs.join(",")}:${store?.agent ?? ""}`);
			},
		);
		await Promise.all([first, second]);
		expect(seen).toEqual(["c2::worker", "c1:go"]);
		expect(currentToolCallContext()).toBeUndefined();
	});
});
