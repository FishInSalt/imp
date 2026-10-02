import { describe, expect, it } from "vitest";
import { bashPresentation, readPresentation, taskPresentation } from "../src/core/tools/presentation.js";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import { preparedInputBlock, sanitizeDisplay } from "../src/repl/tool-presentation.js";
import { prepareCall } from "../src/repl/tool-presentation-hooks.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { visibleWidth } from "../src/tui.js";

const plain = (rows: readonly string[]) => rows.map((row) => sanitizeDisplay(row));
const input = (
	name: string,
	args: unknown,
	hook: unknown,
	elapsedMs?: number,
	failed?: boolean,
): ToolBlockFold => {
	const block = preparedInputBlock(prepareCall("id", name, args, () => hook as never));
	if (elapsedMs !== undefined) block.elapsedMs = elapsedMs;
	if (failed !== undefined) block.failed = failed;
	return new ToolBlockFold(block);
};
const rowsFit = (fold: ToolBlockFold, w: number) => fold.render(w).every((row) => visibleWidth(row) <= w);

describe("call closing slot (#call-closing-status, design D2/D8)", () => {
	it("closes the last chunk of a wrapped single-line command", () => {
		const rows = plain(
			input(
				"bash",
				{ command: "rg -n pattern src/ --glob '*.ts' --hidden --no-ignore" },
				bashPresentation,
				2300,
			).render(40),
		);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows[0]).not.toContain("✓");
		expect(rows.at(-1)).toMatch(/ ✓ 2\.3s$/);
	});

	it("closes the last visible row when the collapsed cap cuts the info", () => {
		const rows = plain(input("bash", { command: "l1\nl2\nl3\nl4\nl5" }, bashPresentation, 2300).render(40));
		expect(rows[0]).toBe("● bash  l1");
		expect(rows[1]).toBe("    l2");
		expect(rows[2]).toBe("    l3 ✓ 2.3s");
		expect(rows.join("\n")).toContain("… more · Ctrl+O");
	});

	it("skips a trailing empty row when targeting the slot", () => {
		const rows = plain(input("bash", { command: "l1\nl2\n" }, bashPresentation, 2300).render(40));
		expect(rows).toEqual(["● bash  l1", "    l2 ✓ 2.3s", "    "]);
	});

	it("closes the last visible chunk when the re-lay pushes chunks past the cap", () => {
		const rows = plain(input("bash", { command: "z".repeat(50) }, bashPresentation, 2300).render(20));
		expect(rows).toEqual([
			"● bash  zzzzzzzzzzzz",
			"    zzzzzzzzzzzzzzzz",
			"    zzzzzzzzz ✓ 2.3s",
			"    … more · Ctrl+O",
		]);
	});

	it("re-lays the tail when the running text width changes (accepted reflow, D5)", () => {
		// 29 x's at w=40, target budget 32: ` 9s` (3 columns) re-lays at 29 and
		// fits one row; ` 10s` (4 columns) re-lays at 28 and splits (28 + 1), so
		// the slot closes the last visible chunk.
		const fold = input("bash", { command: "x".repeat(29) }, bashPresentation);
		fold.setRunningSuffix("9s");
		expect(plain(fold.render(40))).toEqual([`● bash  ${"x".repeat(29)} 9s`]);
		fold.setRunningSuffix("10s");
		expect(plain(fold.render(40))).toEqual([`● bash  ${"x".repeat(28)}`, "    x 10s"]);
	});

	it("keeps the inline rule under raw-only (multi-line)", () => {
		const fold = input("bash", { command: "echo first\necho last" }, bashPresentation, 2300);
		fold.setRawArguments(true);
		expect(plain(fold.render(40))).toEqual(["● bash  echo first", "    echo last ✓ 2.3s"]);
	});

	it("re-lays a single row that only fits with the full budget", () => {
		// 28-column command at w=40: the full budget (32) fits one row; with the
		// 7-column slot the re-lay budget is 25 and the text splits (25 + 3), so
		// the slot closes the tail chunk (design D8 case walk).
		const command = "x".repeat(28);
		const rows = plain(input("bash", { command }, bashPresentation, 2300).render(40));
		expect(rows).toEqual([`● bash  ${"x".repeat(25)}`, `    xxx ✓ 2.3s`]);
	});

	it("renders a multi-line command fully before the slot (no mid-command row)", () => {
		const fold = input("bash", { command: "cd /tmp\nls -la\necho done" }, bashPresentation);
		expect(fold.setRunningSuffix("3s")).toBe(true);
		expect(plain(fold.render(44))).toEqual(["● bash  cd /tmp", "    ls -la", "    echo done 3s"]);
	});

	it("closes the last summary row for a wrapped task prompt", () => {
		const rows = plain(
			input(
				"task",
				{
					agent: "scout",
					prompt:
						"explore the repository tree and report the main modules and their responsibilities in detail",
				},
				taskPresentation,
				12300,
			).render(44),
		);
		const slot = rows.findIndex((row) => row.includes("✓ 12.3s"));
		expect(slot).toBeGreaterThan(0); // never pinned to the first row
		expect(rows[slot]).toBe("    sponsibilities in detail ✓ 12.3s"); // the last summary row
	});
});

describe("running-suffix render and swap (#call-closing-status, design D1/D3/D4/D5)", () => {
	it("shows the running text, then the completion marker in the same slot", () => {
		const fold = input("bash", { command: "echo hi" }, bashPresentation);
		expect(fold.setRunningSuffix("0s")).toBe(true);
		expect(plain(fold.render(40))).toEqual(["● bash  echo hi 0s"]);
		expect(fold.setRunningSuffix("3s")).toBe(true);
		expect(plain(fold.render(40))).toEqual(["● bash  echo hi 3s"]);
		expect(fold.setRunningSuffix("3s")).toBe(false);
		expect(fold.setRunningSuffix("4s")).toBe(true);
		expect(plain(fold.render(40))).toEqual(["● bash  echo hi 4s"]);
		fold.updateBlock({ ...fold.block, elapsedMs: 2300 });
		expect(plain(fold.render(40))).toEqual(["● bash  echo hi ✓ 2.3s"]);
		fold.updateBlock({ ...fold.block, elapsedMs: 400 });
		expect(plain(fold.render(40))).toEqual(["● bash  echo hi ✓"]);
	});

	it("hides the slot on interrupted blocks, running text included", () => {
		const live = input("bash", { command: "echo hi" }, bashPresentation);
		live.setRunningSuffix("3s");
		live.updateBlock({ ...live.block, error: true });
		expect(plain(live.render(40))).toEqual(["● bash  echo hi"]);
		const done = input("bash", { command: "echo hi" }, bashPresentation, 2300);
		done.updateBlock({ ...done.block, error: true });
		expect(plain(done.render(40))).toEqual(["● bash  echo hi"]);
	});

	it("omits the running text below its floor while the completion marker fits", () => {
		const live = input("bash", { command: "echo hi" }, bashPresentation);
		live.setRunningSuffix("3s"); // slot 3 columns: budget >= 11 shows (w >= 19)
		expect(plain(live.render(18))).toEqual(["● bash  echo hi"]);
		expect(plain(live.render(19))).toEqual(["● bash  echo hi 3s"]);
		const capped = input("bash", { command: "echo hi" }, bashPresentation);
		capped.setRunningSuffix("9999+s"); // slot 7 columns: budget >= 15 shows (w >= 23)
		expect(plain(capped.render(22))).toEqual(["● bash  echo hi"]);
		expect(plain(capped.render(23))).toEqual(["● bash  echo hi 9999+s"]);
		const done = input("bash", { command: "echo hi" }, bashPresentation, 2300);
		expect(plain(done.render(23))).toEqual(["● bash  echo hi ✓ 2.3s"]);
		expect(plain(done.render(22))).toEqual(["● bash  echo hi"]);
	});

	it("renders the running text on a pathFirst call row", () => {
		const fold = input("read", { path: "src/a.ts" }, readPresentation);
		fold.setRunningSuffix("3s");
		expect(plain(fold.render(40))).toEqual(["● read  src/a.ts 3s"]);
	});

	it("flips the omission notice when the running width changes the re-lay (D5)", () => {
		const build = () => input("bash", { command: `l1\nl2\n${"y".repeat(33)}` }, bashPresentation);
		const nine = build();
		nine.setRunningSuffix("9s"); // re-lay budget 33: the 33 y's fit, no extra row
		expect(plain(nine.render(40))).toEqual(["● bash  l1", "    l2", `    ${"y".repeat(33)} 9s`]);
		const ten = build();
		ten.setRunningSuffix("10s"); // re-lay budget 32: split 32 + 1; the hidden chunk flips the notice
		expect(plain(ten.render(40))).toEqual([
			"● bash  l1",
			"    l2",
			`    ${"y".repeat(32)} 10s`,
			"    … more · Ctrl+O",
		]);
	});

	it("keeps the header-slot fallback under narrow widths (E1 shapes)", () => {
		expect(plain(input("bash", { command: "echo hi" }, bashPresentation, 400).render(8))).toEqual([
			"● bash ✓",
			"    echo",
			"     hi",
		]);
		const live = input("bash", { command: "echo hi" }, bashPresentation);
		live.setRunningSuffix("3s");
		expect(plain(live.render(8))).toEqual(["● bash", "    echo", "     hi"]); // the slot does not fit the header
		expect(plain(input("read", { path: "src/a.ts" }, readPresentation, 400).render(8))).toEqual([
			"● read ✓",
			"    src/",
			"    a.ts",
		]);
	});

	it("never exceeds the width for any width with running or completion slots (I1)", () => {
		const live = input("bash", { command: "echo first\necho second line with more text" }, bashPresentation);
		live.setRunningSuffix("9999+s");
		const done = input(
			"bash",
			{ command: "echo first\necho second line with more text" },
			bashPresentation,
			61200,
		);
		const task = input(
			"task",
			{ agent: "scout", prompt: "explore the repository tree and report" },
			taskPresentation,
			2300,
		);
		for (let w = 1; w <= 60; w++) for (const fold of [live, done, task]) expect(rowsFit(fold, w)).toBe(true);
	});
});

describe("running-suffix channel (#call-closing-status, design D3)", () => {
	it("publishes and clears the suffix on a known fold, ignores unknown keys", () => {
		const transcript = new TranscriptSink();
		transcript.toolSink.start("t1", "bash", { command: "echo hi" });
		transcript.setCallSuffix("t1", "1s");
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).toContain("echo hi 1s");
		expect(() => transcript.setCallSuffix("nope", "1s")).not.toThrow();
		transcript.setCallSuffix("t1", null);
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).not.toContain("echo hi 1s");
	});

	it("pulls the suffix at fold-creation time (late fold)", () => {
		const transcript = new TranscriptSink();
		transcript.callSuffixResolver = (key) => (key === "t1" ? "2s" : null);
		transcript.toolSink.start("t1", "bash", { command: "echo hi" });
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).toContain("echo hi 2s");
	});

	it("a re-registered fold receives the suffix; the displaced fold keeps none", () => {
		const transcript = new TranscriptSink();
		transcript.toolSink.start("t1", "bash", { command: "echo one" });
		transcript.setCallSuffix("t1", "1s");
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).toContain("echo one 1s");
		transcript.toolSink.finalize();
		transcript.toolSink.start("t1", "bash", { command: "echo two" }); // re-registers the id
		transcript.setCallSuffix("t1", "2s");
		const text = sanitizeDisplay(transcript.render(80).join("\n"));
		expect(text).toContain("echo two 2s");
		expect(text).not.toContain("echo one 1s");
	});

	it("a suppressed duplicate start drops the id so later pushes no-op until a new lifecycle", () => {
		const transcript = new TranscriptSink();
		transcript.toolSink.start("t1", "extension", {});
		transcript.toolSink.end({ toolCallId: "t1", toolName: "extension", content: "ok", isError: false });
		transcript.setCallSuffix("t1", "5s"); // the shell push for the reused id
		// The settled block's completion marker wins over any pushed suffix (D1).
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).not.toContain("{} 5s");
		transcript.toolSink.start("t1", "extension", {}); // terminal duplicate: suppressed
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).not.toContain("9s");
		// The mapping is dropped: later pushes no-op until a new fold is created.
		transcript.setCallSuffix("t1", "9s");
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).not.toContain("9s");
		transcript.toolSink.finalize();
		transcript.toolSink.start("t1", "extension", {});
		transcript.setCallSuffix("t1", "7s");
		expect(sanitizeDisplay(transcript.render(80).join("\n"))).toContain("{} 7s");
	});
});
