import { describe, expect, it } from "vitest";
import { bashPresentation, readPresentation } from "../src/core/tools/presentation.js";
import { formatToolElapsed } from "../src/format.js";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import {
	createToolSink,
	outputBlock,
	preparedInputBlock,
	sanitizeDisplay,
} from "../src/repl/tool-presentation.js";
import { prepareCall } from "../src/repl/tool-presentation-hooks.js";
import { visibleWidth } from "../src/tui.js";

const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const green = "\x1b[32m";
const plain = (rows: string[]) => rows.map(sanitizeDisplay);
const input = (name: string, args: unknown, hook: unknown, elapsedMs?: number): ToolBlockFold => {
	const block = preparedInputBlock(prepareCall("id", name, args, () => hook as never));
	if (elapsedMs !== undefined) block.elapsedMs = elapsedMs;
	return new ToolBlockFold(block);
};
const rowsFit = (fold: ToolBlockFold, w: number) => fold.render(w).every((row) => visibleWidth(row) <= w);

type Result = Parameters<typeof outputBlock>[0];
const result = (isError = false): Result => ({ toolCallId: "t1", toolName: "bash", content: "ok", isError });

describe("formatToolElapsed (#tui-tool-elapsed)", () => {
	it.each([
		[1000, "1.0s"],
		[2350, "2.3s"],
		[59949, "59.9s"],
		[59999, "59.9s"],
		[60000, "1m00s"],
		[61200, "1m01s"],
		[3600000, "60m00s"],
	])("formats %d ms as %s", (ms, expected) => {
		expect(formatToolElapsed(ms)).toBe(expected);
	});
});

describe("call-row duration suffix (#tui-tool-elapsed)", () => {
	it("appends the green-check suffix at the end of the first row", () => {
		const fold = input("bash", { command: "echo ok" }, bashPresentation, 2300);
		expect(plain(fold.render(40))).toEqual(["● bash  echo ok ✓ 2.3s"]);
		expect(fold.render(40)[0]).toBe(
			`${dim}●${reset} ${bold}bash${reset}  echo ok ${green}✓${reset}${dim} 2.3s${reset}`,
		);
	});

	it("renders no suffix without elapsedMs (regression)", () => {
		expect(plain(input("bash", { command: "echo ok" }, bashPresentation).render(40))).toEqual([
			"● bash  echo ok",
		]);
	});

	it("renders the suffix on a pathFirst call row", () => {
		expect(plain(input("read", { path: "src/a.ts" }, readPresentation, 2300).render(40))).toEqual([
			"● read  src/a.ts ✓ 2.3s",
		]);
	});

	it("closes the first row of a multi-row command and leaves continuations", () => {
		expect(
			plain(input("bash", { command: "echo first\necho last" }, bashPresentation, 2300).render(40)),
		).toEqual(["● bash  echo first ✓ 2.3s", "    echo last"]);
	});

	it("uses the minute form for long calls", () => {
		expect(plain(input("bash", { command: "echo ok" }, bashPresentation, 61200).render(40))).toEqual([
			"● bash  echo ok ✓ 1m01s",
		]);
	});

	it("reserves width and omits the suffix below the 8-column floor", () => {
		// prefix 8 + suffix 7: budget 23-8-7 = 8 -> shown; 22-8-7 = 7 -> omitted.
		expect(plain(input("bash", { command: "echo ok" }, bashPresentation, 2300).render(23))).toEqual([
			"● bash  echo ok ✓ 2.3s",
		]);
		expect(plain(input("bash", { command: "echo ok" }, bashPresentation, 2300).render(22))).toEqual([
			"● bash  echo ok",
		]);
	});

	it("never exceeds the width on any row for any width (I1)", () => {
		const folds = [
			input("bash", { command: "echo ok" }, bashPresentation, 2300),
			input("read", { path: "src/very/long/path/to/some/deeply/nested/file.ts" }, readPresentation, 2300),
			input("bash", { command: "echo first\necho last" }, bashPresentation, 2300),
			input("bash", { command: "echo ok" }, bashPresentation, 60000),
		];
		const expanded = input("bash", { command: "echo ok" }, bashPresentation, 2300);
		expanded.setExpanded(true);
		folds.push(expanded);
		for (const fold of folds) for (let w = 1; w <= 60; w++) expect(rowsFit(fold, w)).toBe(true);
	});

	it("shows no suffix on header-only rows when the header itself is the budget", () => {
		const rows = plain(input("bash", { command: "echo ok" }, bashPresentation, 2300).render(8));
		expect(rows.join("\n")).not.toContain("✓");
		expect(rows.join("\n")).toContain("● bash");
	});

	it("shows the suffix on a header-only row exactly when the header fits with it", () => {
		// read + expanded + raw + covered path -> header-only row; header `● read`
		// is 6 columns, suffix 7: w=13 shows, w=12 omits.
		const shown = input("read", { path: "src/a.ts" }, readPresentation, 2300);
		shown.setExpanded(true);
		shown.setRawArguments(true);
		expect(plain(shown.render(13))[0]).toBe("● read ✓ 2.3s");
		const omitted = input("read", { path: "src/a.ts" }, readPresentation, 2300);
		omitted.setExpanded(true);
		omitted.setRawArguments(true);
		expect(plain(omitted.render(12))[0]).toBe("● read");
	});

	it("keeps the suffix on the first row when expanded", () => {
		const fold = input("bash", { command: "echo ok" }, bashPresentation, 2300);
		fold.setExpanded(true);
		expect(plain(fold.render(40))).toEqual(["● bash ✓ 2.3s", "    Command: echo ok"]);
	});

	it("keeps the suffix under raw arguments", () => {
		const fold = input("bash", { command: "echo ok" }, bashPresentation, 2300);
		fold.setRawArguments(true);
		expect(plain(fold.render(40))[0]).toContain(" ✓ 2.3s");
	});

	it("reflects an updateBlock re-render (cache invalidation)", () => {
		const fold = input("bash", { command: "echo ok" }, bashPresentation);
		expect(plain(fold.render(40))[0]).not.toContain("✓");
		fold.updateBlock({ ...fold.block, elapsedMs: 2300 });
		expect(plain(fold.render(40))[0]).toContain(" ✓ 2.3s");
	});

	it("ignores the field on output blocks (I5)", () => {
		const out = outputBlock(result());
		out.elapsedMs = 2300;
		expect(plain(new ToolBlockFold(out).render(40)).join("\n")).not.toContain("✓");
	});

	it("keeps omission notices in parity with and without the suffix", () => {
		const longCmd = `echo ${"abcdefghij".repeat(12)}`;
		const withCmd = plain(input("bash", { command: longCmd }, bashPresentation, 2300).render(40)).join("\n");
		const withoutCmd = plain(input("bash", { command: longCmd }, bashPresentation).render(40)).join("\n");
		expect(withoutCmd).toContain("… more · Ctrl+O");
		expect(withCmd).toContain("… more · Ctrl+O");
		const longPath = "src/very/long/path/to/some/deeply/nested/directory/file.ts";
		const withPath = plain(input("read", { path: longPath }, readPresentation, 2300).render(30)).join("\n");
		const withoutPath = plain(input("read", { path: longPath }, readPresentation).render(30)).join("\n");
		expect(withoutPath).toContain("… more · Ctrl+O");
		expect(withPath).toContain("… more · Ctrl+O");
	});
});

describe("createToolSink end-time duration (#tui-tool-elapsed)", () => {
	const harness = () => {
		let now = 0;
		const log: string[] = [];
		const blocks: Parameters<Parameters<typeof createToolSink>[0]>[0][] = [];
		const updates: { prev: unknown; next: { elapsedMs?: number; title: string } }[] = [];
		const sink = createToolSink(
			(block) => {
				log.push(`append:${block.kind}`);
				blocks.push(block);
			},
			(prev, next) => {
				log.push("update");
				updates.push({ prev, next });
			},
			() => now,
		);
		return { sink, log, blocks, updates, add: (ms: number) => (now += ms) };
	};

	it("updates the emitted input block before the output append", () => {
		const { sink, log, blocks, updates, add } = harness();
		sink.start("t1", "bash", { command: "x" });
		add(2300);
		sink.end(result());
		expect(log).toEqual(["append:input", "update", "append:output"]);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.prev).toBe(blocks[0]);
		expect(updates[0]!.next.elapsedMs).toBe(2300);
	});

	it("gates at 1000ms", () => {
		for (const [ms, fire] of [
			[999, false],
			[1000, true],
		] as const) {
			const { sink, updates, add } = harness();
			sink.start("t1", "bash", { command: "x" });
			add(ms);
			sink.end(result());
			expect(updates.length).toBe(fire ? 1 : 0);
		}
	});

	it("does not fire for errors, replay, orphans, or duplicates", () => {
		const errors = harness();
		errors.sink.start("t1", "bash", { command: "x" });
		errors.add(2000);
		errors.sink.end(result(true));
		expect(errors.updates).toHaveLength(0);

		const replay = harness();
		replay.sink.start("t1", "bash", { command: "x" });
		replay.add(2000);
		replay.sink.end(result(), true);
		expect(replay.updates).toHaveLength(0);

		const orphan = harness();
		orphan.add(2000);
		orphan.sink.end(result());
		expect(orphan.updates).toHaveLength(0);

		const duplicate = harness();
		duplicate.sink.start("t1", "bash", { command: "x" });
		duplicate.add(2000);
		duplicate.sink.end(result());
		duplicate.sink.end(result());
		expect(duplicate.updates).toHaveLength(1);
	});

	it("tolerates an append-only consumer without an update callback", () => {
		let now = 0;
		const appended: string[] = [];
		const sink = createToolSink(
			(block) => appended.push(block.kind),
			undefined,
			() => now,
		);
		sink.start("t1", "bash", { command: "x" });
		now += 2000;
		sink.end(result());
		expect(appended).toEqual(["input", "output"]);
	});

	it("finalize clears any elapsedMs from the interrupted block (I6)", () => {
		const { sink, blocks, updates } = harness();
		sink.start("t1", "bash", { command: "x" });
		blocks[0]!.elapsedMs = 2300; // simulate any future writer leaving a stale field
		sink.finalize();
		expect(updates).toHaveLength(1);
		expect(updates[0]!.next.title).toContain("interrupted");
		expect(updates[0]!.next.elapsedMs).toBeUndefined();
	});
});
