import { describe, expect, it } from "vitest";
import { applyWarnSpans, shorten, summarizeArgs, summarizeResult } from "../src/format.js";

describe("summarizeArgs (tool line labels — one funnel for print, TUI, replay, activity)", () => {
	it("bash keeps the historical `$ command` form, byte-identical", () => {
		expect(summarizeArgs("bash", { command: "ls -la" })).toBe("$ ls -la");
		expect(summarizeArgs("bash", {})).toBe("{}"); // no command → JSON fallback
	});

	it("read: path, with · from line / · limit riders", () => {
		expect(summarizeArgs("read", { path: "src/app.ts" })).toBe("src/app.ts");
		expect(summarizeArgs("read", { path: "src/app.ts", offset: 120, limit: 60 })).toBe(
			"src/app.ts · from line 120 · limit 60",
		);
	});

	it("write/edit: the path alone — content never floods the label", () => {
		expect(summarizeArgs("write", { path: "out.md", content: "…kb of text…" })).toBe("out.md");
		expect(summarizeArgs("edit", { path: "a.ts", oldText: "x", newText: "y" })).toBe("a.ts");
	});

	it("grep: quoted pattern, optional scope and glob", () => {
		expect(summarizeArgs("grep", { pattern: "TODO" })).toBe('"TODO"');
		expect(summarizeArgs("grep", { pattern: "TODO", path: "src", glob: "*.ts" })).toBe(
			'"TODO" in src (*.ts)',
		);
	});

	it("find: pattern, optional scope and type", () => {
		expect(summarizeArgs("find", { pattern: "*.test.ts" })).toBe("*.test.ts");
		expect(summarizeArgs("find", { pattern: "*", path: "docs", type: "file" })).toBe("* in docs · files");
	});

	it("task: (agent) prompt, prompt capped by shorten", () => {
		expect(summarizeArgs("task", { prompt: "map the repo" })).toBe("map the repo");
		expect(summarizeArgs("task", { prompt: "map the repo", agent: "scout" })).toBe("(scout) map the repo");
		const long = "x".repeat(200);
		expect(summarizeArgs("task", { prompt: long })).toBe(`${"x".repeat(80)}…`);
	});

	it("unknown tools (extensions) keep compact JSON, truncated at 120", () => {
		expect(summarizeArgs("web_search", { query: "pi-tui" })).toBe('{"query":"pi-tui"}');
		const big = { blob: "y".repeat(200) };
		expect(summarizeArgs("custom", big)).toBe(`${JSON.stringify(big).slice(0, 120)}…`);
	});

	it("summarizeResult: bash skips stdout:/stderr: headers — first output line + (+N)", () => {
		expect(summarizeResult("bash", "stdout:\nl1\nl2\nl3")).toBe("l1 (+2 lines)");
		expect(summarizeResult("bash", "stderr:\nboom\nmore")).toBe("boom (+1 lines)");
		expect(summarizeResult("bash", "(no output)")).toBe("(no output)");
		expect(summarizeResult("bash", "")).toBe("(no output)");
	});

	it("summarizeResult: non-bash previews the first line unchanged", () => {
		expect(summarizeResult("read", "import x\nexport {}")).toBe("import x (+1 lines)");
		expect(summarizeResult("task", "single")).toBe("single");
	});

	it("summarizeResult (review P1): a blank FIRST line previews the first content line, not '(no output)'", () => {
		expect(summarizeResult("read", "\nfoo\nbar")).toBe("foo (+1 lines)"); // content lines only (debt clearance)
		expect(summarizeResult("task", "\n\nchild report")).toBe("child report"); // blanks never inflate (+N)
	});

	it("summarizeResult (debt clearance): blank separators and the Exit code line never count toward (+N)", () => {
		expect(summarizeResult("bash", "stdout:\nreal output\n\n\nExit code: 1")).toBe("real output");
		expect(summarizeResult("bash", "stdout:\na\nb\n\nstderr:\nc\n\nExit code: 2")).toBe("a (+3 lines)"); // section headers stay (visible when expanded)
	});

	it("summarizeArgs (review P2): built-in fallbacks keep the 120-char cap", () => {
		const blob = { extra: "x".repeat(200) }; // no path -> the JSON fallback path
		const json = JSON.stringify(blob);
		expect(summarizeArgs("read", blob)).toBe(`${json.slice(0, 120)}…`);
	});

	it("shorten: 80-char cap with ellipsis", () => {
		expect(shorten("short")).toBe("short");
		expect(shorten(`${"z".repeat(81)}`)).toBe(`${"z".repeat(80)}…`);
	});
});

describe("applyWarnSpans (confirm-picker alert highlight)", () => {
	it("wraps the named range in warn colors; ansi=false passes text through untouched", () => {
		const out = applyWarnSpans("a rm -rf b", [[2, 8]], true);
		expect(out).toBe(`a \x1b[0m\x1b[1;31mrm -rf\x1b[0m\x1b[2m b`);
		expect(applyWarnSpans("a rm -rf b", [[2, 8]], false)).toBe("a rm -rf b");
	});
	it("clips out-of-range spans and drops empty ones — extension math is untrusted", () => {
		expect(applyWarnSpans("abc", [[-5, 2]], true)).toBe(`\x1b[0m\x1b[1;31mab\x1b[0m\x1b[2mc`);
		expect(applyWarnSpans("abc", [[10, 20]], true)).toBe("abc");
		expect(applyWarnSpans("abc", [[2, 2]], true)).toBe("abc");
	});
	it("sorts and merges overlapping spans; multiple spans all highlight", () => {
		expect(
			applyWarnSpans(
				"abcdefgh",
				[
					[4, 6],
					[0, 2],
				],
				true,
			),
		).toBe(`\x1b[0m\x1b[1;31mab\x1b[0m\x1b[2mcd\x1b[0m\x1b[1;31mef\x1b[0m\x1b[2mgh`);
		// overlap: [0,3) and [1,4) merge into one [0,4) span
		expect(
			applyWarnSpans(
				"abcd",
				[
					[1, 4],
					[0, 3],
				],
				true,
			),
		).toBe(`\x1b[0m\x1b[1;31mabcd\x1b[0m\x1b[2m`);
	});
	it("restoreDim=false ends a span with a plain reset — D12's normal-weight detail path", () => {
		// #confirm-prompt (Phase 3 D12): outside a dim context WARN_END's
		// dim-restoring end would wrongly reintroduce faint. The fourth
		// argument swaps it for a plain reset, byte-for-byte.
		expect(applyWarnSpans("a rm -rf b", [[2, 8]], true, false)).toBe(`a \x1b[0m\x1b[1;31mrm -rf\x1b[0m b`);
		// The default (and explicit true) keep the dim-restoring end.
		expect(applyWarnSpans("a rm -rf b", [[2, 8]], true, true)).toBe(
			`a \x1b[0m\x1b[1;31mrm -rf\x1b[0m\x1b[2m b`,
		);
		expect(applyWarnSpans("a rm -rf b", [[2, 8]], true)).toBe(`a \x1b[0m\x1b[1;31mrm -rf\x1b[0m\x1b[2m b`);
		expect(applyWarnSpans("a rm -rf b", [[2, 8]], false, false)).toBe("a rm -rf b");
	});
});
