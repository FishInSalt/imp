import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Per-directory candidate priority (prompt-audit P4, pi resource-loader
 *  parity): override beats the agent-native names, agent-native beats the
 *  Claude-compat names. Uppercase .MD variants ride along for
 *  case-insensitive filesystems (Windows checkouts). The GLOBAL file below
 *  deliberately stays AGENTS.md-only — loading ~/.imp/CLAUDE.md too would be
 *  a behavior change this batch does not make (design review P3-3). */
const CONTEXT_FILE_NAMES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
] as const;

/**
 * Discover context files, pi-style:
 *
 *   1. ~/.imp/AGENTS.md                      (global, first)
 *   2. every ancestor of cwd, root → cwd     (far to near; nearest wins visually)
 *
 * Each directory contributes AT MOST ONE file — the first candidate that
 * exists wins (AGENTS.md shadows CLAUDE.md in the same directory). Missing
 * files are skipped silently.
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
			if (existsSync(file)) {
				files.push(file);
				break; // first match per directory (prompt-audit P4)
			}
		}
	}

	return files;
}

export interface LoadedContext {
	files: string[];
	/** Per-file sections; the CALLER wraps them (prompt-audit P4: XML, not
	 *  markdown headers — file content must not be able to forge prompt
	 *  structure). Order matches `files`. */
	sections: Array<{ path: string; content: string }>;
}

export function loadContextFiles(cwd: string, home: string = os.homedir()): LoadedContext | null {
	const files = findContextFiles(cwd, home);
	if (files.length === 0) return null;

	const sections: Array<{ path: string; content: string }> = [];
	for (const file of files) {
		// Read-failure fall-through (design review P3-4, pi parity): an
		// unreadable AGENTS.md must not shadow a readable CLAUDE.md — walk the
		// remaining candidates of the same directory before giving up on it.
		const candidates = [file, ...fallbackCandidates(file)];
		for (const candidate of candidates) {
			let content: string;
			try {
				content = readFileSync(candidate, "utf8");
			} catch {
				continue; // unreadable — try the next candidate in this directory
			}
			const trimmed = content.trim();
			if (trimmed === "") break; // readable but empty — the slot is taken
			sections.push({ path: candidate, content: trimmed });
			break;
		}
	}
	if (sections.length === 0) return null;
	return { files: sections.map((s) => s.path), sections };
}

/** Remaining CONTEXT_FILE_NAMES in the same directory after `file`'s own
 *  candidate (read-failure fall-through, prompt-audit P4). */
function fallbackCandidates(file: string): string[] {
	const dir = path.dirname(file);
	const own = path.basename(file);
	const index = CONTEXT_FILE_NAMES.indexOf(own as (typeof CONTEXT_FILE_NAMES)[number]);
	if (index < 0) return [];
	return CONTEXT_FILE_NAMES.slice(index + 1).map((name) => path.join(dir, name));
}
