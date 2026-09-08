import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendInputHistory, historyFilePath, loadInputHistory } from "../src/repl/history.js";

async function tmpFile(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "imp-history-"));
	return path.join(dir, "history.jsonl");
}

describe("input history persistence (M11 #4)", () => {
	it("append + load round-trip; consecutive duplicates collapse", async () => {
		const file = await tmpFile();
		appendInputHistory(file, "first");
		appendInputHistory(file, "second");
		appendInputHistory(file, "second"); // consecutive duplicate — not stored twice
		expect(loadInputHistory(file)).toEqual(["first", "second"]);
	});

	it("a torn/corrupt line is skipped, the rest survive", async () => {
		const file = await tmpFile();
		appendInputHistory(file, "ok1");
		appendInputHistory(file, "ok2");
		const raw = await readFile(file, "utf8");
		await writeFile(file, `${raw}{"torn\n`, "utf8");
		expect(loadInputHistory(file)).toEqual(["ok1", "ok2"]);
	});

	it("missing file loads empty; a missing directory is created on append", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-history-nested-"));
		const file = path.join(dir, "sub", "history.jsonl");
		expect(loadInputHistory(file)).toEqual([]);
		appendInputHistory(file, "made it");
		expect(loadInputHistory(file)).toEqual(["made it"]);
	});

	it("load caps at the recall limit, keeping the newest", async () => {
		const file = await tmpFile();
		for (let i = 0; i < 130; i++) appendInputHistory(file, `line-${i}`);
		const loaded = loadInputHistory(file);
		expect(loaded).toHaveLength(100);
		expect(loaded[0]).toBe("line-30");
		expect(loaded[99]).toBe("line-129");
	});

	it("historyFilePath lands under ~/.imp", () => {
		expect(historyFilePath("/home/z")).toBe("/home/z/.imp/history.jsonl");
	});
});
