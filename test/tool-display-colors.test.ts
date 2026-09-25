import { describe, expect, it } from "vitest";
import { ToolBlockFold } from "../src/repl/components/tool-block.js";
import { inputBlock, outputBlock, sanitizeDisplay, type ToolBlock } from "../src/repl/tool-presentation.js";
import { visibleWidth } from "../src/tui.js";

const reset = "\x1b[0m";
const dim = "\x1b[2m";
const bold = "\x1b[1m";
const red = "\x1b[31m";
const plain = (rows: string[]) => rows.map(sanitizeDisplay);
const call = (): ToolBlock => ({ ...inputBlock("id", "bash", { command: "echo ok" }), sections: [] });
const result = (content: string, isError = false) =>
	outputBlock({ toolCallId: "id", toolName: "bash", content, isError });

// Track actual SGR state, not merely the presence of a color somewhere in a row.
function cells(rows: string[]) {
	return rows.flatMap((row) => {
		let state: number[] = [];
		const out: { text: string; state: number[] }[] = [];
		// biome-ignore lint/suspicious/noControlCharactersInRegex: inspect terminal SGR state
		for (const part of row.split(/(\x1b\[[\d;]*m)/u)) {
			if (part.startsWith("\x1b[")) {
				const codes = part.slice(2, -1).split(";").map(Number);
				state = codes.includes(0) ? [] : [...state, ...codes];
			} else for (const text of part) out.push({ text, state: [...state] });
		}
		return out;
	});
}

describe("minimal tool display colors", () => {
	it("preserves static inline, wrapped and normal-result layout with neutral payload", () => {
		const inline = new ToolBlockFold(call()).render(40);
		expect(plain(inline)).toEqual(["● bash  echo ok"]);
		expect(inline).toEqual([`${dim}●${reset} ${bold}bash${reset}  echo ok${reset}`]);
		const wrapped = new ToolBlockFold(call()).render(12);
		expect(plain(wrapped)).toEqual(["● bash  echo", "         ok"]);
		expect(wrapped[1]).toBe(`         ok${reset}`);
		const normal = new ToolBlockFold(result("one\ntwo")).render(40);
		expect(plain(normal)).toEqual(["  ⎿ one", "    two"]);
		expect(normal[0]).toBe(`  ${dim}⎿${reset} one${reset}`);
		for (const rows of [inline, wrapped, normal])
			expect(cells(rows).filter((c) => c.state.includes(36))).toEqual([]);
	});
	it("keeps explicit failure title red but diagnostics and payload neutral", () => {
		const rows = new ToolBlockFold(result("bad\ndetail", true)).render(40);
		expect(plain(rows)).toEqual(["  ⎿ failed", "    bad", "    detail"]);
		expect(rows[0]).toBe(`  ${dim}⎿${reset}${red} failed${reset}`);
		expect(rows.slice(1)).toEqual([`    bad${reset}`, `    detail${reset}`]);
		for (const title of ["failed", "exit 2", "partial", "limited"])
			expect(new ToolBlockFold({ ...result("payload"), title }).render(40)[0]).toContain(red);
		for (const title of ["", "completed", "unknown", "failed text"])
			expect(
				new ToolBlockFold({ ...result("payload"), title, error: true }).render(40).join(""),
			).not.toContain(red);
	});
	it.each([1, 2, 3, 4, 12, 80])("scopes split tool name and interrupted suffix at width %i", (width) => {
		const block = { ...call(), title: "bash · interrupted (no result)", error: true, lines: [] };
		const rows = new ToolBlockFold(block).render(width);
		const painted = cells(rows);
		expect(
			painted
				.filter((c) => c.state.includes(1))
				.map((c) => c.text)
				.join(""),
		).toBe("bash");
		expect(
			painted
				.filter((c) => c.state.includes(31))
				.map((c) => c.text)
				.join(""),
		).toBe(" · interrupted (no result)");
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		expect(plain(rows).join("")).toBe(`${width > 2 ? "● " : ""}bash · interrupted (no result)`);
	});
	it("styles sanitized multiline names after wrapping and preserves cache behavior", () => {
		const block = { ...call(), name: "ab\n終cd", title: "ab\n終cd" };
		const fold = new ToolBlockFold(block);
		const rows = fold.render(3);
		expect(plain(rows).slice(0, 4)).toEqual(["● a", "b", "終c", "d"]);
		expect(
			cells(rows)
				.filter((c) => c.state.includes(1))
				.map((c) => c.text)
				.join(""),
		).toBe("ab終cd");
		expect(fold.render(3)).toBe(rows);
		fold.setExpanded(true);
		expect(fold.render(3)).not.toBe(rows);
		const narrow = new ToolBlockFold({
			...call(),
			name: "終ab",
			title: "終ab · interrupted (no result)",
			lines: [],
		}).render(1);
		expect(
			cells(narrow)
				.filter((c) => c.state.includes(1))
				.map((c) => c.text)
				.join(""),
		).toBe("ab");
		expect(
			cells(narrow)
				.filter((c) => c.state.includes(31))
				.map((c) => c.text)
				.join(""),
		).toBe(" · interrupted (no result)");
	});
	it("dims omission notices and metadata without coloring body or trusting controls", () => {
		const block = { ...call(), metadata: ["Arguments unavailable"], discarded: 2 };
		const rows = new ToolBlockFold(block).render(80);
		expect(rows[1]).toBe(`${dim}    Arguments unavailable${reset}`);
		expect(rows.at(-1)).toBe(`${dim}    2 source lines omitted from this view${reset}`);
		const hostile = { ...call(), lines: ["\x1b[31mecho\x1b[0m\x00\t終"] };
		expect(plain(new ToolBlockFold(hostile).render(80))).toEqual(["● bash  echo\\x00    終"]);
		expect(new ToolBlockFold(hostile).render(80).join("")).not.toContain(red);
	});
	it("preserves diff colors and numbered prefixes after the neutral marker reset", () => {
		const block: ToolBlock = {
			...result(""),
			kind: "diff",
			sections: [],
			lines: ["@@ line 7 @@", "- old", "+ new", "  same"],
		};
		const rows = new ToolBlockFold(block).render(40);
		expect(plain(rows)).toEqual(["  ⎿ @@ line 7 @@", "    - old", "    7 + new", "    8   same"]);
		expect(rows).toEqual([
			`  ${dim}⎿${reset}\x1b[36m @@ line 7 @@${reset}`,
			`${red}    - old${reset}`,
			`\x1b[32m    7 + new${reset}`,
			`${dim}    8   same${reset}`,
		]);
		block.lines = ["+ new"];
		expect(new ToolBlockFold(block).render(40)[0]).toBe(`  ${dim}⎿${reset}\x1b[32m + new${reset}`);
	});
});
