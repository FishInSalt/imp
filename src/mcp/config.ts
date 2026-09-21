/**
 * MCP config discovery (M18, docs/m18-mcp-design.md §2).
 *
 * Five locations in pi-mcp-adapter's order (adapter config.ts:15-21):
 * generic global ~/.config/mcp/mcp.json → ~/.agents/mcp.json →
 * ~/.agents/mcp/mcp.json → project .mcp.json → project mcp.json.
 * Later files override earlier ones per server name (WHOLE entry — a
 * deliberate deviation from pi's field-level merge, which carries a
 * credential-binding rule that a stdio-only v1 has no surface for).
 *
 * Tolerance is the rule (design §2): a bad file or a bad entry never blocks
 * startup — each gets one note line and is skipped. Env placeholders
 * (${VAR}, $env:VAR, {env:VAR} — adapter utils.ts:136-138) expand in
 * command/args/env values; an undefined variable expands to "".
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpServerConfig {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	disabled: boolean;
}

export interface McpConfigResult {
	/** Merged (later-wins) server configs in stable discovery order. */
	servers: McpServerConfig[];
	/** One teaching line per skipped file/entry — surfaced via renderer.note. */
	notes: string[];
	/** Every discovery path, in order — the /mcp "looked in" hint. */
	paths: string[];
}

/** The five discovery paths (override `home`/`cwd` for hermetic tests). */
export function mcpConfigPaths(options: { home?: string; cwd: string }): string[] {
	const home = options.home ?? homedir();
	return [
		join(home, ".config", "mcp", "mcp.json"),
		join(home, ".agents", "mcp.json"),
		join(home, ".agents", "mcp", "mcp.json"),
		join(options.cwd, ".mcp.json"),
		join(options.cwd, "mcp.json"),
	];
}

/** Expand ${VAR}, $env:VAR and {env:VAR} to process.env.VAR ("" when unset). */
export function expandEnvPlaceholders(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\{env:(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

/** Validate + coerce one raw server entry; `null` carries the skip reason. */
function coerceServerEntry(name: string, raw: unknown): { config?: McpServerConfig; error?: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: `server "${name}" must be an object` };
	}
	const entry = raw as Record<string, unknown>;
	if (typeof entry.command !== "string" || entry.command === "") {
		return { error: `server "${name}" needs a string "command"` };
	}
	const args = Array.isArray(entry.args)
		? entry.args.map((a) => (typeof a === "string" ? expandEnvPlaceholders(a) : null))
		: [];
	if (entry.args !== undefined && args.some((a) => a === null)) {
		return { error: `server "${name}" args must all be strings` };
	}
	const env: Record<string, string> = {};
	if (entry.env !== undefined) {
		if (entry.env === null || typeof entry.env !== "object" || Array.isArray(entry.env)) {
			return { error: `server "${name}" env must be an object` };
		}
		for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
			if (typeof value !== "string") {
				return { error: `server "${name}" env values must be strings ("${key}")` };
			}
			env[key] = expandEnvPlaceholders(value);
		}
	}
	if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
		return { error: `server "${name}" cwd must be a string` };
	}
	if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
		return { error: `server "${name}" disabled must be a boolean` };
	}
	return {
		config: {
			name,
			command: expandEnvPlaceholders(entry.command),
			args: args as string[],
			env,
			cwd: entry.cwd,
			disabled: entry.disabled === true,
		},
	};
}

/**
 * Read the five paths in order and merge. Whole-entry replacement on name
 * collisions (later file wins); never throws.
 */
export function discoverMcpConfig(options: {
	home?: string;
	cwd: string;
	/** Full override of the discovery paths (hermetic tests). */
	paths?: string[];
}): McpConfigResult {
	const notes: string[] = [];
	const paths = options.paths ?? mcpConfigPaths(options);
	const byName = new Map<string, McpServerConfig>();
	for (const file of paths) {
		if (!existsSync(file)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf-8"));
		} catch (err) {
			notes.push(`mcp: ${file} is not valid JSON — skipped`);
			void err;
			continue;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			notes.push(`mcp: ${file} must contain an object — skipped`);
			continue;
		}
		const rawServers = (parsed as Record<string, unknown>).mcpServers;
		if (rawServers === undefined) continue;
		if (rawServers === null || typeof rawServers !== "object" || Array.isArray(rawServers)) {
			notes.push(`mcp: ${file} "mcpServers" must be an object — skipped`);
			continue;
		}
		for (const [name, raw] of Object.entries(rawServers as Record<string, unknown>)) {
			if (name === "") {
				notes.push(`mcp: ${file} has an empty server name — skipped`);
				continue;
			}
			const { config, error } = coerceServerEntry(name, raw);
			if (error !== undefined || config === undefined) {
				notes.push(`mcp: ${file} ${error ?? "invalid entry"} — skipped`);
				continue;
			}
			byName.set(name, config); // whole-entry replace: later file wins
		}
	}
	return { servers: [...byName.values()], notes, paths };
}
