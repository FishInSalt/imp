import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findContextFiles, loadContextFiles } from "../src/core/context-files.js";

async function makeTree(): Promise<{ root: string; home: string }> {
	const base = await mkdtemp(path.join(tmpdir(), "imp-ctx-"));
	const root = path.join(base, "project");
	const home = path.join(base, "home");
	await mkdir(path.join(root, "src", "deep"), { recursive: true });
	await mkdir(home, { recursive: true });
	return { root, home };
}

describe("context files", () => {
	it("collects global + ancestor AGENTS.md, far to near", async () => {
		const { root, home } = await makeTree();
		await mkdir(path.join(home, ".imp"), { recursive: true });
		await writeFile(path.join(home, ".imp", "AGENTS.md"), "global rules");
		await writeFile(path.join(root, "AGENTS.md"), "project rules");
		await writeFile(path.join(root, "src", "AGENTS.md"), "src rules");

		const files = findContextFiles(path.join(root, "src", "deep"), home);
		expect(files).toEqual([
			path.join(home, ".imp", "AGENTS.md"),
			path.join(root, "AGENTS.md"),
			path.join(root, "src", "AGENTS.md"),
		]);
	});

	it("concatenates with headers, global first, nearest last", async () => {
		const { root, home } = await makeTree();
		await writeFile(path.join(root, "AGENTS.md"), "# root\nparent rules");
		await writeFile(path.join(root, "src", "AGENTS.md"), "# src\nmodule rules");

		const loaded = loadContextFiles(path.join(root, "src"), home);
		expect(loaded).not.toBeNull();
		const text = loaded!.text;
		const rootIdx = text.indexOf("parent rules");
		const srcIdx = text.indexOf("module rules");
		expect(rootIdx).toBeGreaterThan(-1);
		expect(srcIdx).toBeGreaterThan(rootIdx);
	});

	it("returns null when nothing is found", async () => {
		const { root, home } = await makeTree();
		expect(loadContextFiles(root, home)).toBeNull();
	});

	it("skips empty files", async () => {
		const { root, home } = await makeTree();
		await writeFile(path.join(root, "AGENTS.md"), "   \n");
		expect(loadContextFiles(root, home)).toBeNull();
	});
});
