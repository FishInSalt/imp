import { describe, expect, it } from "vitest";
import {
	bashPresentation,
	editPresentation,
	lsPresentation,
	readPresentation,
	writePresentation,
} from "../src/core/tools/presentation.js";
import type { ToolPresentationHooks } from "../src/core/tools/types.js";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import {
	inputBlock,
	outputBlock,
	preparedInputBlock,
	sanitizeDisplay,
} from "../src/repl/tool-presentation.js";
import { prepareCall } from "../src/repl/tool-presentation-hooks.js";
import { visibleWidth } from "../src/tui.js";

const input = (name: string, args: unknown, hook: ToolPresentationHooks) =>
	new ToolBlockFold(preparedInputBlock(prepareCall("id", name, args, () => hook)));
const output = (content: string, display?: string, toolName = "bash") =>
	new ToolBlockFold(outputBlock({ toolCallId: "id", toolName, content, display, isError: false }));
const text = (fold: ToolBlockFold, width = 120) => sanitizeDisplay(fold.render(width).join("\n"));
const flat = (fold: ToolBlockFold, width: number) =>
	fold
		.render(width)
		.map((row) => sanitizeDisplay(row).trimStart())
		.join("");
const artifact = (value = "Full output saved to /tmp/sample.log") =>
	`[output truncated: only the tail is shown above. ${value} — read it with the read tool if you need more (tip: pipe through head/tail or narrow the grep to keep output small)]`;
const cap = "[full output itself capped at 10MB]";

describe("selected builtin layout", () => {
	it.each([false, true])("counts reachable ASCII beside clipped command glyphs, raw %s", (raw) => {
		for (const command of [
			"echo 漢 abcdefghijklmnopqrstuvwxyz",
			"漢echo abcdefghijklmnopqrstuvwxyz",
			"echo abcdefghijklmnopqrstuvwxyz漢",
		]) {
			for (const width of [1, 5, 6]) {
				const fold = input("bash", { command }, bashPresentation);
				fold.setRawArguments(raw);
				expect(flat(fold, width)).toContain("Ctrl+O");
				fold.setExpanded(true);
				expect(flat(fold, width)).toContain("abcdefghijklmnopqrstuvwxyz");
				for (const row of fold.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
	});
	it.each([false, true])("does not count clipped or off-cap command spans, raw %s", (raw) => {
		for (const width of [1, 5, 6]) {
			const fold = input("bash", { command: "echo 漢 abcdefghijklmnopqrstuvwxyz" }, bashPresentation);
			fold.setRawArguments(raw);
			// Only command evidence: retain its real source identity, but place the
			// selected value beyond the physical cap with a label/caption, not payload.
			if (!raw) {
				fold.block.readableArguments![1] =
					`Command: ${"x".repeat(3000)}${fold.block.argumentCoverage![0]!.value}`;
				const span = fold.block.argumentCoverage![0]!.readableValues![0]!;
				span.start += 3000;
				span.end += 3000;
			}
			// Structured raw captions are host-renamed; exhaust the cap with
			// JSON structure instead, without manufacturing another field value.
			if (raw) {
				fold.block.sections![0]!.lines.unshift(" ".repeat(3000));
				for (const span of fold.block.argumentCoverage![0]!.rawValues!) span.line++;
			}
			expect(flat(fold, width)).not.toContain("Ctrl+O");
			fold.setExpanded(true);
			expect(flat(fold, width)).not.toContain("abcdefghijklmnopqrstuvwxyz");
		}
		for (const width of [1, 5]) {
			const clipped = input("bash", { command: "a漢" }, bashPresentation);
			clipped.setRawArguments(raw);
			expect(flat(clipped, width)).not.toContain("Ctrl+O");
		}
	});
	it("keeps exact path identity before terminal sanitization and narrow glyph fallback", () => {
		for (const path of ["漢", "\x1b[31msecret", "a\tb", "a\u200db", "", "漢\n\t\x1b[31m\u200d"]) {
			for (const width of [1, 2, 4, 5, 20, 80, 120]) {
				for (const raw of [false, true]) {
					const fold = input("read", { path }, readPresentation);
					expect(fold.block.callPath?.requested).toBe(path);
					expect(fold.block.callPath?.display).toBe(path);
					fold.setRawArguments(raw);
					fold.setExpanded(true);
					const shown = flat(fold, width);
					if (width === 1 && path === "漢") expect(shown).toContain("\\u{6f22}");
					if (!raw && path.includes("\x1b")) expect(shown).toContain("\\u{1b}[31m");
					if (!raw && path.includes("\t")) expect(shown).toContain("\\u{9}");
					if (!raw && path.includes("\u200d")) expect(shown).toContain("\\u{200d}");
					if (path === "") expect(shown).toContain('""');
					for (const row of fold.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				}
			}
		}
		const escaped = input("read", { path: "\x1b[31msecret" }, readPresentation);
		const plain = input("read", { path: "secret" }, readPresentation);
		expect(text(escaped)).not.toBe(text(plain));
	});
	it("maps trusted escaped command excerpt source spans in both selected modes", () => {
		for (const command of [
			"echo\tok",
			"echo\rok",
			"echo\u200dok",
			"echo\x1b[31mok",
			"echo\\tok",
			"echo\nok",
		]) {
			for (const raw of [false, true]) {
				const fold = input("bash", { command }, bashPresentation);
				fold.setRawArguments(raw);
				expect(text(fold)).not.toContain("Ctrl+O");
				const extra = input("bash", { command, timeout: 30 }, bashPresentation);
				extra.setRawArguments(raw);
				expect(text(extra)).toContain("Ctrl+O");
				const unknown = input("bash", { command, prompt: "more" }, bashPresentation);
				unknown.setRawArguments(raw);
				expect(text(unknown)).toContain("Ctrl+O");
			}
		}
	});
	it("does not advertise command suffixes outside the selected cap or infer third-party association", () => {
		for (const raw of [false, true]) {
			const fold = input(
				"bash",
				{ before: "x".repeat(5000), command: `${"x".repeat(160)}${"\n".repeat(1200)}suffix` },
				bashPresentation,
			);
			fold.setRawArguments(raw);
			// The unknown value is genuinely reachable, regardless of command reachability.
			expect(text(fold)).toContain("Ctrl+O");
		}
		const hook: ToolPresentationHooks = {
			call: () => ({
				summary: "echo\\tok",
				argumentFields: [{ label: "Command", value: "echo\tok", consumes: ["command"] }],
			}),
		};
		const fold = input("bash", { command: "echo\tok" }, hook);
		expect(fold.block.commandExcerpt).toBeUndefined();
		expect(text(fold)).toContain("Ctrl+O");
	});
	it.each([1, 3, 40, 120])("suppresses only complete expanded notice evidence at width %i", (width) => {
		for (const value of [
			"Full output saved to /tmp/full",
			"Partial output saved to /tmp/partial (command interrupted; all observed bytes retained)",
			"Partial output saved to /tmp/partial (command interrupted; artifact prefix capped; per-stream limit 10485760 bytes)",
		]) {
			const raw = artifact(value);
			for (const display of [undefined, raw, `${raw}\nother`]) {
				const fold = output(raw, display);
				expect(flat(fold, width).replaceAll(" ", "")).toContain("Outputtruncated;");
				expect(flat(fold, width).includes("Ctrl+O")).toBe(width === 1 && display === `${raw}\nother`);
				fold.setExpanded(true);
				expect(flat(fold, width).replaceAll(" ", "")).not.toContain("Outputtruncated;");
				expect(fold.block.sections![0]!.originalLines).toEqual([raw]);
			}
		}
	});
	it("requires separate qualifier evidence and does not confuse section indices", () => {
		for (const hidden of [false, true]) {
			const fold = output(`${artifact()}\n${hidden ? "x\n".repeat(1000) : ""}${cap}`);
			fold.setExpanded(true);
			expect(flat(fold, 120).includes("Partial output:")).toBe(hidden);
		}
		const fold = output("payload", `${"x\n".repeat(1001)}${artifact()}`);
		fold.setExpanded(true);
		expect(text(fold)).toContain("Output truncated;");
		const sameIndex = output(`${"x\n".repeat(999)}payload`, artifact());
		sameIndex.setExpanded(true);
		expect(text(sameIndex)).toContain("Output truncated;");
	});
	it.each([999, 1000, 1001])("accounts for caption-free physical and retention cap %i", (n) => {
		const fold = output(Array(n).fill("payload").join("\n"));
		fold.setExpanded(true);
		expect(fold.render(120).filter((row) => row.includes("payload"))).toHaveLength(Math.min(n, 1000));
		expect(text(fold).includes("source lines omitted")).toBe(n > 1000);
		expect(text(fold)).not.toContain("Result text\n");
	});
	it("retains partly wrapped notices and sanitizer-colliding occurrences", () => {
		const fold = output(`${"x\n".repeat(999)}${artifact()}`);
		fold.setExpanded(true);
		expect(text(fold, 40)).toContain("Output truncated;");
		const a = artifact("Full output saved to /tmp/ab");
		const b = artifact("Full output saved to /tmp/a\x1b[31mb");
		const collision = output(`${a}\n${"x\n".repeat(999)}${b}`);
		collision.setExpanded(true);
		expect(collision.block.hostNotices).toHaveLength(2);
		expect(text(collision).match(/Output truncated;/g)).toHaveLength(1);
	});
	it("keeps raw selection and multiple or meaningful captions", () => {
		const generic = new ToolBlockFold(inputBlock("id", "custom", { x: 1 }));
		generic.setExpanded(true);
		expect(text(generic)).not.toContain("Arguments");
		const fold = input("read", { path: "file" }, readPresentation);
		fold.setExpanded(true);
		expect(text(fold)).toBe("● read  file");
		fold.setRawArguments(true);
		expect(text(fold)).toContain("Raw arguments");
		expect(text(fold)).toContain('"path": "file"');
		expect(text(fold).match(/file/g)).toHaveLength(1);
		const dual = output("receipt", "Edited:\n@@ line 1 @@\n- old\n+ new", "edit");
		dual.setExpanded(true);
		expect(text(dual)).toContain("Result text");
		expect(text(dual)).toContain("Live display");
		generic.block.sections![0]!.caption = "Receipt";
		generic.invalidate();
		expect(text(generic)).toContain("Receipt");
	});
	it.each([1, 3, 40, 120])("path-first ownership, crop accessibility and resize at %i", (width) => {
		for (const [name, args, hook] of [
			["read", { path: "deep/".repeat(210) }, readPresentation],
			["write", { path: "file", content: "a\n \n" }, writePresentation],
			["edit", { path: "file", edits: [{ oldText: "", newText: "new" }] }, editPresentation],
			["ls", {}, lsPresentation],
			["ls", { path: "" }, lsPresentation],
		] as const) {
			const fold = input(name, args, hook);
			for (const raw of [false, true, false]) {
				fold.setRawArguments(raw);
				for (const expanded of [false, true, false]) {
					fold.setExpanded(expanded);
					for (const row of fold.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				}
			}
			fold.setExpanded(true);
			expect(flat(fold, width)).not.toContain("Path:");
			if (name === "read") expect(flat(fold, width)).toContain("deep/".repeat(210));
		}
	});
	it("keeps host path when raw path is beyond cap, but not when raw owns it", () => {
		for (const late of [true, false]) {
			const args = late
				? { content: "x".repeat(16384), path: "unique-path" }
				: { path: "unique-path", content: "x".repeat(16384) };
			const fold = input("write", args, writePresentation);
			fold.setRawArguments(true);
			fold.setExpanded(true);
			expect(flat(fold, 20).match(/unique-path/g)).toHaveLength(1);
			expect(text(fold, 20).startsWith("● write  unique-path")).toBe(late);
		}
	});
	it("does not infer builtin ownership from replacement name or summary spelling", () => {
		const hook = {
			call: () => ({
				summary: "file",
				argumentFields: [{ label: "Path", value: "file", consumes: ["path"] }],
			}),
		};
		const fold = input("read", { path: "file" }, hook);
		expect(fold.block.builtinName).toBeUndefined();
		expect(text(fold)).toContain("Path: file");
	});
	it("renders literal LF, preserves blank lines, and uses fixed body continuation", () => {
		const fold = input("bash", { command: "echo first\n\necho last\n" }, bashPresentation);
		expect(text(fold).split("\n").slice(0, 3)).toEqual(["● bash  echo first", "    ", "    echo last"]);
		expect(text(fold)).toContain("Ctrl+O");
		fold.setExpanded(true);
		expect(text(fold)).toBe("● bash\n    Command:\n      echo first\n      \n      echo last\n      ");
		const wrapped = input("bash", { command: "x".repeat(50) }, bashPresentation);
		expect(text(wrapped, 40).split("\n").slice(0, 2)).toEqual([
			`● bash  ${"x".repeat(32)}`,
			`    ${"x".repeat(18)}`,
		]);
	});
	it("does not decode literal backslash-n or execute summary controls", () => {
		const command = "echo \\n\n\x1b]0;unsafe\x07\r\t\u202e";
		const fold = input("bash", { command }, bashPresentation);
		expect(fold.block.semantic!.summary).toContain("echo \\n\n\\u{1b}");
		expect(fold.block.semantic!.summary).not.toContain("\u202e");
		for (const n of [16384, 16385])
			expect(Boolean(input("bash", { command: "x".repeat(n) }, bashPresentation).block.semantic)).toBe(
				n === 16384,
			);
	});
	it("preserves multiline unknown labels and body whitespace and opaque replacements", () => {
		const fold = input(
			"write",
			{ path: "f", content: "\n  original\n \n", "key:\nlabel": { x: false, y: 0 } },
			writePresentation,
		);
		fold.setExpanded(true);
		expect(text(fold)).toContain("Content:\n      \n        original\n       \n      ");
		expect(text(fold)).toContain('key:\n    label:\n      {\n        "x": false,');
		const edit = input(
			"edit",
			{ path: "f", edits: [{ oldText: "oldText:\n ", newText: "" }] },
			editPresentation,
		);
		const value = edit.block.semantic!.argumentFields![1]!.value;
		edit.setExpanded(true);
		expect(text(edit)).toContain(
			`Replacements:\n${value
				.split("\n")
				.map((line) => `      ${line}`)
				.join("\n")}`,
		);
	});
	it("a label-only last row is not reachable value evidence; raw default has no ownership", () => {
		const fold = input("bash", { command: "ok", ["k".repeat(995)]: "hidden" }, bashPresentation);
		// Explicit source indices: command row + Other arguments + 998 label rows exhaust width-one cap.
		const coverage = fold.block.argumentCoverage![1]!;
		expect(coverage.readableValues).toHaveLength(1);
		expect(flat(fold, 1)).not.toContain("Ctrl+O");
		fold.setExpanded(true);
		expect(flat(fold, 1)).not.toContain("hidden");
		const defaults = input("ls", {}, lsPresentation);
		defaults.setRawArguments(true);
		expect(text(defaults)).not.toContain("Ctrl+O");
	});
});
