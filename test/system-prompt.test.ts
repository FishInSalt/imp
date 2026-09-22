import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, mcpCatalogEntries, type PromptCatalogTool } from "../src/core/system-prompt.js";
import type { Tool } from "../src/core/tools/types.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

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
		expect(prompt).toContain("3. After editing code, verify the change");
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
		const base = await mkdtemp(path.join(tmpdir(), "imp-sys-"));
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
	});

	it("refreshSystemPrompt re-assembles (MCP sync seam) without new notes", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-sys2-"));
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
