/**
 * ls tool — M16, ported from pi `coding-agent/src/core/tools/ls.ts`
 * (slimmed: no LsOperations seam — imp has no remote delegates yet).
 *
 * Answers "what is in THIS directory": entries sorted case-insensitively
 * (pi parity), dotfiles included, directories suffixed `/`. Output is
 * capped by entry count (default 500) and bytes (50KB, pi's
 * DEFAULT_MAX_BYTES) — whichever hits first — with actionable notices
 * instead of silent truncation.
 */

import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { Type } from "typebox";
import { resolveReadPath } from "./path-resolve.js";
import type { Tool } from "./types.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const MAX_BYTES = 50 * 1024;

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of entries to return (default: ${DEFAULT_LIMIT})` }),
	),
});

export interface LsToolOptions {
	cwd?: string;
}

export function createLsTool(options: LsToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "ls",
		promptSnippet: "list one directory's entries (dotfiles included).",
		description:
			`List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. ` +
			`Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${MAX_BYTES / 1024}KB ` +
			`(whichever hits first).`,
		parameters: lsSchema,
		async execute(args, signal) {
			if (signal?.aborted) return { output: "Error: aborted before start", isError: true };

			const requested = typeof args.path === "string" && args.path !== "" ? args.path : ".";
			const limitRaw = typeof args.limit === "number" ? args.limit : DEFAULT_LIMIT;
			const limit = Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LIMIT);

			const dirPath = resolveReadPath(requested, cwd);
			let names: string[];
			try {
				names = await fsReaddir(dirPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { output: `Error: cannot read ${requested}: ${message}`, isError: true };
			}

			// case-insensitive alphabetical, dotfiles included (pi parity)
			names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			const formatted: string[] = [];
			const unknown = new Set<string>();
			let entryLimitReached = false;
			for (const name of names) {
				if (signal?.aborted) return { output: "Error: aborted", isError: true };
				if (formatted.length >= limit) {
					entryLimitReached = true;
					break;
				}
				let isDir = false;
				try {
					isDir = (await fsStat(`${dirPath}/${name}`)).isDirectory();
				} catch {
					unknown.add(name);
				}
				formatted.push(isDir ? `${name}/` : name);
			}

			if (formatted.length === 0) {
				return { output: "(empty directory)" };
			}

			// Byte cap counts the joined output — the notice names the knob
			// (narrow the path), unlike the entry cap which suggests a limit.
			const notices: string[] = [];
			if (entryLimitReached) {
				notices.push(
					limit >= MAX_LIMIT
						? `${limit} entries limit reached. Narrow the path — ${limit} is the maximum`
						: `${limit} entries limit reached. Use limit=${Math.min(limit * 2, MAX_LIMIT)} for more`,
				);
			}
			let output = "";
			let bytes = 0;
			let displayedUnknown = 0;
			for (const line of formatted) {
				const size = Buffer.byteLength(`${line}\n`);
				if (bytes + size > MAX_BYTES) {
					notices.push(`${MAX_BYTES / 1024}KB limit reached`);
					break;
				}
				output += `${line}\n`;
				if (unknown.has(line)) displayedUnknown++;
				bytes += size;
			}
			if (notices.length > 0) {
				output += `\n[${notices.join(". ")}]`;
			}
			if (displayedUnknown > 0)
				output += `\n[Directory type unavailable for ${displayedUnknown} displayed entries; names shown without a directory suffix.]`;
			return { output };
		},
	};
}
