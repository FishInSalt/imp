import { spawn } from "node:child_process";
import { Type } from "typebox";
import { detectBinary } from "./bin-detect.js";
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
		description:
			"Search file contents for a pattern (backed by ripgrep; respects .gitignore, skips binary files). " +
			"Returns matching lines as 'path:line:text'. Use glob to narrow by file type. " +
			`Output is truncated to the first ${DEFAULT_LIMIT} lines / 50KB — refine the pattern instead of raising the limit. ` +
			"This is the right tool for 'where is X defined/used'; prefer it over bash grep.",
		parameters: grepSchema,
		async execute(args, signal) {
			if (!(await detectBinary("rg"))) {
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
 * Exit code 1 means "no matches" for both rg and fd — not an error.
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

	return new Promise((resolve) => {
		const child = spawn(bin, argv, { cwd });
		let lines: string[] = [];
		let totalBytes = 0;
		let bufferCapped = false;
		let timedOut = false;
		let aborted = false;
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
		}, timeoutMs);

		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
		};
		signal.addEventListener("abort", onAbort, { once: true });

		const finish = (result: { output: string; isError?: boolean }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const readline = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			totalBytes += text.length;
			if (totalBytes <= BUFFER_GUARD_BYTES) {
				for (const line of text.split("\n")) if (line !== "") lines.push(line);
			} else if (!bufferCapped) {
				bufferCapped = true;
				child.kill("SIGTERM"); // we have more than enough
				setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
			}
		};
		child.stdout.on("data", readline);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8").slice(0, 2000);
		});
		child.on("error", (err) => {
			finish({ output: `Error: failed to run ${bin}: ${err.message}`, isError: true });
		});
		child.on("close", (code) => {
			if (aborted) {
				finish({ output: `Error: search aborted by user.`, isError: true });
				return;
			}
			if (timedOut) {
				finish({
					output: `Error: search timed out after ${timeoutMs / 1000}s. Narrow it: set path to a subdirectory, add a glob, or a more specific pattern.`,
					isError: true,
				});
				return;
			}
			if (code !== null && code >= 2) {
				finish({ output: `Error: ${bin} exited with code ${code}: ${stderr.trim()}`, isError: true });
				return;
			}

			if (lines.length === 0) {
				finish({ output: `No matches for ${label}` });
				return;
			}

			const totalLines = lines.length + (bufferCapped ? 1 : 0); // capped ⇒ there was more
			const truncatedByLines = totalLines > limit;
			if (truncatedByLines) lines = lines.slice(0, limit);
			let text = lines.join("\n");
			let truncatedByBytes = false;
			if (Buffer.byteLength(text) > MAX_BYTES) {
				text = Buffer.from(text).subarray(0, MAX_BYTES).toString("utf8");
				truncatedByBytes = true;
			}
			if (truncatedByLines || truncatedByBytes || bufferCapped) {
				const reasons = [
					truncatedByLines
						? `showing first ${lines.length} of ${bufferCapped ? `${totalLines}+` : totalLines} lines`
						: null,
					truncatedByBytes ? "50KB limit" : null,
				].filter(Boolean);
				text += `\n\n[Truncated: ${reasons.join(", ")}. Narrow the search (subdirectory path, glob, or more specific pattern) instead of raising the limit.]`;
			}
			finish({ output: text });
		});
	});
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(max, Math.max(min, n));
}
