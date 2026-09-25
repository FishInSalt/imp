import { describe, expect, it, vi } from "vitest";
import type { ToolPresentationHooks } from "../src/core/tools/types.js";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import { outputBlock, preparedInputBlock, sanitizeDisplay } from "../src/repl/tool-presentation.js";
import { prepareCall, prepareResult } from "../src/repl/tool-presentation-hooks.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { visibleWidth } from "../src/tui.js";

const field = { label: "Query", value: "trimmed", consumes: ["query"] };
const resolve = (fields: unknown) => () =>
	({ call: () => ({ summary: "compact", argumentFields: fields }) }) as ToolPresentationHooks;
const text = (fold: ToolBlockFold, width = 200) => sanitizeDisplay(fold.render(width).join("\n"));
const result = {
	toolCallId: "id",
	toolName: "custom",
	content: "error\nerror\n error\nERROR\n\x1b[31merror",
	isError: true,
};

describe("tool display polish", () => {
	it("freezes owned fields, defaults and unknown values while retaining original JSON", () => {
		const fields = [field, { label: "Default", value: "off", consumes: [], default: true }];
		const record = prepareCall(
			"id",
			"custom",
			{ query: " trimmed ", empty: "", nil: null, bool: false, nested: { x: 1 } },
			resolve(fields),
		);
		expect(Object.isFrozen(record.callSemantic?.argumentFields)).toBe(true);
		expect(Object.isFrozen(record.callSemantic?.argumentFields?.[0]?.consumes)).toBe(true);
		const fold = new ToolBlockFold(preparedInputBlock(record));
		expect(text(fold)).toContain("● custom  compact");
		expect(text(fold).match(/Ctrl\+O/g)).toHaveLength(1);
		fold.setExpanded(true);
		expect(text(fold)).toContain("Default (default): off");
		expect(text(fold)).toContain('empty: ""');
		expect(text(fold)).toContain("nil: null");
		expect(text(fold)).toContain("bool: false");
		expect(text(fold)).toContain("Other arguments");
		expect(text(fold)).not.toContain("compact");
		fold.setRawArguments(true);
		expect(text(fold)).toContain("Raw arguments");
		expect(text(fold)).toContain('"query": " trimmed "');
		expect(text(fold)).not.toContain("Alt+O");
	});
	it.each([
		[{ ...field, consumes: [] }],
		[{ ...field, consumes: ["missing"] }],
		[{ ...field, consumes: ["query", "query"] }],
		[field, field],
		[{ ...field, default: false }],
		[{ ...field, default: true }],
		[{ ...field, label: "" }],
		[{ ...field, label: "x".repeat(257) }],
		[{ ...field, value: "x".repeat(16385) }],
		[{ ...field, extra: true }],
		Array(1),
		Object.assign([field], { extra: true }),
		[{ ...field, consumes: Object.assign(["query"], { extra: true }) }],
		[{ ...field, consumes: Array(1) }],
		[{ ...field, [Symbol()]: 1 }],
		[Object.create(field)],
		Array(101).fill(field),
	])("rejects entire malformed field presentation %#", (fields) => {
		expect(prepareCall("id", "custom", { query: "raw" }, resolve(fields)).callSemantic).toBeUndefined();
	});
	it("rejects field accessors, reflective failures, result fields and nonobjects without invoking accessors", () => {
		const get = vi.fn();
		const fields = [Object.defineProperty({ ...field }, "value", { get })];
		expect(prepareCall("id", "custom", { query: "raw" }, resolve(fields)).callSemantic).toBeUndefined();
		expect(get).not.toHaveBeenCalled();
		for (const args of [null, [], 1, "x"])
			expect(prepareCall("id", "custom", args, resolve([])).callSemantic).toBeUndefined();
		expect(
			prepareCall(
				"id",
				"custom",
				{},
				resolve(
					new Proxy([], {
						ownKeys() {
							throw Error();
						},
					}),
				),
			).callSemantic,
		).toBeUndefined();
		expect(
			prepareResult(undefined, result, false, () => ({
				result: () => ({ summary: "x", argumentFields: [] }),
			})),
		).toBeUndefined();
	});
	it("accepts multi-key and prototype-like ownership and enforces the combined text budget", () => {
		const args = JSON.parse('{"__proto__": 1, "query": "x"}');
		expect(
			prepareCall("id", "custom", args, resolve([{ ...field, consumes: ["query", "__proto__"] }]))
				.callSemantic,
		).toBeDefined();
		expect(
			prepareCall(
				"id",
				"custom",
				{},
				resolve(
					Array.from({ length: 7 }, () => ({
						label: "x",
						value: "x".repeat(16000),
						consumes: [],
						default: true,
					})),
				),
			).callSemantic,
		).toBeUndefined();
	});
	it("deduplicates only exact original error lines, preserving sanitizer collisions and expanded originals", () => {
		const block = outputBlock(result);
		expect(block.collapsedLines).toEqual([" error", "ERROR", "error"]);
		const fold = new ToolBlockFold(block);
		expect(text(fold)).toContain("⎿ failed");
		expect(text(fold)).not.toContain("wrapped rows omitted");
		fold.setExpanded(true);
		expect(block.sections?.[0]?.lines).toEqual(["error", "error", " error", "ERROR", "error"]);
		const only = new ToolBlockFold(outputBlock({ ...result, content: "error\nerror" }));
		expect(text(only)).not.toContain("(no output)");
		expect(text(only).match(/error/g)).toHaveLength(1);
	});
	it("deduplicates semantic physical lines against the raw promoted diagnostic only when collapsed", () => {
		const raw = { ...result, content: "error\ndetail" };
		const block = outputBlock(raw);
		block.semantic = prepareResult(undefined, raw, false, () => ({
			result: () => ({ summary: "error", preview: ["detail"] }),
		}));
		const fold = new ToolBlockFold(block);
		expect(text(fold).match(/error/g)).toHaveLength(1);
		expect(text(fold)).toContain("detail");
		fold.setExpanded(true);
		expect(text(fold)).toContain("    error\n    detail");
		expect(text(fold)).not.toContain("Result text");
		expect(block.sections?.[0]?.lines).toEqual(["error", "detail"]);

		for (const diagnostic of ["error", "\x1b[31merror"]) {
			const raw = { ...result, content: `${diagnostic}\ndetail` };
			const collision = diagnostic === "error" ? "\x1b[31merror" : "error";
			const block = outputBlock(raw);
			block.semantic = prepareResult(undefined, raw, false, () => ({
				result: () => ({ summary: `${diagnostic}\n${collision}`, preview: [`${diagnostic}\n error\nERROR`] }),
			}));
			const fold = new ToolBlockFold(block);
			expect(text(fold).match(/error/g)).toHaveLength(3);
			expect(text(fold)).toContain("    ERROR");
			expect(text(fold)).not.toContain("wrapped rows omitted");
		}
	});
	it("advertises reachable payload even when it equals its section caption", () => {
		const raw = { ...result, content: "Result text", isError: false };
		const block = outputBlock(raw);
		block.semantic = prepareResult(undefined, raw, false, () => ({
			result: () => ({ summary: "Summary" }),
		}));
		const fold = new ToolBlockFold(block);
		expect(text(fold)).toContain("… more · Ctrl+O");
		fold.setExpanded(true);
		expect(text(fold).match(/Result text/g)).toHaveLength(1);
	});
	it.each([3, 4])("omits narrow result decoration consistently at width %i", (width) => {
		const fold = new ToolBlockFold(outputBlock({ ...result, content: "abcde\nz", isError: false }));
		expect(text(fold, width)).toBe(width === 3 ? "abc\nde\nz" : "abcd\ne\nz");
		fold.setExpanded(true);
		const rows = fold.render(width);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		expect(sanitizeDisplay(rows.join("\n"))).not.toContain("⎿");
	});
	it("keeps mode transcript-local, inherited, independent of expansion and invocation-free", () => {
		const sink = new TranscriptSink();
		expect(sink.toggleRawToolArguments()).toBe(false);
		const hook = vi.fn(() => ({ summary: "compact", argumentFields: [field] }));
		sink.toolSink.setResolver(() => ({ call: hook }));
		const append = (id: string) => {
			sink.toolSink.start(id, "custom", { query: " original " });
			sink.toolSink.end({ ...result, toolCallId: id });
		};
		append("first");
		const fold = sink.toolFolds[0]!;
		const cached = fold.render(80);
		expect(fold.render(80)).toBe(cached);
		expect(sink.toggleRawToolArguments()).toBe(true);
		expect(fold.isExpanded()).toBe(false);
		fold.setExpanded(true);
		expect(text(fold)).toContain("Raw arguments");
		append("second");
		sink.toolFolds[2]!.setExpanded(true);
		expect(text(sink.toolFolds[2]!)).toContain("Raw arguments");
		for (const w of [1, 2, 5, 40, 80])
			for (const row of fold.render(w)) expect(visibleWidth(row)).toBeLessThanOrEqual(w);
		expect(hook).toHaveBeenCalledTimes(2);
		sink.clear();
		append("third");
		sink.toolFolds[0]!.setExpanded(true);
		expect(text(sink.toolFolds[0]!)).toContain("Query: trimmed");
	});
	it("does not advertise expansion when no additional content exists and aligns result continuations", () => {
		const fold = new ToolBlockFold(outputBlock({ ...result, content: "abcdefghij\nnext", isError: false }));
		expect(text(fold, 12)).toBe("  ⎿ abcdefgh\n    ij\n    next");
		expect(text(fold)).not.toContain("Ctrl+O");
		expect(text(fold)).not.toMatch(/[│┃▸▾]/);
	});
});
