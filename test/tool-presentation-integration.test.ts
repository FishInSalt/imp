import { describe, expect, it, vi } from "vitest";
import type { ToolPresentationHooks } from "../src/core/tools/types.js";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import { createToolSink, sanitizeDisplay, type ToolBlock } from "../src/repl/tool-presentation.js";

const result = (id: string, content = "original result") => ({
	toolCallId: id,
	toolName: "unrelated_extension",
	content,
	isError: false,
});
describe("presentation integration", () => {
	it("shares calls, captures registry hooks, pairs parallel completions and preserves original sections", () => {
		const blocks: ToolBlock[] = [];
		const call = vi.fn((ctx) => ({ summary: `query ${ctx.args.query}` }));
		const finish = vi.fn((ctx) => ({ summary: `result ${ctx.args.query}`, detail: ["detail"] }));
		let hooks: ToolPresentationHooks = { call, result: finish };
		const sink = createToolSink((b) => blocks.push(b));
		sink.setResolver(() => hooks);
		const args = { query: "first", unknown: "preserve" };
		const record = sink.prepare("a", "unrelated_extension", args);
		sink.start("a", "unrelated_extension", args);
		args.query = "mutated";
		sink.start("b", "unrelated_extension", { query: "second" });
		hooks = {
			result: () => {
				throw new Error("replacement must not run");
			},
		};
		sink.end({ ...result("b"), display: "live display" });
		sink.end(result("a"));
		expect(call).toHaveBeenCalledTimes(2);
		expect(finish).toHaveBeenCalledTimes(2);
		expect(blocks.map((b) => b.id)).toEqual(["a", "b", "b", "a"]);
		expect(record.callSemantic?.summary).toBe("query first");
		const fold = new ToolBlockFold(blocks[2]!);
		expect(sanitizeDisplay(fold.render(80).join("\n"))).toContain("result second");
		fold.setExpanded(true);
		const expanded = sanitizeDisplay(fold.render(80).join("\n"));
		expect(expanded).toContain("Result text");
		expect(expanded).toContain("original result");
		expect(expanded).toContain("Live display");
		expect(expanded).toContain("live display");
		fold.render(1);
		fold.render(120);
		fold.toggle();
		fold.render(40);
		expect(call).toHaveBeenCalledTimes(2);
		expect(finish).toHaveBeenCalledTimes(2);
	});
	it("supports replay, orphan results and absent extensions without hiding errors", () => {
		const blocks: ToolBlock[] = [];
		const finish = vi.fn(() => ({ summary: "success claim" }));
		const sink = createToolSink((b) => blocks.push(b));
		sink.setResolver(() => ({ result: finish }));
		sink.end({ ...result("orphan"), isError: true }, true);
		expect(finish.mock.calls).toHaveLength(1);
		expect(blocks[1]?.error).toBe(true);
		expect(blocks[1]?.title).toBe("failed");
		sink.setResolver(() => undefined);
		sink.start("old", "missing_extension", { historical: true });
		sink.end(result("old"), true);
		expect(blocks[3]?.semantic).toBeUndefined();
		expect(blocks[3]?.sections?.[0]?.lines).toEqual(["original result"]);
	});
	it("never retraverses unsafe fallback arguments and clears pending snapshots", () => {
		const getter = vi.fn(() => "secret");
		const args = Object.defineProperty({}, "bad", { get: getter, enumerable: true });
		const blocks: ToolBlock[] = [];
		const sink = createToolSink((b) => blocks.push(b));
		sink.start("a", "unrelated_extension", args);
		sink.end(result("a"));
		expect(getter).not.toHaveBeenCalled();
		expect(blocks[0]?.metadata.join()).toContain("Arguments unavailable");
		sink.start("pending", "x", {});
		sink.clear();
		sink.finalize();
		expect(blocks.map((b) => b.kind)).toEqual(["input", "output", "input"]);
	});
	it("allocates raw rows before optional detail, counts sections independently and caches layout", () => {
		const blocks: ToolBlock[] = [];
		const sink = createToolSink((b) => blocks.push(b));
		sink.setResolver(() => ({ result: () => ({ summary: "summary", detail: Array(1000).fill("detail") }) }));
		sink.end({
			...result("a", Array(1001).fill("raw").join("\n")),
			display: Array(1002).fill("shown").join("\n"),
		});
		const fold = new ToolBlockFold(blocks[1]!);
		fold.setExpanded(true);
		const rows = fold.render(80);
		expect(fold.render(80)).toBe(rows);
		const text = sanitizeDisplay(fold.render(1000).join("\n"));
		expect(text).toContain("raw");
		expect(text).not.toContain("┃ detail");
		expect(text).toContain("Result text: 1 source lines omitted");
		expect(text).toContain("Live display: 2 source lines omitted");
		expect(text).toContain("Live display: 1001 wrapped rows omitted");
		expect(rows.filter((r) => /^( {4}| {2}⎿ )(raw|Result text)$/.test(sanitizeDisplay(r)))).toHaveLength(
			1000,
		);
	});
});
