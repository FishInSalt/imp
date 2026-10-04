/**
 * Shared output helpers — plain string formatting plus minimal ANSI wrappers.
 * Extracted from cli.ts so the runner, the REPL, and print mode format
 * identically.
 */

export const VERSION = "0.2.0";

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
/** Compact token counts (pi's footer algorithm): 999 → "999", 1_500 → "1.5k",
 * 12_000 → "12k", 1_050_000 → "1.1M". One decimal below 10k/10M so small
 * sessions keep resolution; rounded above to keep the footer short. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** #tui-tool-elapsed: a completed tool call's wall time. Tenths are floored
 *  below a minute so the value never rounds up across the boundary
 *  (59_999 → "59.9s", not "60.0s"); the minute idiom matches the legacy
 *  spinner's formatElapsed. The renderer gates the ≥1s time display
 *  (Amendment 2: sub-second calls show the bare ✓ instead). */
export function formatToolElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function green(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[32m${text}\x1b[0m` : text;
}

/** #confirm-prompt (A2.3): the host's single accent for the provenance name —
 *  who is asking (the section rule's label). Same shape as the other wrappers. */
export function yellow(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[33m${text}\x1b[0m` : text;
}

export function bold(text: string, ansi = process.stdout.isTTY === true): string {
	return ansi ? `\x1b[1m${text}\x1b[0m` : text;
}

/** Alert colors for gated-content highlights in the confirm picker.
 * Full-reset-based: SGR 22 (undim) also cancels bold on most terminals, so
 * a span ends by REBUILDING the dim environment (\x1b[0m\x1b[2m) rather than
 * partially resetting into it. ansi=false is the identity transform. */
export const WARN_START = "\x1b[0m\x1b[1;31m";
export const WARN_END = "\x1b[0m\x1b[2m";

/** Apply alert coloring to plain [start, end) ranges of `text`. Ranges are
 * clipped to bounds, sorted, and merged — a defensive host never trusts
 * extension math. Non-ANSI output passes text through untouched.
 * `restoreDim` picks the span's closing sequence: true (default) ends with
 * WARN_END, restoring the dim environment (a span inside a dim block);
 * false ends with a plain reset, for text rendered at normal weight. */
export function applyWarnSpans(
	text: string,
	spans: ReadonlyArray<readonly [number, number]>,
	ansi: boolean,
	restoreDim = true,
): string {
	if (!ansi || spans.length === 0) return text;
	const sorted = [...spans]
		.map(([s, e]) => [Math.max(0, s), Math.min(text.length, e)] as const)
		.filter(([s, e]) => s < e)
		.sort((a, b) => a[0] - b[0]);
	// Merge FIRST, emit after: an overlapping later span must extend the
	// earlier one's coverage, not be dropped once its text is already out.
	const merged: Array<[number, number]> = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	let out = "";
	let at = 0;
	// #confirm-prompt (Phase 3 D12): WARN_END restores the dim environment, so
	// the default suits a span inside a dim block. A caller rendering the detail
	// at normal weight passes restoreDim=false to close with a plain reset.
	const end = restoreDim ? WARN_END : "\x1b[0m";
	for (const [start, endIdx] of merged) {
		out += text.slice(at, start) + WARN_START + text.slice(start, endIdx) + end;
		at = endIdx;
	}
	return out + text.slice(at);
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

/** SA-05 (#sa-05-usage-totals): the money segment for the footer and the
 *  session lines. `$0.123` = complete; `~$0.123` = partial pricing (counted
 *  tokens without a known rate); `…!` = known-missing usage; `$?` / `$?!` =
 *  nothing could be priced. Rates are the current catalog's — an estimate,
 *  not an invoice. null = nothing to show. See docs/sa-05-usage-totals-design.md §4.5. */
export function usageMoneySegment(args: {
	usd: number;
	subscription: boolean;
	/** Counted tokens without a resolvable rate (presence = tokens > 0). */
	unpricedTokens: number;
	/** Any known-missing usage in the aggregate. */
	incomplete: boolean;
}): string | null {
	const known = args.usd > 0 || args.subscription;
	const hasUnpriced = args.unpricedTokens > 0;
	if (!known && !hasUnpriced && !args.incomplete) return null;
	if (!known) return args.incomplete ? "$?!" : "$?";
	return `${hasUnpriced ? "~" : ""}$${args.usd.toFixed(3)}${args.subscription ? " (sub)" : ""}${args.incomplete ? "!" : ""}`;
}
