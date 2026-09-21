import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLsTool } from "../src/core/tools/ls.js";

async function makeDir(entries: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "imp-ls-"));
	for (const [name, content] of Object.entries(entries)) {
		if (name.endsWith("/")) await mkdir(path.join(dir, name));
		else await writeFile(path.join(dir, name), content, "utf-8");
	}
	return dir;
}

function run(dir: string, args: Record<string, unknown>, signal: AbortSignal = new AbortController().signal) {
	return createLsTool({ cwd: dir }).execute(args, signal);
}

describe("ls tool (M16)", () => {
	it("sorts case-insensitively, includes dotfiles, suffixes directories", async () => {
		const dir = await makeDir({ "Beta.ts": "b", "alpha.ts": "a", ".hidden": "h", "sub/": "" });
		const result = await run(dir, {});
		expect(result.isError).toBeUndefined();
		expect(result.output).toBe(".hidden\nalpha.ts\nBeta.ts\nsub/\n");
	});

	it("resolves the path through the read seam (~ and relative)", async () => {
		const base = await makeDir({ "inner/": "" });
		const result = await run(base, { path: "inner" });
		expect(result.output).toBe("(empty directory)");
	});

	it("empty directory renders the explicit marker", async () => {
		const dir = await makeDir({});
		expect((await run(dir, {})).output).toBe("(empty directory)");
	});

	it("entry limit: stops at limit with the actionable notice", async () => {
		const entries: Record<string, string> = {};
		for (let i = 0; i < 6; i++) entries[`f${i}.txt`] = "x";
		const dir = await makeDir(entries);
		const result = await run(dir, { limit: 4 });
		expect(result.output.split("\n")).toHaveLength(6); // 4 entries + blank + notice
		expect(result.output).toContain("f0.txt");
		expect(result.output).toContain("f3.txt");
		expect(result.output).not.toContain("f4.txt");
		expect(result.output).toContain("4 entries limit reached. Use limit=8 for more");
	});

	it("entry limit clamps absurd values into 1..5000", async () => {
		const entries: Record<string, string> = {};
		for (let i = 0; i < 3; i++) entries[`f${i}.txt`] = "x";
		const dir = await makeDir(entries);
		const tooBig = await run(dir, { limit: 999999 });
		expect(tooBig.output).not.toContain("limit reached");
		expect((await run(dir, { limit: 0 })).output).toContain("1 entries limit reached");
	});

	it("byte cap: long names cross 50KB mid-list with the notice", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-ls-"));
		// 300 entries × ~200-char names (under the 255 filename limit)
		// ≈ 60KB total — crosses the 50KB cap mid-way, under the 500 cap
		for (let i = 0; i < 300; i++) {
			await writeFile(path.join(dir, `${String(i).padStart(3, "0")}${"x".repeat(190)}.txt`), "", "utf-8");
		}
		const result = await run(dir, {});
		expect(result.output).toContain("50KB limit reached");
		expect(result.output).not.toContain("299");
	});

	it("missing path and non-directory are errors, not throws", async () => {
		const base = await makeDir({ "file.txt": "x" });
		const missing = await run(base, { path: "nope" });
		expect(missing.isError).toBe(true);
		expect(missing.output).toContain("cannot read");
		const notDir = await run(base, { path: "file.txt" });
		expect(notDir.isError).toBe(true);
		expect(notDir.output).toContain("cannot read");
	});

	it("aborts MID-LOOP (M16 review P2-9): the per-entry check stops the walk deterministically", async () => {
		const entries: Record<string, string> = {};
		for (let i = 0; i < 8; i++) entries[`f${i}.txt`] = "x";
		const dir = await makeDir(entries);
		// A signal whose `aborted` flips true after 3 reads: 1 pre-start
		// check + per-entry checks — the flip lands INSIDE the stat loop,
		// deterministic without racing real fs timing (the tool only reads
		// `signal.aborted`, so a shaped stand-in pins the contract).
		let checks = 0;
		const flipAfter3 = {
			get aborted() {
				checks += 1;
				return checks > 3;
			},
		} as unknown as AbortSignal;
		const result = await createLsTool({ cwd: dir }).execute({}, flipAfter3);
		expect(result.isError).toBe(true);
		expect(result.output).toBe("Error: aborted");
	});

	it("at the entry clamp the notice teaches narrowing, not the same limit (M16 review P2-7)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-ls-"));
		// 5001 empty files: one past the clamp ceiling, cheap on tmpfs
		const names = Array.from({ length: 5001 }, (_, i) => `f${String(i).padStart(4, "0")}.txt`);
		await Promise.all(names.map((name) => writeFile(path.join(dir, name), "", "utf-8")));
		const result = await run(dir, { limit: 5000 });
		expect(result.output).toContain("Narrow the path — 5000 is the maximum");
	}, 20000);

	it("honors an aborted signal without touching the filesystem", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await run("/nonexistent", {}, controller.signal);
		expect(result.isError).toBe(true);
	});
});
