import { execSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { detectBinary } from "../src/core/tools/bin-detect.js";
import { createFindTool } from "../src/core/tools/find.js";
import { createGrepTool } from "../src/core/tools/grep.js";

const signal = new AbortController().signal;

// Top-level await: describe.skipIf is evaluated at collection time, before beforeAll.
const hasRg = await detectBinary("rg");
const hasFd = await detectBinary("fd");

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "imp-search-"));
	// A tiny "project": git repo with an ignored file.
	execSync("git init -q", { cwd: dir });
	await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
	await writeFile(path.join(dir, "ignored.txt"), "needle in ignored file\n");
	await writeFile(path.join(dir, "keep.ts"), "line1\nconst needle = 1;\nline3\n");
	await mkdir(path.join(dir, "sub"));
	await writeFile(path.join(dir, "sub", "other.ts"), "NEEDLE upper\nneedle lower\n");
});

describe.skipIf(!hasRg)("grep tool (requires rg)", () => {
	it("finds matches with path:line:text", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", path: "." }, signal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("keep.ts");
		expect(result.output).toMatch(/keep\.ts:2:const needle = 1;/);
		expect(result.output).toContain("sub/other.ts");
		// .gitignore respected
		expect(result.output).not.toContain("ignored.txt");
	});

	it("ignoreCase and glob narrow results", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", ignoreCase: true, glob: "*.ts" }, signal);
		expect(result.output).toContain("NEEDLE upper");
		expect(result.output).not.toContain("ignored");
	});

	it("literal mode treats regex chars as text", async () => {
		const tool = createGrepTool({ cwd: dir });
		await writeFile(path.join(dir, "regex.txt"), "a.b (dot)\naxb\n");
		const result = await tool.execute({ pattern: "a.b", literal: true, glob: "regex.txt" }, signal);
		expect(result.output).toContain("a.b (dot)");
		expect(result.output).not.toMatch(/axb/);
	});

	it("context lines are included", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", glob: "keep.ts", context: 1 }, signal);
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line3");
	});

	it("no matches is not an error", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "zzz-no-such-thing" }, signal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No matches");
	});

	it("truncates with a teaching note at the limit", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "line", glob: "keep.ts", limit: 1 }, signal);
		expect(result.output).toContain("[Truncated: showing first 1 of");
		expect(result.output).toContain("Narrow the search");
	});
});

describe.skipIf(!hasFd)("find tool (requires fd)", () => {
	it("finds files by glob", async () => {
		const tool = createFindTool({ cwd: dir });
		const result = await tool.execute({ pattern: "*.ts" }, signal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("keep.ts");
		expect(result.output).toContain("other.ts");
		// gitignore respected (ignored.txt is in the tree but never listed)
		expect(result.output).not.toContain("ignored.txt");
	});

	it("type filter works", async () => {
		const tool = createFindTool({ cwd: dir });
		const result = await tool.execute({ pattern: "sub", type: "directory" }, signal);
		expect(result.output).toContain("sub");
	});

	it("no matches is not an error", async () => {
		const tool = createFindTool({ cwd: dir });
		const result = await tool.execute({ pattern: "zzz-*" }, signal);
		expect(result.output).toContain("No matches");
	});
});
