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

	it("sections carry per-file content, global first, nearest last (prompt-audit P4)", async () => {
		const { root, home } = await makeTree();
		await writeFile(path.join(root, "AGENTS.md"), "# root\nparent rules");
		await writeFile(path.join(root, "src", "AGENTS.md"), "# src\nmodule rules");

		const loaded = loadContextFiles(path.join(root, "src"), home);
		expect(loaded).not.toBeNull();
		const text = loaded!.sections.map((s) => s.content).join("\n");
		const rootIdx = text.indexOf("parent rules");
		const srcIdx = text.indexOf("module rules");
		expect(rootIdx).toBeGreaterThan(-1);
		expect(srcIdx).toBeGreaterThan(rootIdx);
		expect(loaded!.sections.every((s) => s.path.endsWith("AGENTS.md"))).toBe(true);
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

describe("candidates + first-match (prompt-audit P4)", () => {
	it("AGENTS.md shadows CLAUDE.md in the same directory", async () => {
		const { root, home } = await makeTree();
		await writeFile(path.join(root, "AGENTS.md"), "agent rules");
		await writeFile(path.join(root, "CLAUDE.md"), "claude rules");
		const loaded = loadContextFiles(root, home);
		expect(loaded!.sections).toHaveLength(1);
		expect(loaded!.sections[0]!.content).toBe("agent rules");
	});

	it("CLAUDE.md loads when no AGENTS.md exists (interop)", async () => {
		const { root, home } = await makeTree();
		await writeFile(path.join(root, "CLAUDE.md"), "claude only");
		const loaded = loadContextFiles(root, home);
		expect(loaded!.sections[0]!.content).toBe("claude only");
		expect(loaded!.files[0]!.endsWith("CLAUDE.md")).toBe(true);
	});

	it("AGENTS.override.md outranks AGENTS.md", async () => {
		const { root, home } = await makeTree();
		await writeFile(path.join(root, "AGENTS.md"), "plain");
		await writeFile(path.join(root, "AGENTS.override.md"), "override wins");
		const loaded = loadContextFiles(root, home);
		expect(loaded!.sections).toHaveLength(1);
		expect(loaded!.sections[0]!.content).toBe("override wins");
	});
});

describe("global tier stays AGENTS.md-only (impl review P2-1)", () => {
	it("an unreadable global AGENTS.md does NOT fall through to ~/.imp/CLAUDE.md", async () => {
		const { root, home } = await makeTree();
		const imp = path.join(home, ".imp");
		await mkdir(imp, { recursive: true });
		await writeFile(path.join(imp, "CLAUDE.md"), "global claude must not load");
		// AGENTS.md exists but is a directory → readFileSync throws
		await mkdir(path.join(imp, "AGENTS.md"), { recursive: true });
		const loaded = loadContextFiles(root, home);
		expect(loaded).toBeNull();
	});
});
