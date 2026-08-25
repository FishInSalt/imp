import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyEdits, countOccurrences, diffLines } from "../src/core/tools/edit-diff.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { createWriteTool } from "../src/core/tools/write.js";
import { withFileLock } from "../src/core/tools/file-lock.js";

const signal = new AbortController().signal;

let tmpRoot: string;
async function tmp(): Promise<string> {
	tmpRoot ??= await mkdtemp(path.join(tmpdir(), "imp-edit-"));
	return tmpRoot;
}

describe("applyEdits (pure)", () => {
	it("applies a single unique replacement", () => {
		const result = applyEdits("a\nb\nc\n", [{ oldText: "b", newText: "B" }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.content).toBe("a\nB\nc\n");
			expect(result.applied[0]?.line).toBe(2);
		}
	});

	it("applies multiple non-overlapping edits against the ORIGINAL content", () => {
		const result = applyEdits("one\ntwo\nthree\n", [
			{ oldText: "one", newText: "1" },
			{ oldText: "three", newText: "3" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.content).toBe("1\ntwo\n3\n");
	});

	it("fails with zero matches and teaches how to fix it", () => {
		const result = applyEdits("a\nb\n", [{ oldText: "zzz", newText: "x" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("edits[0]");
			expect(result.error).toContain("not found");
			expect(result.error).toContain("Read the file");
		}
	});

	it("fails on ambiguous matches", () => {
		const result = applyEdits("x\nx\n", [{ oldText: "x", newText: "y" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("matches 2 times");
	});

	it("rejects overlapping edits", () => {
		const result = applyEdits("abcdef\n", [
			{ oldText: "abcd", newText: "1" },
			{ oldText: "cdef", newText: "2" },
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("overlap");
	});

	it("rejects empty and no-op edits", () => {
		expect(applyEdits("a\n", [{ oldText: "", newText: "b" }]).ok).toBe(false);
		expect(applyEdits("a\n", [{ oldText: "a", newText: "a" }]).ok).toBe(false);
	});
});

describe("diffLines (pure)", () => {
	it("renders additions and removals", () => {
		const diff = diffLines("const a = 1;\n", "const a = 2;\nconst b = 3;\n");
		expect(diff).toContain("- const a = 1;");
		expect(diff).toContain("+ const a = 2;");
		expect(diff).toContain("+ const b = 3;");
	});
});

describe("countOccurrences (pure)", () => {
	it("counts non-overlapping matches", () => {
		expect(countOccurrences("ababab", "ab")).toBe(3);
		expect(countOccurrences("aaa", "aa")).toBe(1);
		expect(countOccurrences("x", "")).toBe(0);
	});
});

describe("edit tool", () => {
	it("edits a file and returns a diff with line numbers", async () => {
		const dir = await tmp();
		const file = path.join(dir, "one.ts");
		await writeFile(file, "function add(a, b) {\n  return a - b;\n}\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{ path: file, edits: [{ oldText: "return a - b;", newText: "return a + b;" }] },
			signal,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("1 edit applied");
		expect(result.output).toContain("@@ line 2 @@");
		expect(result.output).toContain("- return a - b;");
		expect(result.output).toContain("+ return a + b;");
		expect(await readFile(file, "utf8")).toBe("function add(a, b) {\n  return a + b;\n}\n");
	});

	it("applies several edits in one call", async () => {
		const dir = await tmp();
		const file = path.join(dir, "multi.ts");
		await writeFile(file, "const x = 1;\nconst y = 2;\nconst z = 3;\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{
				path: file,
				edits: [
					{ oldText: "const x = 1;", newText: "const x = 10;" },
					{ oldText: "const z = 3;", newText: "const z = 30;" },
				],
			},
			signal,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("2 edits applied");
		expect(await readFile(file, "utf8")).toBe("const x = 10;\nconst y = 2;\nconst z = 30;\n");
	});

	it("is atomic: a failing edit leaves the file untouched", async () => {
		const dir = await tmp();
		const file = path.join(dir, "atomic.ts");
		const original = "keep\nme\n";
		await writeFile(file, original);
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{
				path: file,
				edits: [
					{ oldText: "keep", newText: "CHANGE" },
					{ oldText: "nope-not-here", newText: "x" },
				],
			},
			signal,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("edits[1]");
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("preserves CRLF line endings and BOM", async () => {
		const dir = await tmp();
		const file = path.join(dir, "crlf.txt");
		await writeFile(file, "\uFEFFalpha\r\nbeta\r\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{ path: file, edits: [{ oldText: "beta", newText: "gamma" }] },
			signal,
		);
		expect(result.isError).toBeFalsy();
		const content = await readFile(file, "utf8");
		expect(content).toBe("\uFEFFalpha\r\ngamma\r\n");
	});

	it("reports a helpful error on zero matches", async () => {
		const dir = await tmp();
		const file = path.join(dir, "missing.ts");
		await writeFile(file, "actual content\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{ path: file, edits: [{ oldText: "wrong\n\tindentation", newText: "x" }] },
			signal,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
		expect(result.output).toContain("whitespace");
	});

	it("errors on missing files", async () => {
		const dir = await tmp();
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{ path: path.join(dir, "ghost.ts"), edits: [{ oldText: "a", newText: "b" }] },
			signal,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Error reading");
	});
});

describe("write tool", () => {
	it("creates a new file with parent directories", async () => {
		const dir = await tmp();
		const tool = createWriteTool({ cwd: dir });
		const result = await tool.execute(
			{ path: path.join(dir, "nested/deep/file.txt"), content: "line1\nline2\n" },
			signal,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Created");
		expect(result.output).toContain("2 lines");
		expect(await readFile(path.join(dir, "nested/deep/file.txt"), "utf8")).toBe("line1\nline2\n");
	});

	it("overwrites an existing file and says so", async () => {
		const dir = await tmp();
		const file = path.join(dir, "exists.txt");
		await writeFile(file, "old");
		const tool = createWriteTool({ cwd: dir });
		const result = await tool.execute({ path: file, content: "new" }, signal);
		expect(result.output).toContain("Overwrote");
		expect(await readFile(file, "utf8")).toBe("new");
	});
});

describe("withFileLock", () => {
	it("serializes concurrent mutations of the same file", async () => {
		const order: number[] = [];
		const task = (id: number, ms: number) =>
			withFileLock("/tmp/imp-lock-test-file", async () => {
				order.push(id);
				await new Promise((r) => setTimeout(r, ms));
			});

		await Promise.all([task(1, 30), task(2, 5), task(3, 1)]);
		expect(order).toEqual([1, 2, 3]);
	});

	it("runs mutations of different files concurrently", async () => {
		let running = 0;
		let maxRunning = 0;
		const task = (file: string) =>
			withFileLock(file, async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await new Promise((r) => setTimeout(r, 20));
				running--;
			});
		await Promise.all([task("/tmp/a"), task("/tmp/b")]);
		expect(maxRunning).toBe(2);
	});
});
