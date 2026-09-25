import { describe, expect, it } from "vitest";
import { lsPresentation, readPresentation } from "../src/core/tools/presentation.js";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import { outputBlock, preparedInputBlock, sanitizeDisplay } from "../src/repl/tool-presentation.js";
import { prepareCall } from "../src/repl/tool-presentation-hooks.js";

const timeout = "Error: command timed out after 10s and was killed. Partial output:";
const output = (content: string, display?: string) =>
	outputBlock({ toolCallId: "id", toolName: "bash", content, display, isError: true });
const text = (fold: ToolBlockFold, width = 120) => sanitizeDisplay(fold.render(width).join("\n"));
const occurrences = (value: string, needle: string) => value.split(needle).length - 1;
const input = (args: unknown, name = "read") =>
	new ToolBlockFold(
		preparedInputBlock(
			prepareCall("id", name, args, () => (name === "read" ? readPresentation : lsPresentation)),
		),
	);

describe("source-proven builtin diagnostics", () => {
	it.each(["Exit code: 3", timeout, "[full output itself capped at 10MB]"])(
		"multiline OSC cannot lend filler indices to %s",
		(diagnostic) => {
			for (const content of [
				`\x1b]0;hidden\n${diagnostic}\n\x07visible\nfiller`,
				`\x1b]0;hidden\n\x07visible\n${diagnostic}\nfiller`,
			]) {
				const block = output(content);
				expect(block.sections?.[0]?.originalLines).toBeUndefined();
				expect(block.promotedEvidence?.sources).toEqual([]);
				const fold = new ToolBlockFold(block);
				for (const expanded of [false, true]) {
					fold.setExpanded(expanded);
					const rendered = text(fold);
					expect(rendered).toContain(
						diagnostic === "Exit code: 3"
							? "exit 3"
							: diagnostic === timeout
								? timeout
								: "Output artifact prefix capped at 10MB.",
					);
					// Whole-string OSC removal must not expose its hidden payload as body text.
					expect(rendered).not.toContain("\x07");
				}
			}
		},
	);
	it.each([999, 1000, 1001])("multiline sanitation retains the %i-row source cap", (count) => {
		const block = output(`\x1b]0;hidden\nExit code: 3\n\x07${Array(count).fill("filler").join("\n")}`);
		expect(block.sections?.[0]?.lines).toHaveLength(Math.min(count, 1000));
		expect(block.sections?.[0]?.discarded).toBe(Math.max(0, count - 1000));
		const snapshot = JSON.stringify(block);
		const fold = new ToolBlockFold(block);
		for (const width of [20, 120]) {
			fold.setExpanded(true);
			const rendered = text(fold, width);
			expect(rendered).toContain("exit 3");
			expect(occurrences(rendered, "filler")).toBe(Math.min(count, 1000));
			if (count > 1000) expect(rendered.replace(/\s/g, "")).toContain("1sourcelines");
		}
		expect(JSON.stringify(block)).toBe(snapshot);
	});
	it("does not transfer proof to a sanitized-equal but different raw occurrence", () => {
		const block = output(`\x1b]0;hidden\nExit code: 3\n\x07visible\nfiller`, "\x1b[31mExit code: 3");
		expect(block.titleExitEvidence?.sources).toEqual([]);
		const fold = new ToolBlockFold(block);
		fold.setExpanded(true);
		expect(text(fold)).toContain("exit 3");
	});
	it("escapes an incomplete OSC diagnostic fallback and preserves whole body sanitation", () => {
		const content = "\x1b]0;hidden\nExit code: 3\n\x07visible\nfiller";
		const fold = new ToolBlockFold(output(content));
		fold.setExpanded(true);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: remove renderer-owned SGR only
		const sgr = /\x1b\[[0-9;]*m/g;
		const rendered = fold.render(120).join("\n").replace(sgr, "");
		expect(rendered).toContain("\\x1b]0;hidden");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: assert terminal controls cannot escape
		expect(rendered).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
		expect(rendered).not.toContain("Exit code: 3");
	});
	it.each([1, 2])("retains %i raw timeout occurrences and no expanded host copy", (copies) => {
		const content = [...Array(copies).fill(timeout), "partial output"].join("\n");
		const block = output(content);
		const snapshot = JSON.stringify(block);
		const fold = new ToolBlockFold(block);
		expect(occurrences(text(fold), timeout)).toBe(1);
		fold.setExpanded(true);
		expect(occurrences(text(fold), timeout)).toBe(copies);
		expect(text(fold)).toContain("failed");
		expect(JSON.stringify(block)).toBe(snapshot);
	});
	it.each([1, 2])("raw exit owns numeric status with %i occurrences", (copies) => {
		const fold = new ToolBlockFold(output(Array(copies).fill("Exit code: 3").join("\n")));
		expect(text(fold)).toContain("exit 3");
		fold.setExpanded(true);
		expect(text(fold)).not.toContain("exit 3");
		expect(text(fold)).toContain("failed");
		expect(occurrences(text(fold), "Exit code: 3")).toBe(copies);
	});
	it.each([999, 1000, 1001])("exit boundary %i preserves fallback and omission counts", (line) => {
		const block = output([...Array(line - 1).fill("x"), "Exit code: 3"].join("\n"));
		const snapshot = JSON.stringify(block.sections);
		const fold = new ToolBlockFold(block);
		fold.setExpanded(true);
		expect(text(fold).includes("exit 3")).toBe(line > 1000);
		expect(JSON.stringify(block.sections)).toBe(snapshot);
		if (line > 1000) expect(text(fold)).toContain("1 source lines omitted");
	});
	it("retains conflicting codes and hidden code after timeout final status", () => {
		for (const content of [
			"Exit code: 2\nExit code: 3",
			[timeout, ...Array(1000).fill("x"), "Exit code: 3", timeout].join("\n"),
		]) {
			const fold = new ToolBlockFold(output(content));
			fold.setExpanded(true);
			expect(text(fold)).toContain("failed");
			expect(text(fold)).toContain("Exit code: 3");
			if (content.startsWith("Exit")) expect(text(fold)).toContain("Exit code: 2");
		}
	});
	it("does not use sanitized collisions or matching indices in a different section", () => {
		const raw = `\x1b[31m${timeout}`;
		const block = output([...Array(1000).fill(""), raw].join("\n"), timeout);
		const fold = new ToolBlockFold(block);
		fold.setExpanded(true);
		// Original diagnostic is past source retention; equal safe display cannot own it.
		expect(text(fold)).toContain(timeout);
		expect(block.promotedEvidence?.raw).toBe(raw);
		expect(block.promotedEvidence?.sources).toEqual([{ section: "result-content", index: 1000 }]);
	});
	it("caption consuming the final row prevents display evidence ownership", () => {
		const block = output(Array(998).fill("x").join("\n"), "Exit code: 3");
		const fold = new ToolBlockFold(block);
		fold.setExpanded(true);
		expect(text(fold)).toContain("exit 3");
		expect(text(fold)).toContain("1 wrapped rows omitted");
	});
	it.each([1, 2, 20, 80, 120])("keeps raw arrays and full proof at width %i", (width) => {
		const block = output("界 diagnostic");
		const before = JSON.stringify(block.sections);
		const fold = new ToolBlockFold(block);
		fold.setExpanded(true);
		const compact = text(fold, width).replace(/\s/g, "");
		expect(occurrences(compact, "diagnostic")).toBe(width === 1 ? 2 : 1);
		expect(JSON.stringify(block.sections)).toBe(before);
	});
	it("partial diagnostic wrap retains promoted metadata", () => {
		const diagnostic = "d".repeat(16001);
		const fold = new ToolBlockFold(output(diagnostic));
		fold.setExpanded(true);
		expect(text(fold, 20).replace(/\s/g, "")).toContain("1wrappedrowsomitted");
		expect(
			text(fold, 20)
				.split("\n")
				.filter((row) => /^\s*d+$/.test(row))
				.join("")
				.replace(/\s/g, "").length,
		).toBe(32001);
	});
});

describe("actual builtin header field ownership", () => {
	it.each([false, true])("AGENTS.md limit 30 has no false hint, raw %s", (raw) => {
		const fold = input({ path: "AGENTS.md", limit: 30 });
		fold.setRawArguments(raw);
		expect(text(fold)).toContain("AGENTS.md  up to 30 requested");
		expect(text(fold)).not.toContain("Ctrl+O");
		fold.setExpanded(true);
		expect(text(fold)).toContain(raw ? '"limit": 30' : "Line limit: 30");
	});
	it("recomputes suffix coverage on resizing and mode changes", () => {
		const fold = input({ path: "AGENTS.md", offset: 3, limit: 3000 });
		for (const raw of [false, true, false]) {
			fold.setRawArguments(raw);
			expect(text(fold, 120)).not.toContain("Ctrl+O");
			expect(text(fold, 120)).toContain("from line 3 · up to 3000 requested");
			expect(text(fold, 20)).toContain("Ctrl+O");
			expect(text(fold, 120)).not.toContain("Ctrl+O");
		}
	});
	it.each([30, 2.9, 9000])("ls request %s only owns unchanged effective facts", (limit) => {
		const fold = input({ path: ".", limit }, "ls");
		expect(text(fold).includes("Ctrl+O")).toBe(limit !== 30);
	});
	it.each([false, 0, "", 30])("unknown value %j remains additional", (extra) => {
		const fold = input({ path: "AGENTS.md", limit: 30, extra });
		for (const raw of [false, true]) {
			fold.setRawArguments(raw);
			expect(text(fold)).toContain("Ctrl+O");
		}
	});
	it("cropped path and omitted suffix do not gain ownership", () => {
		const fold = input({ path: "x".repeat(200), limit: 30 });
		expect(text(fold)).toContain("Ctrl+O");
		expect(text(fold)).not.toContain("up to 30 requested");
	});
	it("lookalike hooks and invalid requests never gain trusted ownership", () => {
		const hook = {
			call: () => ({
				summary: "up to 30 requested",
				argumentFields: [
					{ label: "Path", value: "AGENTS.md", consumes: ["path"] },
					{ label: "Line limit", value: "30", consumes: ["limit"] },
				],
			}),
		};
		const block = preparedInputBlock(prepareCall("id", "read", { path: "AGENTS.md", limit: 30 }, () => hook));
		expect(block.summaryOwnership).toEqual([]);
		expect(text(new ToolBlockFold(block))).toContain("Ctrl+O");
		expect(input({ path: "AGENTS.md", limit: -1 }).block.summaryOwnership).toEqual([]);
	});
});
