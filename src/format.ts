/**
 * Shared output helpers — plain string formatting plus minimal ANSI wrappers.
 * Extracted from cli.ts so the runner, the REPL, and print mode format
 * identically.
 */

export const VERSION = "0.1.0";

export function dim(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[2m${text}\x1b[0m` : text;
}

export function red(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[31m${text}\x1b[0m` : text;
}

/** First non-empty line of `text`, truncated to `max` chars with an ellipsis. */
export function firstLine(text: string, max = 160): string {
	const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Queued/steering/tool-label display: cap at 80 chars, ellipsis when truncated. */
export function shorten(text: string): string {
	return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** One-line preview of a tool RESULT — the `⎿` summary and the fold title
 *  share it. bash results lead with `stdout:`/`stderr:` section headers
 *  (bash.ts's formatOutput contract); skipping them shows the first output
 *  line, which is what a reader actually wants (dogfood 2026-09-09:
 *  `⎿ stdout: (+22 lines)` carried no information). Other tools preview
 *  their first line as before. */
export function summarizeResult(name: string, content: string): string {
	const lines = content.split("\n");
	// A trailing newline is a terminator, not a blank line — count it out so
	// the (+N) never advertises a phantom line (review P2; the fold body
	// applies the same rule).
	if (lines[lines.length - 1] === "") lines.pop();
	let start = 0;
	if (name === "bash") {
		while (start < lines.length) {
			const line = lines[start] ?? "";
			if (line === "stdout:" || line === "stderr:" || line.trim() === "") start++;
			else break;
		}
	}
	// firstLine finds the first NON-EMPTY line of the remainder — the
	// historical ⎿ semantics for non-bash results (review P1: a file whose
	// first line is blank must preview its first content line, not
	// "(no output)").
	let headIdx = start;
	while (headIdx < lines.length && (lines[headIdx] ?? "").trim() === "") headIdx++;
	const head = firstLine(lines.slice(headIdx).join("\n"), 80);
	if (head === "") return "(no output)";
	// (+N) counts CONTENT lines only (debt clearance): a physical count let
	// blank separators and the status-y "Exit code: N" line inflate it.
	const more = lines.filter((line, i) => {
		if (i <= headIdx) return false;
		if (line.trim() === "") return false;
		return !/^Exit code: \d+$/.test(line.trim());
	}).length;
	return more > 0 ? `${head} (+${more} lines)` : head;
}

/** Human-readable one-line summary of a tool call's arguments.
 *  One funnel for every surface — print tool lines, TUI transcript lines,
 *  replay, and the activity region — so the label reads the same everywhere.
 *  Built-ins get a friendly form; anything else (extension tools) keeps the
 *  compact JSON, which is honest for schemas we do not know. */
export function summarizeArgs(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const str = (k: string): string | undefined => {
		const v = a[k];
		return typeof v === "string" && v !== "" ? v : undefined;
	};
	const raw = JSON.stringify(args) ?? "";
	// The 120-char cap applies to every branch (review P2: built-in fallbacks
	// skipped it and could emit unbounded labels on malformed args).
	const fallback = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
	switch (name) {
		case "bash": {
			const cmd = (args as { command?: string })?.command;
			return cmd !== undefined ? `$ ${cmd}` : JSON.stringify(args);
		}
		case "read": {
			const path = str("path");
			if (path === undefined) return fallback;
			let label = path;
			if (typeof a.offset === "number") label += ` · from line ${a.offset}`;
			if (typeof a.limit === "number") label += ` · limit ${a.limit}`;
			return label;
		}
		case "write":
		case "edit":
			return str("path") ?? fallback;
		case "grep": {
			const pattern = str("pattern");
			if (pattern === undefined) return fallback;
			let label = `"${pattern}"`;
			const scope = str("path");
			if (scope !== undefined) label += ` in ${scope}`;
			const glob = str("glob");
			if (glob !== undefined) label += ` (${glob})`;
			return label;
		}
		case "find": {
			const pattern = str("pattern");
			if (pattern === undefined) return fallback;
			let label = pattern;
			const scope = str("path");
			if (scope !== undefined) label += ` in ${scope}`;
			if (a.type === "file" || a.type === "directory") label += ` · ${a.type}s`;
			return label;
		}
		case "task": {
			const prompt = str("prompt");
			if (prompt === undefined) return fallback;
			const agent = str("agent");
			return agent !== undefined ? `(${agent}) ${shorten(prompt)}` : shorten(prompt);
		}
		default:
			return fallback;
	}
}

/** 1234 -> "1.2k"; 567 -> "567". */
export function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export function green(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[32m${text}\x1b[0m` : text;
}

export function bold(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[1m${text}\x1b[0m` : text;
}

/**
 * Lightweight markdown rendering for streamed assistant text — the subset
 * models actually emit (bold, headers, bullets, fenced code, rules).
 * Append-only: no width math, so CJK text is safe. Plain lines pass through
 * untouched; ansi=false is the identity transform for pipes.
 */
// Fast path (Claude-Code-style): if no markdown marker appears in the first
// 500 chars, the whole chunk is plain text — skip the line loop entirely.
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

export function renderMarkdownLite(text: string, ansi = process.stdout.isTTY === true): string {
	if (!ansi || !MD_SYNTAX_RE.test(text.length > 500 ? text.slice(0, 500) : text)) return text;
	const out: string[] = [];
	let inFence = false;
	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			out.push(dim(line.trimStart(), ansi));
			continue;
		}
		if (inFence) {
			out.push(`  ${line}`);
			continue;
		}
		if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
			out.push(dim("─".repeat(24), ansi));
			continue;
		}
		const header = /^(#{1,4})\s+(.*)$/.exec(line);
		if (header) {
			out.push(bold(header[2] ?? "", ansi));
			continue;
		}
		const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
		if (bullet) {
			out.push(
				`${bullet[1] ?? ""}  • ${(bullet[2] ?? "").replace(/\*\*(.+?)\*\*/g, (_m, inner) => bold(inner, ansi))}`,
			);
			continue;
		}
		out.push(line.replace(/\*\*(.+?)\*\*/g, (_m, inner) => bold(inner, ansi)));
	}
	return out.join("\n");
}
