/**
 * MCP config discovery (M18, docs/design/m18-mcp-design.md §2; M19 D2/D7,
 * docs/design/m19-mcp-http-design.md).
 *
 * Five locations in pi-mcp-adapter's order (adapter config.ts:15-21):
 * generic global ~/.config/mcp/mcp.json → ~/.agents/mcp.json →
 * ~/.agents/mcp/mcp.json → project .mcp.json → project mcp.json.
 * The two project-tier files ride the M8 trust gate: `projectAllowed:false`
 * skips them unread (one teaching note when a skipped file exists).
 * Later files override earlier ones per server name (WHOLE entry — a
 * deliberate deviation from pi's field-level merge; M19 D3 re-decided to
 * keep it, and the revisit trigger lives in that decision).
 *
 * Two server shapes (M19 D2): `command` → stdio; `url` → Streamable HTTP
 * with static credentials (token-in-URL or `headers`). An optional `type`
 * may confirm the kind ("stdio", "http", "streamableHttp",
 * "streamable-http"); "sse" is refused for now (SSE-legacy — see M19 §6).
 * command+url together, or neither, is a one-line skip.
 *
 * Tolerance is the rule (design §2): a bad file or a bad entry never blocks
 * startup — each gets one note line and is skipped. Notes never echo a URL
 * (it may carry a token). Env placeholders (${VAR}, $env:VAR, {env:VAR} —
 * adapter utils.ts:136-138) expand in command/args/env values and in
 * url/headers values; an undefined variable expands to "".
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpStdioServerConfig {
	kind: "stdio";
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	disabled: boolean;
}

export interface McpHttpServerConfig {
	kind: "http";
	name: string;
	url: string;
	headers: Record<string, string>;
	disabled: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

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

/** Accepted `type` spellings (case-insensitive) → kind. "sse" stays listed
 *  so the entry can teach why it is refused (M19 §6 has the fallback plan). */
const TYPE_ALIASES: Record<string, "stdio" | "http" | "sse"> = {
	stdio: "stdio",
	http: "http",
	streamablehttp: "http",
	"streamable-http": "http",
	sse: "sse",
};

/** RFC 7230 token characters — a header name must match. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** https anywhere; plain http only for loopback (M19 D2). */
export function isAllowedMcpUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	if (parsed.protocol === "https:") return true;
	if (parsed.protocol === "http:") return isLoopbackHost(parsed.hostname);
	return false;
}

/** Validate + coerce one raw server entry; `error` carries the skip reason,
 *  `notes` the non-fatal teaching lines (ignored fields). */
function coerceServerEntry(
	name: string,
	raw: unknown,
): { config?: McpServerConfig; error?: string; notes?: string[] } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: `server "${name}" must be an object` };
	}
	const entry = raw as Record<string, unknown>;
	const notes: string[] = [];

	// Explicit `type` (M19 D2): confirm/select the kind; unknown or sse skip.
	let declared: "stdio" | "http" | "sse" | undefined;
	if (entry.type !== undefined) {
		if (typeof entry.type !== "string") {
			return { error: `server "${name}" "type" must be a string` };
		}
		declared = TYPE_ALIASES[entry.type.toLowerCase()];
		if (declared === undefined) {
			return { error: `server "${name}" has unknown "type" "${entry.type}"` };
		}
		if (declared === "sse") {
			return {
				error: `server "${name}" type "sse" is not supported yet (SSE-legacy — see docs/design/m19-mcp-http-design.md §6)`,
			};
		}
	}

	const hasCommand = entry.command !== undefined;
	const hasUrl = entry.url !== undefined;
	if (hasCommand && hasUrl) {
		return { error: `server "${name}" has both "command" and "url" — exactly one is required` };
	}
	if (!hasCommand && !hasUrl) {
		return { error: `server "${name}" needs a string "command" (stdio) or "url" (http)` };
	}
	const kind = declared ?? (hasCommand ? "stdio" : "http");
	if (kind === "stdio" && !hasCommand) {
		return { error: `server "${name}" declares type "stdio" but has no "command"` };
	}
	if (kind === "http" && !hasUrl) {
		return { error: `server "${name}" declares type "http" but has no "url"` };
	}
	if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
		return { error: `server "${name}" disabled must be a boolean` };
	}
	const disabled = entry.disabled === true;

	if (kind === "stdio") {
		if (typeof entry.command !== "string" || entry.command === "") {
			return { error: `server "${name}" needs a string "command"` };
		}
		if (entry.headers !== undefined) {
			notes.push(`mcp: server "${name}" has "headers" without a url — ignored`);
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
		return {
			config: {
				kind: "stdio",
				name,
				command: expandEnvPlaceholders(entry.command),
				args: args as string[],
				env,
				cwd: entry.cwd,
				disabled,
			},
			notes,
		};
	}

	// http (M19 D2/D5)
	if (typeof entry.url !== "string" || entry.url === "") {
		return { error: `server "${name}" needs a string "url"` };
	}
	for (const ignored of ["args", "env", "cwd"] as const) {
		if (entry[ignored] !== undefined) {
			notes.push(`mcp: server "${name}" has "${ignored}" but a url — ignored`);
		}
	}
	const url = expandEnvPlaceholders(entry.url);
	if (!isAllowedMcpUrl(url)) {
		return {
			error: `server "${name}" url must be a valid https URL (plain http only for loopback hosts)`,
		};
	}
	const headers: Record<string, string> = {};
	if (entry.headers !== undefined) {
		if (entry.headers === null || typeof entry.headers !== "object" || Array.isArray(entry.headers)) {
			return { error: `server "${name}" headers must be an object` };
		}
		for (const [key, value] of Object.entries(entry.headers as Record<string, unknown>)) {
			if (!HEADER_NAME.test(key)) {
				return { error: `server "${name}" header name "${key}" is invalid` };
			}
			if (typeof value !== "string") {
				return { error: `server "${name}" headers values must be strings ("${key}")` };
			}
			if (/[\r\n\0]/.test(value)) {
				return { error: `server "${name}" header "${key}" contains control characters` };
			}
			headers[key] = expandEnvPlaceholders(value);
		}
	}
	return { config: { kind: "http", name, url, headers, disabled }, notes };
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
	/** M19 F1 (docs/design/m19-mcp-http-design.md D7): the M8 trust bit for the
	 *  project tier. REQUIRED — fail-closed plumbing: every caller must decide
	 *  explicitly; false means the two project-tier files are not even read. */
	projectAllowed: boolean;
}): McpConfigResult {
	const notes: string[] = [];
	const paths = options.paths ?? mcpConfigPaths(options);
	// The project-tier files are executable resources under the M8 trust gate:
	// a refused directory must not read them (one teaching note, and only when
	// a skipped file actually exists — refused dirs without mcp config stay quiet).
	const projectPaths = new Set([join(options.cwd, ".mcp.json"), join(options.cwd, "mcp.json")]);
	const gated = (file: string): boolean => !options.projectAllowed && projectPaths.has(file);
	if (paths.some((file) => gated(file) && existsSync(file))) {
		notes.push("mcp: project config skipped — directory not trusted (--trust to enable)");
	}
	const byName = new Map<string, McpServerConfig>();
	for (const file of paths) {
		if (gated(file)) continue;
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
			const { config, error, notes: entryNotes } = coerceServerEntry(name, raw);
			if (error !== undefined || config === undefined) {
				notes.push(`mcp: ${file} ${error ?? "invalid entry"} — skipped`);
				continue;
			}
			for (const note of entryNotes ?? []) notes.push(note);
			byName.set(name, config); // whole-entry replace: later file wins
		}
	}
	return { servers: [...byName.values()], notes, paths };
}
