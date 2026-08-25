import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
	applyEdits,
	detectLineEnding,
	diffLines,
	type Edit,
	replaceLineEndings,
	stripBom,
} from "./edit-diff.js";
import { withFileLock } from "./file-lock.js";
import type { Tool } from "./types.js";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text to replace. Must match the original file exactly (whitespace and line breaks included) and be unique.",
	}),
	newText: Type.String({ description: "Replacement text." }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements, all matched against the ORIGINAL file (not incrementally). " +
			"Each oldText must be unique and must not overlap another edit; merge nearby changes into one edit instead.",
	}),
});

export interface EditToolOptions {
	cwd?: string;
}

export function createEditTool(options: EditToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "edit",
		description:
			"Edit a file with exact text replacement. Each edits[].oldText must match a unique, non-overlapping " +
			"region of the original file — include enough surrounding lines to make it unique. Read the file first and " +
			"copy text exactly (indentation matters). All edits apply atomically: if any oldText is not found or " +
			"matches more than once, nothing is written and the error tells you how to fix it. " +
			"Prefer several small precise edits over one huge replacement.",
		parameters: editSchema,
		async execute(args, signal) {
			const requested = String(args.path ?? "");
			const edits = (args.edits ?? []) as Edit[];
			if (edits.length === 0) {
				return { output: "Error: edits must contain at least one replacement.", isError: true };
			}
			const absolute = path.resolve(cwd, requested);

			return withFileLock(absolute, async () => {
				if (signal.aborted) return { output: "Error: aborted before edit", isError: true };

				let raw: string;
				try {
					raw = await readFile(absolute, "utf8");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { output: `Error reading ${requested}: ${message}`, isError: true };
				}

				const { bom, text } = stripBom(raw);
				const ending = detectLineEnding(text);
				const original = replaceLineEndings(text, "\n");
				const normalizedEdits = edits.map((e) => ({
					oldText: replaceLineEndings(e.oldText, "\n"),
					newText: replaceLineEndings(e.newText, "\n"),
				}));

				const result = applyEdits(original, normalizedEdits);
				if (!result.ok) {
					return { output: `Error: ${result.error}`, isError: true };
				}

				if (signal.aborted) return { output: "Error: aborted before write", isError: true };

				const finalContent = bom + replaceLineEndings(result.content, ending);
				try {
					await writeFile(absolute, finalContent, "utf8");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { output: `Error writing ${requested}: ${message}`, isError: true };
				}

				// First line is a summary (the CLI shows it collapsed); the diff follows.
				const sections = result.applied.map(
					(e) => `@@ line ${e.line} @@\n${diffLines(e.oldText, e.newText)}`,
				);
				return {
					output: `Edited ${requested} (${result.applied.length} edit${result.applied.length > 1 ? "s" : ""} applied):\n${sections.join("\n")}`,
				};
			});
		},
	};
}
