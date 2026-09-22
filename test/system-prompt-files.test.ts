import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSystemPromptFiles } from "../src/core/system-prompt-files.js";

async function makeTree(): Promise<{ root: string; home: string }> {
	const base = await mkdtemp(join(tmpdir(), "sp-files-"));
	const root = join(base, "repo");
	const home = join(base, "home");
	await mkdir(join(root, ".imp"), { recursive: true });
	await mkdir(join(home, ".imp"), { recursive: true });
	return { root, home };
}

describe("loadSystemPromptFiles (#system-md)", () => {
	it("trusted project tier wins over global; each pair resolves independently", async () => {
		const { root, home } = await makeTree();
		await writeFile(join(root, ".imp", "SYSTEM.md"), "project persona");
		await writeFile(join(home, ".imp", "SYSTEM.md"), "global persona");
		await writeFile(join(home, ".imp", "APPEND_SYSTEM.md"), "global append");
		const sp = loadSystemPromptFiles(root, true, home);
		expect(sp.override?.text).toBe("project persona");
		expect(sp.append?.text).toBe("global append");
		expect(sp.ignoredUntrusted).toEqual([]);
	});

	it("untrusted project file: global takes over, flagged supersededByGlobal", async () => {
		const { root, home } = await makeTree();
		await writeFile(join(root, ".imp", "SYSTEM.md"), "project persona");
		await writeFile(join(home, ".imp", "SYSTEM.md"), "global persona");
		const sp = loadSystemPromptFiles(root, false, home);
		expect(sp.override?.text).toBe("global persona");
		expect(sp.ignoredUntrusted).toEqual([join(root, ".imp", "SYSTEM.md")]);
		expect(sp.supersededByGlobal).toEqual([join(root, ".imp", "SYSTEM.md")]);
	});

	it("untrusted project file with no global: absent, flagged but not superseded", async () => {
		const { root, home } = await makeTree();
		await writeFile(join(root, ".imp", "SYSTEM.md"), "project persona");
		const sp = loadSystemPromptFiles(root, false, home);
		expect(sp.override).toBeUndefined();
		expect(sp.ignoredUntrusted).toEqual([join(root, ".imp", "SYSTEM.md")]);
		expect(sp.supersededByGlobal).toEqual([]);
	});

	it("global-only and empty-everything cases", async () => {
		const { root, home } = await makeTree();
		await writeFile(join(home, ".imp", "SYSTEM.md"), "global persona");
		expect(loadSystemPromptFiles(root, true, home).override?.text).toBe("global persona");
		const bare = await makeTree();
		expect(loadSystemPromptFiles(bare.root, true, bare.home).override).toBeUndefined();
	});

	it("readable-but-empty project file occupies the pair — no global fallback (D7)", async () => {
		const { root, home } = await makeTree();
		await writeFile(join(root, ".imp", "SYSTEM.md"), "  \n\t\n");
		await writeFile(join(home, ".imp", "SYSTEM.md"), "global persona");
		const sp = loadSystemPromptFiles(root, true, home);
		expect(sp.override).toBeUndefined();
		expect(sp.ignoredUntrusted).toEqual([]);
	});

	it("BOM is stripped and content trimmed", async () => {
		const { root, home } = await makeTree();
		await writeFile(join(root, ".imp", "SYSTEM.md"), "﻿bom persona\n");
		const sp = loadSystemPromptFiles(root, true, home);
		expect(sp.override?.text).toBe("bom persona");
	});

	it("mixed pairs: supersession is tracked per file (impl review P2)", async () => {
		const { root, home } = await makeTree();
		// SYSTEM pair: untrusted project, NO global → absent, not superseded
		await writeFile(join(root, ".imp", "SYSTEM.md"), "project persona");
		// APPEND pair: untrusted project + global present → superseded
		await writeFile(join(root, ".imp", "APPEND_SYSTEM.md"), "project append");
		await writeFile(join(home, ".imp", "APPEND_SYSTEM.md"), "global append");
		const sp = loadSystemPromptFiles(root, false, home);
		expect(sp.override).toBeUndefined();
		expect(sp.append?.text).toBe("global append");
		expect(sp.ignoredUntrusted).toEqual([
			join(root, ".imp", "SYSTEM.md"),
			join(root, ".imp", "APPEND_SYSTEM.md"),
		]);
		expect(sp.supersededByGlobal).toEqual([join(root, ".imp", "APPEND_SYSTEM.md")]);
	});

	it("an unreadable trusted project file is surfaced (D5 warn half)", async () => {
		const { root, home } = await makeTree();
		const projectFile = join(root, ".imp", "APPEND_SYSTEM.md");
		await writeFile(projectFile, "locked append");
		await chmod(projectFile, 0o000);
		const sp = loadSystemPromptFiles(root, true, home);
		expect(sp.append).toBeUndefined();
		expect(sp.unreadableProject).toEqual([projectFile]);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"read failure falls through to the global tier (D5)",
		async () => {
			const { root, home } = await makeTree();
			const projectFile = join(root, ".imp", "SYSTEM.md");
			await writeFile(projectFile, "locked persona");
			await chmod(projectFile, 0o000);
			await writeFile(join(home, ".imp", "SYSTEM.md"), "global persona");
			const sp = loadSystemPromptFiles(root, true, home);
			expect(sp.override?.text).toBe("global persona");
			expect(sp.unreadableProject).toEqual([projectFile]);
		},
	);

	it("APPEND pair shares the slot-taken semantics (D7)", async () => {
		const { root, home } = await makeTree();
		await writeFile(join(root, ".imp", "APPEND_SYSTEM.md"), "\n  ");
		await writeFile(join(home, ".imp", "APPEND_SYSTEM.md"), "global append");
		const sp = loadSystemPromptFiles(root, true, home);
		expect(sp.append).toBeUndefined();
	});

	it("a directory shadowing the name counts as absent (isFile, P3-1)", async () => {
		const { root, home } = await makeTree();
		await mkdir(join(root, ".imp", "SYSTEM.md"));
		expect(loadSystemPromptFiles(root, true, home).override).toBeUndefined();
		// untrusted + directory shadow → not even recorded as ignored
		const sp = loadSystemPromptFiles(root, false, home);
		expect(sp.ignoredUntrusted).toEqual([]);
	});
});
