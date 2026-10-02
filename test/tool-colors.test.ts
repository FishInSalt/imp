import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/core/constants.js";
import {
	composeToolColorResolver,
	DEFAULT_TOOL_COLORS,
	defaultToolColor,
	isToolColorName,
	TOOL_COLOR_NAMES,
	toolColorSgr,
} from "../src/repl/tool-colors.js";

describe("#tool-name-colors — tokens, defaults, SGR map (design D1/D3)", () => {
	it("the token set is closed: 16 standard colors plus none", () => {
		expect([...TOOL_COLOR_NAMES]).toEqual([
			"black",
			"red",
			"green",
			"yellow",
			"blue",
			"magenta",
			"cyan",
			"white",
			"gray",
			"brightRed",
			"brightGreen",
			"brightYellow",
			"brightBlue",
			"brightMagenta",
			"brightCyan",
			"brightWhite",
			"none",
		]);
		for (const token of TOOL_COLOR_NAMES) expect(isToolColorName(token)).toBe(true);
		for (const bad of ["orange", "brightBlack", "RED", "", "default", 42, null, undefined])
			expect(isToolColorName(bad)).toBe(false);
	});

	it("every token maps to SGR — colors non-empty and reset-free, none empty", () => {
		for (const token of TOOL_COLOR_NAMES) {
			const sgr = toolColorSgr(token);
			if (token === "none") {
				expect(sgr).toBe("");
				continue;
			}
			expect(sgr.startsWith("\u001b[")).toBe(true);
			expect(sgr.endsWith("m")).toBe(true);
			expect(sgr.slice(2, -1)).toMatch(/^(3\d|9\d)$/);
			expect(sgr).not.toContain("\u001b[0m");
		}
		expect(toolColorSgr("yellow")).toBe("\u001b[33m");
		expect(toolColorSgr("gray")).toBe("\u001b[90m");
		expect(toolColorSgr("brightMagenta")).toBe("\u001b[95m");
	});

	it("the default palette is the category table, all built-ins covered, no red or green", () => {
		expect(DEFAULT_TOOL_COLORS).toEqual({
			bash: "yellow",
			read: "blue",
			ls: "blue",
			edit: "magenta",
			write: "magenta",
			grep: "cyan",
			find: "cyan",
			task: "brightMagenta",
		});
		for (const name of BUILTIN_TOOL_NAMES) expect(DEFAULT_TOOL_COLORS[name]).toBeDefined();
		expect(Object.values(DEFAULT_TOOL_COLORS).some((t) => t.startsWith("red") || t.startsWith("green"))).toBe(
			false,
		);
	});
});

describe("#tool-name-colors — resolver composition and fail-closed lookups (review P2-1/P3-2)", () => {
	it("prototype-chain tool names never leak Object.prototype members", () => {
		for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"])
			expect(defaultToolColor(name)).toBeUndefined();
		expect(defaultToolColor("bash")).toBe("yellow");
		// an out-of-contract token (a buggy resolver) fails closed to no bytes
		expect(toolColorSgr("constructor" as never)).toBe("");
		expect(toolColorSgr("orange" as never)).toBe("");
	});

	it("the composed resolver layers extensions over defaults and guards the lookup", () => {
		const resolver = composeToolColorResolver({
			toolColorFor: (name) => (name === "bash" ? "none" : name === "gated" ? "blue" : undefined),
		});
		expect(resolver("bash")).toBe("none"); // extension beats the default
		expect(resolver("gated")).toBe("blue"); // unlisted tool via the extension
		expect(resolver("read")).toBe("blue"); // default survives
		expect(resolver("constructor")).toBeUndefined(); // own-property guard on the same path
		expect(composeToolColorResolver()("task")).toBe("brightMagenta"); // no registry: defaults
	});
});
