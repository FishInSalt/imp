import { describe, expect, it, vi } from "vitest";
import {
	activityCount,
	activityText,
	ToolActivity,
	ToolBlockFold,
} from "../src/repl/components/tool-block.js";
import {
	createToolSink,
	outputBlock,
	sanitizeDisplay,
	type ToolBlock,
} from "../src/repl/tool-presentation.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { visibleWidth } from "../src/tui.js";

const result = (id: string) => ({ toolCallId: id, toolName: "extension", content: "done", isError: false });
describe("task live lifecycle", () => {
	it("prepares silently, snapshots once, rejects duplicate starts/results and reuses ids after boundaries", () => {
		const blocks: ToolBlock[] = [];
		const call = vi.fn(() => ({ summary: "call" }));
		const finish = vi.fn(() => ({ summary: "result" }));
		const sink = createToolSink((b) => blocks.push(b));
		sink.setResolver(() => ({ call, result: finish }));
		const args = { prompt: "original" };
		const prepared = sink.prepare("a", "extension", args);
		args.prompt = "changed";
		expect(blocks).toEqual([]);
		sink.start("a", "extension", args);
		sink.start("a", "extension", {});
		expect(blocks).toHaveLength(1);
		expect(prepared.rawArgs).toEqual({ prompt: "original" });
		sink.end(result("a"));
		sink.end({ ...result("a"), content: "different" });
		sink.start("a", "extension", {});
		expect(blocks).toHaveLength(2);
		expect(call).toHaveBeenCalledTimes(1);
		expect(finish).toHaveBeenCalledTimes(1);
		sink.prepare("silent", "extension", {});
		sink.finalize();
		sink.finalize();
		expect(blocks).toHaveLength(2);
		sink.prepare("a", "extension", {});
		sink.end(result("a"));
		expect(blocks).toHaveLength(4);
		sink.clear();
		sink.end(result("a"));
		sink.end(result("a"));
		expect(blocks).toHaveLength(6);
		expect(blocks[4]?.lines).toEqual(["Arguments unavailable"]);
	});
	it("updates interrupted semantic inputs in place preserving expansion, raw state, position and cache", () => {
		const transcript = new TranscriptSink();
		transcript.toolSink.setResolver(() => ({
			call: () => ({
				summary: "semantic header",
				argumentFields: [{ label: "Prompt", value: "inspect me", consumes: ["prompt"] }],
			}),
		}));
		transcript.toolSink.start("a", "extension", { prompt: "inspect me" });
		const fold = transcript.toolFolds[0]!;
		fold.setExpanded(true);
		transcript.toggleRawToolArguments();
		const before = fold.render(80);
		transcript.feed("tail\n");
		transcript.toolSink.finalize();
		transcript.toolSink.finalize();
		expect(transcript.toolFolds).toEqual([fold]);
		expect(fold.isExpanded()).toBe(true);
		expect(fold.render(80)).not.toEqual(before);
		const text = sanitizeDisplay(transcript.render(80).join("\n"));
		expect(text).toContain("interrupted (no result)");
		expect(text.indexOf("interrupted")).toBeLessThan(text.indexOf("tail"));
		transcript.clear();
		transcript.toolSink.start("a", "extension", {});
		expect(transcript.toolFolds).toHaveLength(1);
		expect(transcript.toolFolds[0]).not.toBe(fold);
	});
	it("marks lifecycle before reentrant callbacks", () => {
		const blocks: ToolBlock[] = [];
		const sink = createToolSink((block) => {
			blocks.push(block);
			sink.start("a", "extension", {});
			if (block.kind === "output") sink.end(result("a"));
		});
		sink.start("a", "extension", {});
		sink.end(result("a"));
		expect(blocks.map((b) => b.kind)).toEqual(["input", "output"]);
	});
});
describe("bounded structured activity", () => {
	it.each([1, 2, 20, 80])("keeps three independent safe rows at width %i", (width) => {
		const row = new ToolActivity("", "");
		row.setTaskRows([
			`pending #2 ${"界".repeat(3000)}`,
			"prompt\n\r\u2028\u2029\t\x1b[31mred",
			`last: \x1b]0;title\x07${"e\u0301".repeat(3000)}`,
		]);
		const rendered = row.render(width);
		expect(rendered).toHaveLength(3);
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(sanitizeDisplay(line)).not.toMatch(/[\n\r\u2028\u2029]/u);
		}
		expect(activityText(`${"a".repeat(2047)}😀`)).toHaveLength(2047);
		expect(activityCount(Infinity)).toBe("0");
		expect(activityCount(10000)).toBe("9999+");
	});
});
describe("generic promoted evidence", () => {
	it.each(["task", "extension"])(
		"removes only redundant %s metadata, preserving repetitions and separate sources",
		(toolName) => {
			const raw = 'unknown agent "scout"';
			const fold = new ToolBlockFold(
				outputBlock({
					...result("a"),
					toolName,
					content: `${raw}\n${raw}\ndistinct error`,
					display: `${raw}\ndisplay only`,
					isError: true,
				}),
			);
			expect(sanitizeDisplay(fold.render(100).join("\n"))).toContain(raw);
			fold.setExpanded(true);
			const text = sanitizeDisplay(fold.render(100).join("\n"));
			expect(text.split(raw).length - 1).toBe(3);
			expect(text).toContain("distinct error");
			expect(text).toContain("failed");
		},
	);
	it.each([999, 1000, 1001])("does not suppress evidence outside the body cap at source line %i", (line) => {
		const raw = "error: diagnostic";
		const content = [...Array(line - 1).fill("padding"), raw].join("\n");
		const block = outputBlock({ ...result("a"), content, isError: true });
		// Select this diagnostic explicitly to isolate source-coverage proof from promotion heuristics.
		block.metadata = [raw];
		block.promotedDiagnostic = raw;
		block.promotedEvidence = { raw, sources: [{ section: "result-content", index: line - 1 }] };
		const fold = new ToolBlockFold(block);
		fold.setExpanded(true);
		expect(sanitizeDisplay(fold.render(100).join("\n"))).toContain(raw);
	});
	it.each([
		{ content: "different", raw: "error: wanted", width: 80 },
		{ content: "\x1b[31merror: wanted", raw: "error: wanted", width: 80 },
		{ content: "界", raw: "界", width: 1 },
		{
			content: `${Array(999).fill("p").join("\n")}\nerror: wraps across cap`,
			raw: "error: wraps across cap",
			width: 10,
		},
	])("keeps host metadata without complete exact original evidence %#", ({ content, raw, width }) => {
		const block = outputBlock({ ...result("a"), content, isError: true });
		block.metadata = [raw];
		block.promotedDiagnostic = raw;
		block.promotedEvidence = {
			raw,
			sources: [{ section: "result-content", index: content.split("\n").length - 1 }],
		};
		const fold = new ToolBlockFold(block);
		fold.setExpanded(true);
		const withEvidence = fold.render(width);
		block.promotedEvidence = undefined;
		fold.invalidate();
		expect(fold.render(width)).toEqual(withEvidence);
	});
});
