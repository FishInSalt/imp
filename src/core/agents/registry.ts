import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Agent registry (M5 design §9/M5c): subagent personas as markdown files.
 *
 *   <cwd>/.imp/agents/*.md   — project agents (win on name collision)
 *   ~/.imp/agents/*.md       — user agents
 *
 * Format — hand-rolled frontmatter (no YAML dep), ~40 lines by design:
 *
 *   ---
 *   name: scout
 *   description: Explores a codebase to answer research questions
 *   tools: read, grep, find        # optional: subset of the parent pool
 *   model: glm-5.3                 # optional: spawn-time override
 *   timeout: 300                   # optional: seconds, wall clock
 *   worktree: true                 # optional: isolated git worktree (M6b)
 *   ---
 *
 *   Body appended to the child's system prompt (append-only mode).
 *
 * No builtin agents: the registry is user/project-owned from day one.
 */

export interface AgentDefinition {
	name: string;
	description: string;
	/** Optional subset of the parent tool pool (names). */
	tools?: string[];
	/** Optional model override, read at spawn. */
	model?: string;
	/** Run this agent's tasks in an isolated git worktree (M6b). */
	worktree?: boolean;
	/** Optional wall clock (ms), from frontmatter seconds. */
	timeoutMs?: number;
	/** Markdown body — appended after CHILD_SUFFIX. */
	system: string;
	/** File path, for diagnostics. */
	source: string;
}

export interface AgentRegistry {
	agents: AgentDefinition[];
	/** Teaching-style diagnostics for skipped files (shown once at startup). */
	warnings: string[];
}

/** Parse one agent file. Exported for direct testing. */
export function parseAgentFile(content: string, source: string): AgentDefinition | string {
	if (!content.startsWith("---")) {
		return `${source}: no frontmatter — start the file with a "---" line`;
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) return `${source}: unterminated frontmatter — close it with a "---" line`;

	const fields = new Map<string, string>();
	for (const line of content.slice(4, end).split("\n")) {
		if (line.trim() === "") continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue; // unknown shape — key stays absent, validated below
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key !== "" && value !== "") fields.set(key, value);
	}

	const name = fields.get("name");
	const description = fields.get("description");
	if (!name) return `${source}: missing required field "name"`;
	if (!description) return `${source}: missing required field "description"`;

	let timeoutMs: number | undefined;
	const timeoutRaw = fields.get("timeout");
	if (timeoutRaw !== undefined) {
		const seconds = Number(timeoutRaw);
		if (!Number.isFinite(seconds) || seconds <= 0) {
			return `${source}: invalid "timeout" "${timeoutRaw}" — use positive seconds (e.g. timeout: 300)`;
		}
		timeoutMs = seconds * 1000;
	}
	let worktree = false;
	const worktreeRaw = fields.get("worktree");
	if (worktreeRaw !== undefined) {
		const flag = worktreeRaw.trim().toLowerCase();
		if (flag === "true") worktree = true;
		else if (flag !== "false") {
			return `${source}: invalid "worktree" "${worktreeRaw}" — use true or false`;
		}
	}

	const toolsRaw = fields.get("tools");
	const tools = toolsRaw
		?.split(",")
		.map((t) => t.trim())
		.filter((t) => t !== "");

	const body = content
		.slice(end + 4)
		.replace(/^\n+/, "")
		.replace(/\s+$/, "");

	return {
		name,
		description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: fields.get("model"),
		timeoutMs,
		worktree: worktree || undefined,
		system: body,
		source,
	};
}

function scanDir(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		return []; // missing dir = no agents there — not an error
	}
}

/**
 * Load all agent definitions: user dir first, then project dir — project
 * entries overwrite same-name user entries (project wins). Listing order is
 * alphabetical by name, so /help-style surfaces stay deterministic.
 */
export function loadAgentDefinitions(cwd: string, homeDir = homedir()): AgentRegistry {
	const byName = new Map<string, AgentDefinition>();
	const warnings: string[] = [];
	const dirs = [
		path.join(homeDir, ".imp", "agents"), // scanned first: loses collisions
		path.join(cwd, ".imp", "agents"), // scanned last: wins collisions
	];
	for (const dir of dirs) {
		for (const file of scanDir(dir)) {
			const filePath = path.join(dir, file);
			const parsed = parseAgentFile(readFileSync(filePath, "utf8"), filePath);
			if (typeof parsed === "string") {
				warnings.push(`agent file skipped: ${parsed}`);
				continue;
			}
			byName.set(parsed.name, parsed);
		}
	}
	const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	return { agents, warnings };
}
