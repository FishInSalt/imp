import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTEXT_FILE_NAMES = ["AGENTS.md"] as const;

/**
 * Discover context files (AGENTS.md), pi-style:
 *
 *   1. ~/.imp/AGENTS.md                      (global, first)
 *   2. every ancestor of cwd, root → cwd     (far to near; nearest wins visually)
 *
 * All matching files are concatenated into the system prompt. Missing files
 * are skipped silently.
 */
export function findContextFiles(cwd: string, home: string = os.homedir()): string[] {
	const files: string[] = [];

	const global = path.join(home, ".imp", "AGENTS.md");
	if (existsSync(global)) files.push(global);

	const ancestors: string[] = [];
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		ancestors.push(dir);
		if (dir === path.dirname(dir)) break;
	}
	// Root → cwd order so nearer files come later (more specific overrides visually).
	for (const dir of ancestors.reverse()) {
		for (const name of CONTEXT_FILE_NAMES) {
			const file = path.join(dir, name);
			if (existsSync(file)) files.push(file);
		}
	}

	return files;
}

export interface LoadedContext {
	files: string[];
	/** Concatenated context with per-file headers, ready to append to the system prompt. */
	text: string;
}

export function loadContextFiles(cwd: string, home: string = os.homedir()): LoadedContext | null {
	const files = findContextFiles(cwd, home);
	if (files.length === 0) return null;

	const sections = files.map((file) => {
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			return ""; // unreadable — skip
		}
		const trimmed = content.trim();
		if (trimmed === "") return "";
		const display = path.relative(cwd, file) || path.basename(file);
		return `## ${display}\n\n${trimmed}`;
	});
	const text = sections.filter((s) => s !== "").join("\n\n");
	if (text === "") return null;
	return { files, text };
}
