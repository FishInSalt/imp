import { describe, expect, it } from "vitest";
import {
	composeToolColorResolver,
	isToolColorName,
	TOOL_COLOR_NAMES,
	toolColorSgr,
} from "../src/repl/tool-colors.js";

describe("#tool-name-colors — tokens and SGR map (design D1/D3, Amendment 1)", () => {
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

	it("an out-of-contract token fails closed to no bytes", () => {
		expect(toolColorSgr("constructor" as never)).toBe("");
		expect(toolColorSgr("orange" as never)).toBe("");
	});
});

describe("#tool-name-colors — resolver composition (design D5, Amendment 1: no shipped defaults)", () => {
	it("no registry and an all-undefined registry answer undefined for every name", () => {
		for (const resolver of [
			composeToolColorResolver(),
			composeToolColorResolver({ toolColorFor: () => undefined }),
		]) {
			for (const name of ["bash", "read", "task", "constructor", "gated"])
				expect(resolver(name)).toBeUndefined();
		}
	});

	it("the composed resolver resolves extensions only (exact vs wildcard lives in the registry)", () => {
		const resolver = composeToolColorResolver({
			toolColorFor: (name) => (name === "bash" ? "none" : name === "gated" ? "blue" : undefined),
		});
		expect(resolver("bash")).toBe("none"); // the extension's own answer
		expect(resolver("gated")).toBe("blue");
		expect(resolver("read")).toBeUndefined(); // nothing is defaulted anymore
		expect(composeToolColorResolver()("task")).toBeUndefined();
	});
});
