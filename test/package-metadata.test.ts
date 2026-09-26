import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/format.js";

// Release identity: `imp --version` reports src/format.ts's VERSION while npm
// reads package.json — keep the two from drifting (bump both together).

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
	bin: Record<string, string>;
};

describe("package metadata (release identity)", () => {
	it("src/format.ts VERSION matches package.json", () => {
		expect(VERSION).toBe(pkg.version);
	});

	it("the bin entry points at an existing file", () => {
		expect(pkg.bin.imp).toBe("bin/imp.js");
		expect(existsSync(new URL("../bin/imp.js", import.meta.url))).toBe(true);
	});
});
