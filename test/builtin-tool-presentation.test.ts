import { describe, expect, it } from "vitest";
import {
	findPresentation,
	grepPresentation,
	lsPresentation,
	readPresentation,
	taskPresentation,
	writePresentation,
} from "../src/core/tools/presentation.js";
import type { ToolPresentationHooks } from "../src/core/tools/types.js";
import { prepareCall } from "../src/repl/tool-presentation-hooks.js";

const call = (hooks: ToolPresentationHooks, args: unknown) => prepareCall("id", "tool", args, () => hooks);
const cases = [
	[writePresentation, { path: "f", content: "" }, ["path", "content"]],
	[readPresentation, { path: "f" }, ["path"]],
	[grepPresentation, { pattern: "x" }, ["pattern"]],
	[findPresentation, { pattern: "*" }, ["pattern"]],
	[lsPresentation, {}, []],
	[taskPresentation, { prompt: "p" }, ["prompt"]],
] as const;
describe("builtin call presentations", () => {
	it.each(cases)("owns only supplied known fields, defaults own nothing: %#", (hooks, args, keys) => {
		const record = call(hooks, { ...args, unknown: { nested: ["retained"] } });
		expect(hooks.result).toBeUndefined();
		expect(record.callSemantic).toBeDefined();
		expect(record.callSemantic?.argumentFields?.flatMap((f) => f.consumes)).toEqual(keys);
		for (const field of record.callSemantic?.argumentFields ?? [])
			expect(field.default === true).toBe(field.consumes.length === 0);
		expect(record.rawArgsText).toContain("retained");
	});
	it.each(cases)("rejects invalid/unavailable snapshots: %#", (hooks) => {
		for (const args of [
			null,
			[],
			"x",
			{ path: null, content: null, pattern: null, prompt: null },
			{ path: true },
		])
			expect(call(hooks, args).callSemantic).toBeUndefined();
		expect(hooks.call?.({ toolCallId: "id", toolName: "x", args: {}, argsAvailable: false })).toBeUndefined();
		const unsafe = Object.defineProperty({}, "path", {
			get() {
				throw Error("must not access");
			},
			enumerable: true,
		});
		expect(call(hooks, unsafe).serializationStatus).toBe("unavailable");
	});
	it("preserves every known supplied field and effective search values", () => {
		const args = {
			pattern: "a\nb",
			path: "",
			glob: "",
			ignoreCase: false,
			literal: true,
			context: -0.2,
			limit: 2000.8,
			timeout: 0,
		};
		const semantic = call(grepPresentation, args).callSemantic!;
		expect(semantic.argumentFields?.map((f) => f.value)).toEqual([
			"a\nb",
			'"" (effective: .)',
			'"" (no filter)',
			"false",
			"true",
			"-0.2 (effective: 0)",
			"2000.8 (effective: 1000)",
			"0 (effective: 1)",
		]);
		expect(semantic.summary).toBe("a\\nb · path .");
		expect(semantic.argumentFields?.flatMap((f) => f.consumes)).toEqual(Object.keys(args));
		expect(call(findPresentation, { pattern: "*", type: "both" }).callSemantic).toBeUndefined();
		expect(
			call(findPresentation, { pattern: "*", type: "directory", hidden: true }).callSemantic?.summary,
		).toContain("type directory");
		expect(call(lsPresentation, { limit: 2.9 }).callSemantic?.argumentFields?.[1]?.value).toBe(
			"2.9 (effective: 2)",
		);
	});
	it("describes inheritance and read requests, not resolved configuration or returned ranges", () => {
		expect(
			call(taskPresentation, { prompt: 'a\n"b"\\c' }).callSemantic?.argumentFields?.map((f) => f.value),
		).toEqual([
			'a\n"b"\\c',
			"generic subagent",
			"inherited from agent/host",
			"inherited from agent; otherwise false",
		]);
		expect(
			call(taskPresentation, {
				prompt: "p",
				agent: "review",
				timeoutMs: 1234,
				worktree: false,
				timeout: 50,
			}).callSemantic?.argumentFields?.map((f) => f.value),
		).toEqual(["p", "review", "1234", "false"]);
		expect(call(readPresentation, { path: "image.png", offset: 9, limit: 3000 }).callSemantic?.summary).toBe(
			"image.png · from line 9 · up to 3000 requested",
		);
		for (const key of ["offset", "limit"])
			for (const v of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, null, "2"])
				expect(call(readPresentation, { path: "f", [key]: v }).callSemantic).toBeUndefined();
		for (const args of [{ agent: "" }, { worktree: null }, { timeoutMs: 999 }, { timeoutMs: 1000.5 }])
			expect(call(taskPresentation, { prompt: "p", ...args }).callSemantic).toBeUndefined();
	});
	it("rejects wrong types for all optional known fields", () => {
		for (const key of ["path", "glob", "ignoreCase", "literal", "context", "limit", "timeout"])
			expect(call(grepPresentation, { pattern: "x", [key]: null }).callSemantic).toBeUndefined();
		for (const v of [NaN, Infinity, "2", false])
			expect(call(lsPresentation, { limit: v }).callSemantic).toBeUndefined();
	});
	it.each(["", "\n", "a\n", "a\r\nb", "你好😀", 'const s = "\\n";\n'])(
		"counts exact writer bytes and lines for %j",
		(content) => {
			const semantic = call(writePresentation, { path: "f", content }).callSemantic!;
			const lines = content === "" ? 0 : content.split("\n").length - Number(content.endsWith("\n"));
			expect(semantic.summary).toBe(`f · ${lines} lines · ${Buffer.byteLength(content)} bytes`);
			expect(semantic.argumentFields?.[1]?.value).toBe(content);
		},
	);
	it("keeps complete fields at the boundary, rejects oversize before counting, and bounds excerpts", () => {
		for (const [hooks, key, other] of [
			[writePresentation, "content", { path: "f" }],
			[taskPresentation, "prompt", {}],
		] as const) {
			expect(
				call(hooks, { ...other, [key]: "x".repeat(16384) }).callSemantic?.argumentFields?.find((f) =>
					f.consumes.includes(key),
				)?.value,
			).toHaveLength(16384);
			for (const n of [16385, 1000001]) {
				const record = call(hooks, { ...other, [key]: "x".repeat(n) });
				expect(record.callSemantic).toBeUndefined();
				expect(record.rawArgsText).toContain("x".repeat(n));
			}
		}
		const semantic = call(writePresentation, { path: "😀".repeat(161), content: "" }).callSemantic!;
		expect(semantic.summary).toBe(`${"😀".repeat(160)}… · 0 lines · 0 bytes`);
		expect(
			call(writePresentation, { path: "\u001b[31m\n\t", content: "" }).callSemantic?.summary,
		).not.toMatch(/\p{Cc}/u);
		// No builtin can reach the 100000-unit total with individually valid fields;
		// even grep has only three strings. Large unknown values are not traversed/owned.
		expect(
			call(grepPresentation, {
				pattern: "x".repeat(16384),
				path: "y".repeat(16384),
				glob: "z".repeat(16384),
				unknown: "u".repeat(100001),
			}).callSemantic,
		).toBeDefined();
	});
});
