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

/** One-line tool argument summary: bash renders `$ <command>`, others compact JSON. */
export function summarizeArgs(name: string, args: unknown): string {
	if (name === "bash") {
		const cmd = (args as { command?: string })?.command;
		return cmd !== undefined ? `$ ${cmd}` : JSON.stringify(args);
	}
	const json = JSON.stringify(args) ?? "";
	return json.length > 120 ? `${json.slice(0, 120)}…` : json;
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
			out.push(`${bullet[1] ?? ""}  • ${(bullet[2] ?? "").replace(/\*\*(.+?)\*\*/g, (_m, inner) => bold(inner, ansi))}`);
			continue;
		}
		out.push(line.replace(/\*\*(.+?)\*\*/g, (_m, inner) => bold(inner, ansi)));
	}
	return out.join("\n");
}
