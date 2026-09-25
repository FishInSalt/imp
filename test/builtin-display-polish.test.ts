import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.js";
import { createEditTool } from "../src/core/tools/edit.js";
import {
	bashPresentation,
	editPresentation,
	grepPresentation,
	readPresentation,
	writePresentation,
} from "../src/core/tools/presentation.js";
import type { ToolPresentationHooks } from "../src/core/tools/types.js";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import { outputBlock, preparedInputBlock, sanitizeDisplay } from "../src/repl/tool-presentation.js";
import { prepareCall } from "../src/repl/tool-presentation-hooks.js";
import { visibleWidth } from "../src/tui.js";

const prepare = (name: string, args: unknown, hook: ToolPresentationHooks) =>
	prepareCall("id", name, args, () => hook);
const input = (name: string, args: unknown, hook: ToolPresentationHooks) =>
	new ToolBlockFold(preparedInputBlock(prepare(name, args, hook)));
const output = (content: string, isError = false, toolName = "bash", display?: string) =>
	outputBlock({
		toolCallId: "id",
		toolName,
		content,
		isError,
		...(display === undefined ? {} : { display }),
	});
const text = (fold: ToolBlockFold, width = 120) => sanitizeDisplay(fold.render(width).join("\n"));
const artifact = (value: string) =>
	`[output truncated: only the tail is shown above. ${value} — read it with the read tool if you need more (tip: pipe through head/tail or narrow the grep to keep output small)]`;

describe("builtin display polish", () => {
	it.each([true, false])("retains exit evidence alongside interruption, exit first %s", (first) => {
		const exit = "Exit code: 7";
		const aborted = "Error: command aborted by user. Partial output:";
		const block = output((first ? [exit, aborted] : [aborted, exit]).join("\n"), true);
		const rendered = text(new ToolBlockFold(block));
		expect(rendered).toContain(block.title === "exit 7" ? "exit 7" : exit);
		expect(rendered).toContain(aborted);
		expect(rendered).not.toContain("Ctrl+O");
	});
	it("retains real bash producer exit and interruption combinations", async () => {
		const tool = createBashTool();
		const signal = new AbortController().signal;
		for (const command of [
			"printf 'Error: command aborted by user. Partial output:\\n'; exit 7",
			"printf 'Exit code: 7\\n'; sleep 1",
		]) {
			const result = await tool.execute({ command, timeout: 0.05 }, signal);
			const rendered = text(new ToolBlockFold(output(String(result.output), result.isError)));
			expect(rendered).toMatch(/exit 7|Exit code: 7/);
			expect(rendered).toMatch(/command (?:aborted|timed out)/);
		}
	});
	it.each(["new", "done"])("advertises only novel reachable semantic detail %s", (detail) => {
		const block = output("done");
		block.semantic = { summary: "done", detail: [detail] };
		const fold = new ToolBlockFold(block);
		expect(text(fold).includes("Ctrl+O")).toBe(detail === "new");
		fold.setExpanded(true);
		expect(text(fold)).toContain(detail);
	});
	it.each([0, 1, 100])("shares semantic detail capacity %i", (capacity) => {
		const block = output("done");
		block.sections![0]!.caption = "x".repeat((999 - capacity) * 16);
		block.semantic = { summary: "done", detail: [...Array(100).fill("done"), "unreachable"] };
		const fold = new ToolBlockFold(block);
		expect(text(fold, 20)).not.toContain("Ctrl+O");
		block.semantic = { summary: "done", detail: ["\x1b[31m新 detail", ...Array(100).fill("done")] };
		fold.invalidate();
		expect(text(fold, 20).includes("Ctrl+O")).toBe(capacity > 0);
		fold.setExpanded(true);
		const rows = fold.render(20);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(20);
		expect(text(fold, 20).includes("新 detail")).toBe(capacity > 0);
	});
	it("attaches pure call-only hooks to actual bash and edit factories", () => {
		expect(createBashTool().presentation).toBe(bashPresentation);
		expect(createEditTool().presentation).toBe(editPresentation);
		expect(bashPresentation.result).toBeUndefined();
		expect(editPresentation.result).toBeUndefined();
	});
	it.each([undefined, 0.25, 900])("preserves literal bash command and supplied timeout %s", (timeout) => {
		const command = 'printf "%s\\n" "你好"\necho done';
		const record = prepare(
			"bash",
			{ command, ...(timeout === undefined ? {} : { timeout }) },
			bashPresentation,
		);
		expect(record.callSemantic?.argumentFields?.map((f) => f.value)).toEqual([
			command,
			...(timeout === undefined ? [] : [String(timeout)]),
		]);
		const fold = new ToolBlockFold(preparedInputBlock(record));
		fold.setExpanded(true);
		expect(text(fold)).toContain('Command:\n      printf "%s\\n" "你好"');
		expect(text(fold)).not.toContain('"command":');
	});
	it.each([0, -1, Infinity, "5", null])("rejects invalid bash timeout %s", (timeout) => {
		expect(prepare("bash", { command: "true", timeout }, bashPresentation).callSemantic).toBeUndefined();
	});
	it("owns complete edit array atomically and retains unknown top-level arguments", () => {
		const edits = [
			{ oldText: "", newText: '""' },
			{ oldText: "oldText:\nReplacement 1\n", newText: "新\nnewText:" },
		];
		const record = prepare("edit", { path: "f", edits, "extra:key\nnext": 42 }, editPresentation);
		expect(record.callSemantic?.summary).toBe("2 replacements");
		expect(record.callSemantic?.argumentFields?.map((f) => f.consumes)).toEqual([["path"], ["edits"]]);
		expect(record.callSemantic?.argumentFields?.[1]?.value).toBe(
			'Replacement 1\noldText: (empty string)\nnewText:\n  ""\nReplacement 2\noldText:\n  oldText:\n  Replacement 1\n  \nnewText:\n  新\n  newText:',
		);
		const fold = new ToolBlockFold(preparedInputBlock(record));
		expect(text(fold)).toContain("Ctrl+O");
		fold.setExpanded(true);
		expect(text(fold)).toContain("Other arguments\n    extra:key\n    next:\n      42");
		fold.setRawArguments(true);
		expect(text(fold)).toContain('"oldText": ""');
		expect(record.rawArgs).toEqual({ path: "f", edits, "extra:key\nnext": 42 });
	});
	it.each(
		[[], [{ oldText: "a", newText: "b", extra: true }], [{ oldText: 1, newText: "b" }], [null]].map(
			(edits) => [edits],
		),
	)("rejects unrepresentable edit arrays %#", (edits) => {
		const record = prepare("edit", { path: "f", edits }, editPresentation);
		expect(record.callSemantic).toBeUndefined();
		expect(JSON.parse(record.rawArgsText).edits).toEqual(edits);
	});
	it("preflights complete formatted replacement boundary", () => {
		const overhead =
			prepare("edit", { path: "f", edits: [{ oldText: "x", newText: "y" }] }, editPresentation).callSemantic!
				.argumentFields![1]!.value.length - 1;
		for (const n of [16384, 16385]) {
			const record = prepare(
				"edit",
				{ path: "f", edits: [{ oldText: "x".repeat(n - overhead), newText: "y" }] },
				editPresentation,
			);
			if (n === 16384) expect(record.callSemantic?.argumentFields?.[1]?.value).toHaveLength(n);
			else expect(record.callSemantic).toBeUndefined();
			expect(record.rawArgsText).toContain("x".repeat(n - overhead));
		}
		expect(prepare("bash", { command: "x".repeat(16385) }, bashPresentation).callSemantic).toBeUndefined();
	});
	it.each(["short", "long/".repeat(80), "多字😀", "a\nb", "a\x1b[31mb", ""])(
		"preserves one complete path owner %j",
		(path) => {
			const fold = input("read", { path }, readPresentation);
			expect(fold.block.callPath?.requested).toBe(path);
			for (const width of [1, 2, 20, 80, 120]) {
				for (const raw of [false, true]) {
					fold.setRawArguments(raw);
					fold.setExpanded(false);
					for (const row of fold.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
					fold.setExpanded(true);
					for (const row of fold.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				}
			}
			fold.setRawArguments(false);
			expect(text(fold)).not.toContain("Path:");
		},
	);
	it("uses full exact raw ownership, never summary excerpts or sanitized collisions", () => {
		const hook: ToolPresentationHooks = {
			call: () => ({
				summary: "prefix",
				argumentFields: [{ label: "Path", value: "ab", consumes: ["path"] }],
			}),
		};
		const fold = input("read", { path: "a\x1b[31mb" }, hook);
		fold.setExpanded(true);
		expect(text(fold).match(/Path:/g)).toHaveLength(2);
		const late = input("write", { content: "x".repeat(16384), path: "late-path" }, writePresentation);
		late.setRawArguments(true);
		late.setExpanded(true);
		expect(text(late, 20)).toContain("late-path");
		late.setRawArguments(false);
		expect(text(late, 20)).not.toContain("Path:");
	});
	it("keeps effective empty and missing search path explicit without absent option rows", () => {
		for (const args of [{ pattern: "x" }, { pattern: "x", path: "" }]) {
			const fold = input("grep", args, grepPresentation);
			expect(text(fold)).toContain("Path:");
			fold.setExpanded(true);
			expect(text(fold)).not.toContain("Timeout");
			expect(text(fold).match(/Path/g)).toHaveLength(1);
		}
	});
	it("promotes single exits without duplicate rows or separator omissions", () => {
		for (const content of ["Exit code: 7", "\n\nExit code: 7\n\n", "stdout:\nhello\n\nExit code: 7\n"]) {
			const fold = new ToolBlockFold(output(content, true));
			expect(text(fold).match(/exit 7/g)).toHaveLength(1);
			expect(text(fold)).not.toContain("Exit code");
			expect(text(fold)).not.toContain("omitted");
			expect(text(fold)).not.toContain("Ctrl+O");
			fold.setExpanded(true);
			expect(text(fold)).toContain("Exit code: 7");
		}
	});
	it("retains conflicting exits and almost-matching spoof text", () => {
		const fold = new ToolBlockFold(output("Exit code: 2\nExit code: 3\nExit code: 2"));
		expect(text(fold)).toContain("failed");
		expect(text(fold).match(/Exit code: 2/g)).toHaveLength(1);
		expect(text(fold)).toContain("Exit code: 3");
		const block = output("prefix Exit code: 2\n\x1b[31mExit code: 3");
		expect(block.title).toBe("");
		expect(block.hostNotices).toEqual([]);
	});
	it("suppresses only exact promoted diagnostic occurrences and retains repeated payload", () => {
		const raw = "bad\nbad\n\x1b[31mbad\nsame\nsame\nsame\nsame";
		const fold = new ToolBlockFold(output(raw, true));
		expect(text(fold).match(/bad/g)).toHaveLength(2);
		expect(text(fold)).toContain("Ctrl+O");
		fold.setExpanded(true);
		expect(text(fold).match(/same/g)).toHaveLength(4);
		expect(fold.block.sections?.[0]?.originalLines).toEqual(raw.split("\n"));
	});
	it.each([
		["Full output saved to /tmp/full.log", "Full output: /tmp/full.log", "full"],
		[
			"Partial output saved to /tmp/partial.log (command interrupted; all observed bytes retained)",
			"all observed bytes retained",
			"partial",
		],
		[
			"Partial output saved to /tmp/partial.log (artifact prefix capped; per-stream limit 10485760 bytes)",
			"10485760 bytes",
			"partial",
		],
		[
			"Partial output saved to /tmp/partial.log (command interrupted; artifact prefix capped; per-stream limit 10485760 bytes)",
			"command interrupted; artifact prefix capped",
			"partial",
		],
	])("renders artifact facts after body: %s", (value, qualifier, completeness) => {
		const raw = `payload\n\n${artifact(value)}`;
		const block = output(raw);
		expect(block.hostNotices?.[0]?.artifact?.completeness).toBe(completeness);
		const fold = new ToolBlockFold(block);
		const rendered = text(fold, 500);
		expect(rendered.indexOf("payload")).toBeLessThan(rendered.indexOf("Output truncated"));
		expect(rendered).toContain(qualifier);
		expect(rendered).not.toContain("shown above");
		expect(rendered).not.toContain("Ctrl+O");
		fold.setExpanded(true);
		expect(text(fold, 500)).toContain(artifact(value));
		expect(block.sections?.[0]?.originalLines?.join("\n")).toBe(raw);
	});
	it("never describes historical capped artifacts as full and preserves unavailable reasons", () => {
		const fold = new ToolBlockFold(
			output(`${artifact("Full output saved to /tmp/old.log")}\n[full output itself capped at 10MB]`),
		);
		expect(text(fold)).toContain("Partial output: /tmp/old.log (prefix capped; 10MB)");
		expect(text(fold)).not.toContain("Full output:");
		const failed = new ToolBlockFold(
			output(
				"[output truncated: only the tail is shown; saving the output artifact failed (tip: pipe through head/tail or narrow the grep to keep output small)]",
			),
		);
		expect(text(failed)).toContain("Output artifact unavailable (save failed)");
	});
	it("discovers notices after retention and preserves distinct raw paths that sanitize alike", () => {
		const first = artifact("Full output saved to /tmp/ab");
		const second = artifact("Full output saved to /tmp/a\x1b[31mb");
		const block = output(`${"row\n".repeat(1001)}${first}\n${second}\n${first}`);
		expect(block.hostNotices).toHaveLength(2);
		expect(block.hostNotices?.[0]?.sources.filter((s) => s.section === "result-content")).toHaveLength(2);
		expect(text(new ToolBlockFold(block)).match(/Full output:/g)).toHaveLength(2);
		expect(block.sections?.[0]?.discarded).toBe(4);
	});
	it.each([1, 2, 20, 80, 120])("keeps giant notice paths complete outside body caps at width %i", (width) => {
		const path = `/tmp/${"deep/".repeat(250)}file`;
		const fold = new ToolBlockFold(output(`payload\n${artifact(`Full output saved to ${path}`)}`));
		const rendered = fold.render(width);
		for (const row of rendered) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		expect(sanitizeDisplay(rendered.join("")).replaceAll(" ", "")).toContain(path);
	});
	it("counts repeated blank payload and does not advertise evidence beyond caption cap", () => {
		const fold = new ToolBlockFold(output("a\nb\nc\n\n\n"));
		expect(text(fold)).toContain("Ctrl+O");
		fold.block.sections![0]!.caption = "x".repeat(1000);
		fold.invalidate();
		expect(text(fold, 1).replaceAll("\n", "")).not.toContain("Ctrl+O");
		expect(text(fold, 1).replaceAll("\n", "")).toContain("2 wrapped rows omitted");
	});
});
