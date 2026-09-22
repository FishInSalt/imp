import os from "node:os";

export interface SystemPromptContext {
	cwd: string;
	platform: string;
	arch: string;
	date: string;
}

/** Catalog entry source (prompt-audit P5): any tool with a promptSnippet
 *  shows up as one routing line. Tools without one (e.g. extension tools
 *  that never declared a snippet) are covered by the "In addition" line. */
export interface PromptCatalogTool {
	name: string;
	promptSnippet?: string;
}

/** #system-md (D3/D4): a full replacement body — identity, environment, core
 *  rules and the tool catalog all go; the cwd line survives because workspace
 *  boundary rules and path resolution depend on it (pi parity). */
export interface SystemPromptOptions {
	override?: string;
	/** APPEND_SYSTEM.md — lands after the body in both modes, before the
	 *  runner's context/skills/agents appendages (pi's relative order). */
	append?: string;
}

/** One routing line per snippet-bearing tool. pi's snippets were too terse to
 *  route on ("Read file contents"); these answer WHEN to reach for the tool —
 *  the decision the model makes before it reads schemas. */
export function buildSystemPrompt(
	context: SystemPromptContext,
	tools: readonly PromptCatalogTool[] = [],
	opts?: SystemPromptOptions,
): string {
	const lines = tools
		.filter((tool) => tool.promptSnippet !== undefined && tool.promptSnippet !== "")
		.map((tool) => `- ${tool.name}: ${tool.promptSnippet}`);
	const catalog =
		lines.length > 0
			? `

# Available tools
${lines.join("\n")}`
			: "";

	const appendSection = opts?.append ? `\n\n${opts.append}` : "";
	if (opts?.override) {
		// The only machine fact that must survive replacement (D4): platform
		// is discoverable via one bash call; cwd is not.
		return `${opts.override}${appendSection}\n\nCurrent working directory: ${context.cwd}`;
	}
	return `You are imp, a small coding agent that runs in the user's terminal.

# Environment
- Working directory: ${context.cwd}
- Platform: ${context.platform} (${context.arch}), shell: bash
- Date: ${context.date}

# Core rules
1. Work inside the current working directory unless the user explicitly asks otherwise.
2. Inspect before you modify: read a file (or list/grep via bash) before editing it. Never guess file contents.
3. After editing code, verify the change — run it or its tests.
4. Be concise. State what you changed (file paths, commands run); do not dump whole files back at the user.
5. If a task fails, say what failed and why. Do not silently give up or fake success.
6. When a request is ambiguous or destructive beyond the workspace, ask the user first.
${catalog}

In addition to the tools above, you may have access to other tools depending on the project.

Use tools proactively to establish facts; base your answers on observed output, not assumptions.${appendSection}`;
}

/** prompt-audit P7: MCP catalog entries — per-tool one-liners while the
 *  total stays under 2048 bytes; past that, degrade to one line per server
 *  (third-party description quality must not grow the system prompt
 *  unboundedly). Pure; exported for tests. */
export function mcpCatalogEntries(
	tools: ReadonlyArray<{ name: string; promptSnippet?: string; mcpServer?: string }>,
): PromptCatalogTool[] {
	const mcpTools = tools.filter((t) => t.mcpServer !== undefined && t.promptSnippet !== undefined);
	if (mcpTools.length === 0) return [];
	const lines = mcpTools.map((t) => `- ${t.name}: ${t.promptSnippet}`);
	if (Buffer.byteLength(lines.join("\n"), "utf8") <= 2048) return mcpTools;
	const byServer = new Map<string, number>();
	for (const tool of mcpTools) {
		const server = tool.mcpServer ?? "?";
		byServer.set(server, (byServer.get(server) ?? 0) + 1);
	}
	return [...byServer].map(
		([server, count]): PromptCatalogTool => ({
			name: `MCP server ${server}`,
			promptSnippet: `${count} tools (descriptions in the tool list)`,
		}),
	);
}

export function defaultSystemPromptContext(): SystemPromptContext {
	return {
		cwd: process.cwd(),
		platform: process.platform,
		arch: process.arch,
		date: new Date().toISOString().slice(0, 10),
	};
}

export function nodeInfo(): string {
	return `${os.type()} ${os.release()}`;
}
