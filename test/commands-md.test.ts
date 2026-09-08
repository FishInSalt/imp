import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMdCommands, parseMdFrontmatter, renderMdPrompt } from "../src/core/commands-md.js";

async function scaffold(): Promise<{ home: string; cwd: string; reserved: Set<string> }> {
	const root = await mkdtemp(path.join(tmpdir(), "imp-mdcmd-"));
	return { home: path.join(root, "home"), cwd: path.join(root, "proj"), reserved: new Set(["help", "exit"]) };
}

async function put(dir: string, file: string, content: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, file), content, "utf8");
}

describe("parseMdFrontmatter", () => {
	it("no frontmatter: the whole file is the body, defaults apply", () => {
		const parsed = parseMdFrontmatter("just a prompt", "x.md");
		expect(parsed).toEqual({ description: undefined, allowedDuringRun: false, body: "just a prompt" });
	});

	it("parses description and allowedDuringRun; body follows the closing fence", () => {
		const parsed = parseMdFrontmatter(
			"---\ndescription: Review diffs\nallowedDuringRun: true\n---\nReview. $ARGUMENTS",
			"x.md",
		);
		expect(parsed).toEqual({
			description: "Review diffs",
			allowedDuringRun: true,
			body: "Review. $ARGUMENTS",
		});
	});

	it("unterminated frontmatter is a teaching error", () => {
		expect(parseMdFrontmatter("---\ndescription: x", "x.md")).toBe(
			'x.md: unterminated frontmatter — close it with a "---" line',
		);
	});

	it("invalid allowedDuringRun is a teaching error", () => {
		expect(parseMdFrontmatter("---\nallowedDuringRun: maybe\n---\nbody", "x.md")).toContain("invalid");
	});
});

describe("renderMdPrompt", () => {
	it("substitutes $ARGUMENTS where present", () => {
		expect(renderMdPrompt("Review. $ARGUMENTS — risk ordered", "focus concurrency")).toBe(
			"Review. focus concurrency — risk ordered",
		);
	});
	it("without the placeholder, args append as their own paragraph", () => {
		expect(renderMdPrompt("Review the diff.", "focus concurrency")).toBe(
			"Review the diff.\n\nfocus concurrency",
		);
	});
	it("no args without the placeholder: body alone", () => {
		expect(renderMdPrompt("Review the diff.", "")).toBe("Review the diff.");
	});
});

describe("loadMdCommands", () => {
	it("loads the global tier; the project tier requires the trust gate", async () => {
		const { home, cwd, reserved } = await scaffold();
		await put(path.join(home, ".imp", "commands"), "fix.md", "---\ndescription: fix things\n---\nfix it");
		await put(path.join(cwd, ".imp", "commands"), "review.md", "review it");
		const gated = await loadMdCommands({ cwd, home, projectAllowed: false, reserved });
		expect(gated.commands.map((c) => c.command.name)).toEqual(["fix"]);
		expect(gated.commands[0]?.source).toBe("md:global");
		const allowed = await loadMdCommands({ cwd, home, projectAllowed: true, reserved });
		expect(allowed.commands.map((c) => c.command.name).sort()).toEqual(["fix", "review"]);
	});

	it("a project file overrides a global file with the same name", async () => {
		const { home, cwd, reserved } = await scaffold();
		await put(path.join(home, ".imp", "commands"), "fix.md", "global body");
		await put(path.join(cwd, ".imp", "commands"), "fix.md", "project body");
		const loaded = await loadMdCommands({ cwd, home, projectAllowed: true, reserved });
		expect(loaded.commands).toHaveLength(1);
		expect(loaded.commands[0]?.source).toBe("md:project");
		const prompts: string[] = [];
		await loaded.commands[0]?.command.run("", {
			submitPrompt: (t: string) => prompts.push(t),
		} as never);
		expect(prompts).toEqual(["project body"]);
	});

	it("a BOM-prefixed file parses frontmatter, not body (review)", async () => {
		const parsed = parseMdFrontmatter("\uFEFF---\ndescription: bombed\n---\nbody text", "x.md");
		expect(parsed).toEqual({ description: "bombed", allowedDuringRun: false, body: "body text" });
	});

	it("uppercase filenames are rejected — dispatch is case-sensitive (review)", async () => {
		const { home, reserved } = await scaffold();
		const dir = path.join(home, ".imp", "commands");
		await put(dir, "Fix.md", "nope");
		const diags: string[] = [];
		const loaded = await loadMdCommands({
			cwd: "/tmp",
			home,
			projectAllowed: true,
			reserved,
			onDiagnostic: (m) => diags.push(m),
		});
		expect(loaded.commands).toEqual([]);
		expect(diags.join("\n")).toContain("[a-z0-9]");
	});

	it("extension command names join the reserved set — no silent shadowing (review)", async () => {
		const { home, reserved } = await scaffold();
		const dir = path.join(home, ".imp", "commands");
		await put(dir, "deploy.md", "deploy it");
		const diags: string[] = [];
		const withExt = new Set([...reserved, "deploy"]);
		const loaded = await loadMdCommands({
			cwd: "/tmp",
			home,
			projectAllowed: true,
			reserved: withExt,
			onDiagnostic: (m) => diags.push(m),
		});
		expect(loaded.commands).toEqual([]);
		expect(diags.join("\n")).toContain("deploy");
	});

	it("reserved and malformed names are rejected with diagnostics; empty bodies are rejected", async () => {
		const { home, reserved } = await scaffold();
		const dir = path.join(home, ".imp", "commands");
		await put(dir, "help.md", "nope");
		await put(dir, "bad name.md", "nope");
		await put(dir, "empty.md", "---\ndescription: nothing\n---\n");
		const diags: string[] = [];
		const loaded = await loadMdCommands({
			cwd: "/tmp",
			home,
			projectAllowed: true,
			reserved,
			onDiagnostic: (m) => diags.push(m),
		});
		expect(loaded.commands).toEqual([]);
		expect(diags.join("\n")).toContain("built-in command");
		expect(diags.join("\n")).toContain("[a-z0-9]");
		expect(diags.join("\n")).toContain("empty");
	});
});
