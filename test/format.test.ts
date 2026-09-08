import { describe, expect, it } from "vitest";
import { shorten, summarizeArgs } from "../src/format.js";

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
		expect(summarizeArgs("find", { pattern: "*", path: "docs", type: "file" })).toBe(
			"* in docs · files",
		);
	});

	it("task: (agent) prompt, prompt capped by shorten", () => {
		expect(summarizeArgs("task", { prompt: "map the repo" })).toBe("map the repo");
		expect(summarizeArgs("task", { prompt: "map the repo", agent: "scout" })).toBe(
			"(scout) map the repo",
		);
		const long = "x".repeat(200);
		expect(summarizeArgs("task", { prompt: long })).toBe(`${"x".repeat(80)}…`);
	});

	it("unknown tools (extensions) keep compact JSON, truncated at 120", () => {
		expect(summarizeArgs("web_search", { query: "pi-tui" })).toBe('{"query":"pi-tui"}');
		const big = { blob: "y".repeat(200) };
		expect(summarizeArgs("custom", big)).toBe(`${JSON.stringify(big).slice(0, 120)}…`);
	});

	it("shorten: 80-char cap with ellipsis", () => {
		expect(shorten("short")).toBe("short");
		expect(shorten(`${"z".repeat(81)}`)).toBe(`${"z".repeat(80)}…`);
	});
});
