import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "./types.js";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024; // 50KB

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export interface ReadToolOptions {
	cwd?: string;
}

export function createReadTool(options: ReadToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "read",
		description:
			`Read the contents of a text file. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB ` +
			`(whichever hits first); the truncation note tells you how to continue reading. Use offset/limit for large files.`,
		parameters: readSchema,
		async execute(args, signal) {
			const requested = String(args.path ?? "");
			if (requested.trim() === "") {
				return { output: "Error: no path given", isError: true };
			}
			const absolute = path.resolve(cwd, requested);

			let bytes: Buffer;
			try {
				bytes = await readFile(absolute, { signal });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { output: `Error reading ${requested}: ${message}`, isError: true };
			}

			// Cheap binary detection: NUL byte in the first 8KB.
			const probe = bytes.subarray(0, 8192);
			if (probe.includes(0)) {
				return {
					output: `Error: ${requested} looks like a binary file; the read tool only supports text.`,
					isError: true,
				};
			}

			const allLines = new TextDecoder().decode(bytes).split("\n");
			const totalFileLines = allLines.length;

			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && (!Number.isFinite(offset) || offset < 1)) {
				return { output: `Error: offset must be a 1-indexed line number, got ${offset}`, isError: true };
			}
			if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
				return { output: `Error: limit must be a positive number of lines, got ${limit}`, isError: true };
			}

			const startIdx = offset !== undefined ? offset - 1 : 0;
			if (startIdx >= allLines.length) {
				return {
					output: `Error: offset ${offset} is beyond the end of the file (${totalFileLines} lines total)`,
					isError: true,
				};
			}

			const startDisplay = startIdx + 1;
			const endIdx = limit !== undefined ? Math.min(startIdx + limit, allLines.length) : allLines.length;

			// Apply hard truncation, then explain exactly how to continue.
			let lines = allLines.slice(startIdx, endIdx);
			if (lines.length > MAX_LINES) {
				lines = lines.slice(0, MAX_LINES);
			}
			let selected = lines.join("\n");
			let truncatedByBytes = false;
			if (Buffer.byteLength(selected) > MAX_BYTES) {
				selected = Buffer.from(selected).subarray(0, MAX_BYTES).toString("utf8");
			truncatedByBytes = true;
		}

			const shownLines = selected.split("\n").length;
			const endDisplay = startDisplay + shownLines - 1;
			const notes: string[] = [];
			if (shownLines < endIdx - startIdx) {
				notes.push(
					truncatedByBytes
						? `[Showing lines ${startDisplay}-${endDisplay} of ${totalFileLines} (${MAX_BYTES / 1024}KB limit). Use offset=${endDisplay + 1} to continue.]`
						: `[Showing lines ${startDisplay}-${endDisplay} of ${totalFileLines} (${MAX_LINES} line limit). Use offset=${endDisplay + 1} to continue.]`,
				);
			} else if (endIdx < allLines.length) {
				const remaining = allLines.length - endIdx;
				notes.push(`[${remaining} more lines in file. Use offset=${endIdx + 1} to continue.]`);
			}

			const output = notes.length > 0 ? `${selected}\n\n${notes.join("\n")}` : selected;
			return { output, isError: false };
		},
	};
}
