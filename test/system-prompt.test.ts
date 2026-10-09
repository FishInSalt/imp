import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, mcpCatalogEntries, type PromptCatalogTool } from "../src/core/system-prompt.js";
import type { Tool } from "../src/core/tools/types.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";

const CTX = { cwd: "/w", platform: "darwin", arch: "arm64", date: "2026-09-08" };

describe("buildSystemPrompt (prompt-audit P5/P6)", () => {
	it("builds the catalog from snippets — one routing line per tool", () => {
		const tools: PromptCatalogTool[] = [
			{ name: "bash", promptSnippet: "run shell commands — anything without a dedicated tool." },
			{ name: "read", promptSnippet: "read files; truncation notes tell you how to continue." },
			{ name: "task", promptSnippet: "delegate a self-contained multi-step job to a fresh subagent." },
		];
		const prompt = buildSystemPrompt(CTX, tools);
		expect(prompt).toContain("# Available tools");
		expect(prompt.match(/^- bash: /gm)).toHaveLength(1);
		expect(prompt.match(/^- read: /gm)).toHaveLength(1);
		expect(prompt.match(/^- task: /gm)).toHaveLength(1);
	});

	it("the old teaching sections are gone; the verify rule is a core rule", () => {
		const prompt = buildSystemPrompt(CTX, [{ name: "bash", promptSnippet: "x" }]);
		expect(prompt).not.toContain("# Tools\n");
		expect(prompt).not.toContain("# Editing rules");
		expect(prompt).toContain("You are Ink");
		expect(prompt).toContain("AI assistant and agent harness");
		expect(prompt).toContain(
			"1. Work inside the current working directory unless the user explicitly asks otherwise.",
		);
		expect(prompt).toContain(
			"2. Inspect before you modify: read a file (or list/grep via bash) before editing it. Never guess file contents.",
		);
		expect(prompt).toContain("3. After editing code, verify the change");
		expect(prompt).toContain(
			"4. Be concise. State what you changed (file paths, commands run); do not dump whole files back at the user.",
		);
		expect(prompt).toContain(
			"5. If a task fails, say what failed and why. Do not silently give up or fake success.",
		);
		expect(prompt).toContain(
			"6. When a request is ambiguous or destructive beyond the workspace, ask the user first.",
		);
		expect(prompt).toContain("In addition to the tools above");
	});

	it("snippet-less tools stay out of the catalog (covered by the In-addition line)", () => {
		const prompt = buildSystemPrompt(CTX, [{ name: "custom" }, { name: "bash", promptSnippet: "x" }]);
		expect(prompt).not.toContain("- custom:");
		expect(prompt).toContain("- bash: x");
	});

	it("environment block keeps cwd/platform/date", () => {
		const prompt = buildSystemPrompt(CTX, []);
		expect(prompt).toContain("Working directory: /w");
		expect(prompt).toContain("Platform: darwin (arm64)");
		expect(prompt).toContain("Date: 2026-09-08");
		expect(prompt).not.toContain("# Available tools");
	});
});

describe("buildSystemPrompt concurrency disclosure (#readonly-parallel)", () => {
	const safeTool = (name: string, snippet = `${name} things`): PromptCatalogTool => ({
		name,
		promptSnippet: snippet,
		concurrencySafe: true,
	});

	it("renders the derived line with roster names when ≥2 safe snippet tools exist", () => {
		const prompt = buildSystemPrompt(CTX, [
			{ name: "bash", promptSnippet: "run shell commands." },
			safeTool("read"),
			safeTool("grep"),
			safeTool("find"),
			safeTool("ls"),
			safeTool("task"),
		]);
		expect(prompt).toContain(
			"Several of the tools above (read, grep, find, ls, task) can run concurrently. When you need several of these calls and they are independent of each other, make all of them in the same message.",
		);
		expect(prompt).toContain("A call that depends on an earlier result must wait for that result.");
		// exact shape (design §1.1 NIT-4): blank line + non-bullet paragraph,
		// inside the catalog block, before the In-addition line
		const catalog = prompt.slice(prompt.indexOf("# Available tools"), prompt.indexOf("In addition"));
		expect(catalog).toContain(
			"- task: task things\n\nSeveral of the tools above (read, grep, find, ls, task)",
		);
		expect(catalog).not.toContain("\n- Several of the tools");
	});

	it("no disclosure with a single safe tool — one member teaches nothing about batching", () => {
		const prompt = buildSystemPrompt(CTX, [
			{ name: "bash", promptSnippet: "run shell commands." },
			safeTool("task"),
		]);
		expect(prompt).not.toContain("concurrently");
	});

	it("safe tools without a snippet do not count and are not named (no dangling references)", () => {
		const prompt = buildSystemPrompt(CTX, [
			safeTool("read"),
			{ name: "ghost", promptSnippet: "", concurrencySafe: true }, // empty snippet: not listed
			{ name: "unnamed", concurrencySafe: true }, // no snippet: not listed
		]);
		expect(prompt).not.toContain("concurrently"); // only one safe∩snippet tool
	});

	it("a safe roster larger than 6 drops the parenthesized name list (token budget)", () => {
		const prompt = buildSystemPrompt(CTX, [
			safeTool("a"),
			safeTool("b"),
			safeTool("c"),
			safeTool("d"),
			safeTool("e"),
			safeTool("f"),
			safeTool("g"),
		]);
		expect(prompt).toContain("Several of the tools above can run concurrently");
		expect(prompt).not.toContain("(a, b");
	});

	it("MCP degraded entries (snippet, no flag) never enter the roster", () => {
		const prompt = buildSystemPrompt(CTX, [
			safeTool("read"),
			{ name: "MCP server fetch", promptSnippet: "third-party tools." },
			safeTool("grep"),
		]);
		expect(prompt).toContain("(read, grep) can run concurrently");
	});

	it("override drops the disclosure with the catalog; append-only keeps it", () => {
		const tools = [safeTool("read"), safeTool("grep")];
		const overridden = buildSystemPrompt(CTX, tools, { override: "Custom identity." });
		expect(overridden).not.toContain("# Available tools");
		expect(overridden).not.toContain("concurrently");
		const appended = buildSystemPrompt(CTX, tools, { append: "APPEND-MARKER" });
		expect(appended).toContain("(read, grep) can run concurrently");
		expect(appended).toContain("APPEND-MARKER");
	});
});

describe("mcpCatalogEntries (prompt-audit P7)", () => {
	const mcpTool = (name: string, snippet: string): PromptCatalogTool & { mcpServer: string } => ({
		name,
		promptSnippet: snippet,
		mcpServer: "zai-vision",
	});

	it("under the 2KB budget: one line per tool with the FULL call name", () => {
		const entries = mcpCatalogEntries([
			mcpTool("zai-vision_analyze_image", "analyze an image"),
			mcpTool("zai-vision_analyze_video", "analyze a video"),
		]);
		expect(entries.map((e) => e.name)).toEqual(["zai-vision_analyze_image", "zai-vision_analyze_video"]);
	});

	it("past 2KB it degrades to one line per server", () => {
		const tools = Array.from({ length: 30 }, (_, i) => mcpTool(`zai-vision_tool_${i}`, "x".repeat(80)));
		const entries = mcpCatalogEntries(tools);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe("MCP server zai-vision");
		expect(entries[0]?.promptSnippet).toBe("30 tools (descriptions in the tool list)");
	});

	it("non-mcp tools never enter the mcp catalog", () => {
		expect(mcpCatalogEntries([{ name: "bash", promptSnippet: "x" }])).toEqual([]);
	});
});
describe("runner system assembly (prompt-audit P4/P5/P7 integration)", () => {
	it("context files land as <project_instructions> XML inside <project_context>", async () => {
		const base = await mkTempDirAsync("ink-sys-");
		await writeFile(join(base, "AGENTS.md"), "Project rule: be terse.", "utf8");
		const { renderer } = makeRenderer();
		const runner = await createRunner({
			cwd: base,
			argv: [],
			settingsPath: join(base, "settings.json"),
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 2,
			noContextFiles: false,
			noSession: true,
			renderer,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])]),
		});
		const system = runner.system;
		expect(system).toContain("<project_context>");
		expect(system).toContain(`<project_instructions path="${join(base, "AGENTS.md")}">`);
		expect(system).toContain("Project rule: be terse.");
		expect(system).toContain("</project_instructions>");
		expect(system).not.toContain("# Project context (AGENTS.md)");
		// the catalog is real: every builtin carries a routing line
		expect(system).toContain("# Available tools");
		expect(system).toMatch(/^- bash: /m);
		expect(system).toMatch(/^- task: /m);
		// #readonly-parallel (design §4.7b): zero-adaptation plumbing — the
		// real tool objects carry concurrencySafe into the derived line.
		expect(system).toContain("(read, grep, find, ls, task) can run concurrently");
	});

	it("refreshSystemPrompt re-assembles (MCP sync seam) without new notes", async () => {
		const base = await mkTempDirAsync("ink-sys2-");
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: base,
			argv: [],
			settingsPath: join(base, "settings.json"),
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 2,
			noContextFiles: true,
			noSession: true,
			renderer,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])]),
		});
		const before = runner.system;
		const noteLinesBefore = output()
			.split("\n")
			.filter((l) => l.includes("context:")).length;
		// a late MCP tool appears in the catalog after a refresh
		const late: Tool = {
			name: "zai-vision_analyze_image",
			description: "full server description",
			promptSnippet: "analyze an image",
			mcpServer: "zai-vision",
			parameters: Type.Object({}),
			async execute() {
				return { output: "ok" };
			},
		};
		runner.tools.push(late);
		runner.refreshSystemPrompt();
		const after = runner.system;
		expect(after).toContain("- zai-vision_analyze_image: analyze an image");
		expect(after).not.toBe(before);
		const noteLinesAfter = output()
			.split("\n")
			.filter((l) => l.includes("context:")).length;
		expect(noteLinesAfter).toBe(noteLinesBefore); // refresh is silent
	});
});

describe("buildSystemPrompt override/append (#system-md)", () => {
	it("override replaces the body; cwd line survives; append follows the override", () => {
		const prompt = buildSystemPrompt(CTX, [{ name: "bash", promptSnippet: "x" }], {
			override: "You are my Rust reviewer.",
			append: "Answer in Chinese.",
		});
		expect(prompt.startsWith("You are my Rust reviewer.")).toBe(true);
		expect(prompt).not.toContain("# Core rules");
		expect(prompt).not.toContain("# Available tools");
		expect(prompt).not.toContain("# Environment");
		expect(prompt).toContain("Current working directory: /w");
		expect(prompt.indexOf("You are my Rust reviewer.")).toBeLessThan(prompt.indexOf("Answer in Chinese."));
	});

	it("append-only lands after the default body", () => {
		const prompt = buildSystemPrompt(CTX, [], { append: "Answer in Chinese." });
		expect(prompt).toContain("# Core rules");
		expect(prompt).toContain("Use tools proactively");
		expect(prompt.trimEnd().endsWith("Answer in Chinese.")).toBe(true);
	});
});

describe("buildSystemPrompt selfDocs (self-docs-design D4)", () => {
	const docs = {
		readme: "/usr/local/lib/node_modules/ink-agent/README.md",
		docs: "/usr/local/lib/node_modules/ink-agent/docs",
		examples: "/usr/local/lib/node_modules/ink-agent/examples",
	};

	it("renders the docs section after the catalog line, before append", () => {
		const prompt = buildSystemPrompt(CTX, [{ name: "read", promptSnippet: "x" }], {
			selfDocs: docs,
			append: "Answer in Chinese.",
		});
		const docsAt = prompt.indexOf("Ink documentation");
		expect(docsAt).toBeGreaterThan(-1);
		expect(docsAt).toBeGreaterThan(prompt.indexOf("Use tools proactively")); // catalog section last line
		expect(docsAt).toBeLessThan(prompt.indexOf("Answer in Chinese.")); // before append
		expect(prompt).toContain(`- Main documentation: ${docs.readme}`);
		expect(prompt).toContain(`- Full docs index: ${docs.docs}/index.md`);
	});

	it("override mode omits the docs section (pi parity)", () => {
		const prompt = buildSystemPrompt(CTX, [], {
			override: "You are my Rust reviewer.",
			append: "Answer in Chinese.",
			selfDocs: docs,
		});
		expect(prompt).not.toContain("Ink documentation");
	});

	it("undefined selfDocs omits the section (old-install degradation)", () => {
		const prompt = buildSystemPrompt(CTX, [], {});
		expect(prompt).not.toContain("Ink documentation");
	});
});

describe("runner SYSTEM.md integration (#system-md)", () => {
	async function makeBase(): Promise<string> {
		const base = await mkTempDirAsync("ink-sysmd-");
		await mkdir(join(base, ".ink"), { recursive: true });
		return base;
	}

	async function makeRunner(base: string, extra: Record<string, unknown> = {}) {
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: base,
			argv: [],
			settingsPath: join(base, "settings.json"),
			systemPromptHomeDir: join(base, "home"),
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 2,
			noContextFiles: false,
			noSession: true,
			renderer,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])]),
			...extra,
		});
		return { runner, output };
	}

	it("override replaces the body; context/skills/agents survive (D3/D4); note fires", async () => {
		const base = await makeBase();
		await mkdir(join(base, "home"), { recursive: true });
		await writeFile(join(base, ".ink", "SYSTEM.md"), "You are my Rust reviewer.");
		await writeFile(join(base, "AGENTS.md"), "Project rule: be terse.");
		const { runner, output } = await makeRunner(base, {
			systemPromptProjectAllowed: true,
			skills: [
				{
					name: "demo",
					description: "A demo skill",
					filePath: join(base, "demo.md"),
					baseDir: base,
					source: "path",
				},
			],
		});
		const system = runner.system;
		expect(system.startsWith("You are my Rust reviewer.")).toBe(true);
		expect(system).not.toContain("# Core rules");
		// the four survivors: cwd line, context XML, skills block
		expect(system).toContain(`Current working directory: ${base}`);
		expect(system).toContain("<project_context>");
		expect(system).toContain("Project rule: be terse.");
		expect(system).toContain("<available_skills>");
		expect(output()).toContain("▪ system: .ink/SYSTEM.md");
	});

	it("P1-1 pin: session trust (nothing recorded in the store) still loads the project file", async () => {
		const base = await makeBase();
		await mkdir(join(base, "home"), { recursive: true });
		await writeFile(join(base, ".ink", "SYSTEM.md"), "session persona");
		// no trust store anywhere — the session-resolved boolean is the only grant
		const { runner } = await makeRunner(base, { systemPromptProjectAllowed: true });
		expect(runner.system.startsWith("session persona")).toBe(true);
	});

	it("default is conservative: without the flag the project file is ignored (global home empty)", async () => {
		const base = await makeBase();
		await mkdir(join(base, "home"), { recursive: true });
		await writeFile(join(base, ".ink", "SYSTEM.md"), "project persona");
		const { runner, output } = await makeRunner(base);
		expect(runner.system).toContain("# Core rules");
		expect(output()).not.toContain("▪ system:");
	});

	it("P1-2 hermeticity: systemPromptHomeDir isolates the global tier both ways", async () => {
		const base = await makeBase();
		const home = join(base, "home");
		await mkdir(join(home, ".ink"), { recursive: true });
		await writeFile(join(home, ".ink", "SYSTEM.md"), "global persona");
		const withGlobal = await makeRunner(base);
		expect(withGlobal.runner.system.startsWith("global persona")).toBe(true);
		// a different, empty home → no override even though the first home exists on disk
		const emptyHome = join(base, "home2");
		await mkdir(join(emptyHome, ".ink"), { recursive: true });
		const without = await makeRunner(base, { systemPromptHomeDir: emptyHome });
		expect(without.runner.system).toContain("# Core rules");
	});

	it("mixed pairs render per-file superseded notes + unreadable warns (impl review P2)", async () => {
		const base = await makeBase();
		const home = join(base, "home");
		await mkdir(join(home, ".ink"), { recursive: true });
		await writeFile(join(base, ".ink", "SYSTEM.md"), "project persona");
		await writeFile(join(base, ".ink", "APPEND_SYSTEM.md"), "project append");
		await writeFile(join(home, ".ink", "APPEND_SYSTEM.md"), "global append");
		const { output } = await makeRunner(base, { systemPromptProjectAllowed: false });
		expect(output()).toContain("global APPEND_SYSTEM.md active — project .ink/APPEND_SYSTEM.md ignored");
		expect(output()).not.toContain("global SYSTEM.md active"); // SYSTEM pair has no global takeover
	});

	it("an unreadable trusted file renders the skip warn (D5)", async () => {
		const base = await makeBase();
		await mkdir(join(base, "home"), { recursive: true });
		const locked = join(base, ".ink", "APPEND_SYSTEM.md");
		await writeFile(locked, "locked append");
		await chmod(locked, 0o000);
		const { output } = await makeRunner(base, { systemPromptProjectAllowed: true });
		expect(output()).toContain("▪ could not read .ink/APPEND_SYSTEM.md — skipped");
	});

	it("self-docs section is present when a read tool exists, absent without one (self-docs D4 gate)", async () => {
		// The repo checkout this test runs in carries docs/index.md, so
		// resolveInstallRoot() finds a root and the read gate is the only
		// variable. Default loadout includes read → section present.
		const base = await makeBase();
		await mkdir(join(base, "home"), { recursive: true });
		const withRead = await makeRunner(base, {});
		expect(withRead.runner.system).toContain("Ink documentation");

		// A read-less pool drops the section: the paths are dead text without
		// a reader. options.tools replaces the default pool entirely (runner
		// "test seam", design §8.1) — bash alone carries no read tool.
		const { createBashTool } = await import("../src/core/tools/bash.js");
		const noRead = await makeRunner(base, {
			tools: [createBashTool({ cwd: base })],
		});
		expect(noRead.runner.system).not.toContain("Ink documentation");
	});

	it("untrusted + global takeover renders the superseded note (D6 copy)", async () => {
		const base = await makeBase();
		const home = join(base, "home");
		await mkdir(join(home, ".ink"), { recursive: true });
		await writeFile(join(base, ".ink", "SYSTEM.md"), "project persona");
		await writeFile(join(home, ".ink", "SYSTEM.md"), "global persona");
		const { runner, output } = await makeRunner(base, { systemPromptProjectAllowed: false });
		expect(runner.system.startsWith("global persona")).toBe(true);
		expect(output()).toContain("global SYSTEM.md active — project .ink/SYSTEM.md ignored");
		expect(output()).toContain("ink --trust to enable");
	});

	it("D10: mid-session file edit is picked up by refreshSystemPrompt", async () => {
		const base = await makeBase();
		await mkdir(join(base, "home"), { recursive: true });
		const { runner } = await makeRunner(base, { systemPromptProjectAllowed: true });
		expect(runner.system).toContain("# Core rules");
		await writeFile(join(base, ".ink", "SYSTEM.md"), "edited persona");
		runner.refreshSystemPrompt();
		expect(runner.system.startsWith("edited persona")).toBe(true);
	});
});

// #compaction-ux F4a withdrawal (design §10): the six core rules are behavior
// contracts; the output-discipline guideline was an efficiency tip that diluted
// them (and its motivating evidence was zero-cost under plan/1M-window usage).
// Pin that it stays OUT and the count stays six.
it("core rules stay exactly six — no output-discipline rule (F4a withdrawn)", () => {
	const prompt = buildSystemPrompt(CTX, [{ name: "bash", promptSnippet: "x" }]);
	expect(prompt).not.toContain("Keep tool outputs small");
	const rules =
		prompt
			.split("# Core rules")[1]
			?.split("#")[0]
			?.match(/^\d+\./gm) ?? [];
	expect(rules).toHaveLength(6);
});
