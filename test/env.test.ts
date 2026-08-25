import { describe, expect, it } from "vitest";
import { parseDotEnv } from "../src/env.js";

describe("parseDotEnv", () => {
	it("parses plain assignments", () => {
		expect(parseDotEnv("A=1\nB=hello")).toEqual({ A: "1", B: "hello" });
	});

	it("supports export prefix and surrounding whitespace", () => {
		expect(parseDotEnv("export A=1\n  B = 2 ")).toEqual({ A: "1", B: "2" });
	});

	it("trims matching quotes", () => {
		expect(parseDotEnv('A="x y"\nB=\'z\'')).toEqual({ A: "x y", B: "z" });
	});

	it("ignores comments and blank lines", () => {
		expect(parseDotEnv("# comment\n\nA=1\n  # indented comment")).toEqual({ A: "1" });
	});

	it("skips malformed lines", () => {
		expect(parseDotEnv("not-an-assignment\n1BAD=x\nA=1")).toEqual({ A: "1" });
	});

	it("keeps values containing equals signs", () => {
		expect(parseDotEnv("A=x=y")).toEqual({ A: "x=y" });
	});
});
