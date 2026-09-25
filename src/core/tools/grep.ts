import { spawn } from "node:child_process";
import { Type } from "typebox";
import { detectBinary } from "./bin-detect.js";
import { decodePrefix, logicalLines, renderedHead, wholeLinePrefix } from "./output-text.js";
import type { Tool } from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_BYTES = 50 * 1024;
/** Stop collecting output past this and kill the child (broad patterns on big trees). */
const BUFFER_GUARD_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex, or literal with literal: true)" }),
	path: Type.Optional(
		Type.String({ description: "File or directory to search (default: current directory)" }),
	),
	glob: Type.Optional(Type.String({ description: "Filter files by glob, e.g. '*.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive match (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as a literal string, not regex (default: false)" }),
	),
	context: Type.Optional(Type.Number({ description: "Lines of context around each match (default: 0)" })),
	limit: Type.Optional(Type.Number({ description: `Max output lines (default: ${DEFAULT_LIMIT})` })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
});

export interface GrepToolOptions {
	cwd?: string;
}

/** Search is head-truncated (matches up front are the useful part), unlike bash's tail. */
export function createGrepTool(options: GrepToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "grep",
		promptSnippet: "find where code is defined or used (respects .gitignore) — prefer over bash grep.",
		description:
			"Search file contents for a pattern (backed by ripgrep; respects .gitignore, skips binary files). " +
			"Returns matching lines as 'path:line:text'. Use glob to narrow by file type. " +
			`Output is truncated to the first ${DEFAULT_LIMIT} lines / 50KB — refine the pattern instead of raising the limit. ` +
			"This is the right tool for 'where is X defined/used'; prefer it over bash grep.",
		parameters: grepSchema,
		async execute(args, signal) {
			const available = await detectBinary("rg");
			if (signal.aborted) return { output: "Error: search aborted by user.", isError: true };
			if (!available) {
				return {
					output:
						"Error: ripgrep (rg) is not installed. Install it first: brew install ripgrep (or apt install ripgrep).",
					isError: true,
				};
			}

			const pattern = String(args.pattern ?? "");
			if (pattern === "") return { output: "Error: empty pattern", isError: true };
			const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, 1000);
			const context = clampInt(args.context, 0, 0, 10);
			const timeoutMs = clampInt(args.timeout, DEFAULT_TIMEOUT_MS / 1000, 1, 600) * 1000;

			const argv = ["--color", "never", "--no-heading", "--line-number"];
			if (args.ignoreCase === true) argv.push("--ignore-case");
			if (args.literal === true) argv.push("--fixed-strings");
			if (typeof args.glob === "string" && args.glob !== "") argv.push("--glob", args.glob);
			if (context > 0) argv.push("--context", String(context));
			argv.push("--", pattern, typeof args.path === "string" && args.path !== "" ? args.path : ".");

			return runSearch("rg", argv, cwd, { limit, context, timeoutMs, label: pattern, signal });
		},
	};
}

/**
 * Shared runner for rg/fd-style search commands: collect lines with a buffer
 * guard, kill on timeout/abort, head-truncate with a teaching note.
 * Only rg uses exit code 1 for no matches.
 */
export async function runSearch(
	bin: string,
	argv: string[],
	cwd: string,
	options: {
		limit: number;
		context: number;
		timeoutMs: number;
		label: string;
		signal: AbortSignal;
	},
): Promise<{ output: string; isError?: boolean }> {
	const { limit, timeoutMs, label, signal } = options;

	if (signal.aborted) return { output: "Error: search aborted by user.", isError: true };
	return new Promise((resolve) => {
		const child = spawn(bin, argv, { cwd });
		const stdout = Buffer.alloc(BUFFER_GUARD_BYTES);
		const stderr = Buffer.alloc(2000);
		let used = 0,
			errUsed = 0,
			observed = 0,
			errObserved = 0;
		let timedOut = false,
			aborted = false,
			settled = false,
			stopping = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (stopping || settled) return;
			stopping = true;
			child.kill("SIGTERM");
			escalation = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
			escalation.unref();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutMs);
		const onAbort = () => {
			aborted = true;
			stop();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const finish = (result: { output: string; isError?: boolean }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(escalation);
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			if (settled) return;
			observed += chunk.length;
			used += chunk.copy(stdout, used, 0, Math.min(chunk.length, stdout.length - used));
			if (observed > BUFFER_GUARD_BYTES) stop();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (settled) return;
			errObserved += chunk.length;
			errUsed += chunk.copy(stderr, errUsed, 0, Math.min(chunk.length, stderr.length - errUsed));
		});
		child.on("error", (err) =>
			finish({ output: `Error: failed to run ${bin}: ${err.message}`, isError: true }),
		);
		child.on("close", (code, closeSignal) => {
			if (settled) return;
			let diagnostic = renderedHead(decodePrefix(stderr.subarray(0, errUsed), errObserved > errUsed), 2000);
			if (errObserved > errUsed || Buffer.byteLength(stderr.subarray(0, errUsed).toString("utf8")) > 2000) {
				diagnostic += "\n[stderr truncated: showing first 2000 bytes or fewer.]";
			}
			const fail = (header: string) =>
				finish({ output: header + (diagnostic !== "" ? `\nstderr:\n${diagnostic}` : ""), isError: true });
			const capped = observed > used;
			if (aborted) return fail("Error: search aborted by user.");
			if (timedOut)
				return fail(
					`Error: search timed out after ${timeoutMs / 1000}s. Narrow it: set path to a subdirectory, add a glob, or a more specific pattern.`,
				);
			if (!capped) {
				if (closeSignal) return fail(`Error: ${bin} terminated by signal ${closeSignal}.`);
				if (code === null) return fail(`Error: ${bin} ended without an exit status.`);
				if (code !== 0 && !(bin === "rg" && code === 1))
					return fail(`Error: ${bin} exited with code ${code}:`);
			}
			let text = decodePrefix(stdout.subarray(0, used), capped);
			if (capped) text = text.slice(0, text.lastIndexOf("\n") + 1);
			const lines = logicalLines(text);
			const preview = wholeLinePrefix(lines, limit, MAX_BYTES);
			text = preview.text;
			if (capped || preview.count < lines.length) {
				let reason = capped
					? `showing first ${preview.count} lines; at least ${lines.length} complete lines observed; total unknown; 1048576-byte collection limit`
					: `showing first ${preview.count} of ${lines.length} lines`;
				if (preview.byteLimited) reason += ", 50KB limit";
				text += `\n\n[Truncated: ${reason}. Narrow the search (subdirectory path, glob, or more specific pattern) instead of raising the limit.]`;
			} else if (observed === 0) text = `No matches for ${label}`;
			if (diagnostic !== "") text += `\n\nstderr:\n${diagnostic}`;
			finish({ output: text });
		});
	});
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(max, Math.max(min, n));
}
