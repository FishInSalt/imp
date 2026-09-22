import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * #system-md: SYSTEM.md / APPEND_SYSTEM.md discovery (docs/system-md-design.md).
 *
 * Two files, two tiers each — project `<cwd>/.imp/<name>` (behind the
 * session-resolved trust bit, see D2) and global `~/.imp/<name>`. One file
 * per pair: the project tier wins, the tiers are never merged (pi parity).
 *
 * Deviations from pi (design §2 D5-D7): a read failure falls through to the
 * next tier instead of pi's path-string-becomes-the-prompt; a readable-but-
 * empty file OCCUPIES the pair (default prompt, no global fallback) — the
 * typo case must not silently hand the persona to the global file; an
 * untrusted project file is never read (gate before peek).
 */
export interface SystemPromptOverride {
	/** SYSTEM.md — replaces the default prompt body (identity, environment,
	 *  core rules, tool catalog). The runner's append phases (context XML,
	 *  skills, agents block) still run; the cwd line survives (D3/D4). */
	override?: { text: string; path: string };
	/** APPEND_SYSTEM.md — appended after the body in both modes. */
	append?: { text: string; path: string };
	/** Project-tier files skipped because the directory is untrusted
	 *  (gate before peek — content never read). */
	ignoredUntrusted: string[];
	/** The surprising subset (D6): pairs where a GLOBAL-tier file took over
	 *  an ignored project file — worth one note each, naming the actual
	 *  file (impl review: shared flags + a hardcoded name misreported
	 *  mixed SYSTEM/APPEND cases). */
	supersededByGlobal: string[];
	/** Trusted project files that exist but could not be read (D5's warn
	 *  half — the pair fell through to the global tier or the default
	 *  prompt; the user's file silently not applying needs a signal). */
	unreadableProject: string[];
}

type Tier =
	| { text: string; path: string }
	| "absent"
	| "unreadable"
	| /** Readable but empty after BOM strip + trim (D7). */ "slot-taken";

function isFile(file: string): boolean {
	try {
		return existsSync(file) && statSync(file).isFile();
	} catch {
		return false;
	}
}

function readTier(file: string): Tier {
	if (!isFile(file)) return "absent";
	try {
		const text = readFileSync(file, "utf8")
			.replace(/^\uFEFF/, "")
			.trim();
		if (text === "") return "slot-taken";
		return { text, path: file };
	} catch {
		return "unreadable";
	}
}

export function loadSystemPromptFiles(
	cwd: string,
	projectAllowed: boolean,
	home: string = os.homedir(),
): SystemPromptOverride {
	const result: SystemPromptOverride = {
		ignoredUntrusted: [],
		supersededByGlobal: [],
		unreadableProject: [],
	};
	const resolvePair = (name: string): { text: string; path: string } | undefined => {
		const projectPath = path.join(cwd, ".imp", name);
		let projectIgnored = false;
		if (projectAllowed) {
			const tier = readTier(projectPath);
			if (tier !== "absent" && tier !== "unreadable" && tier !== "slot-taken") return tier;
			if (tier === "slot-taken") return undefined;
			if (tier === "unreadable") result.unreadableProject.push(projectPath);
			// absent or unreadable → try the global tier (D5 fall-through)
		} else if (isFile(projectPath)) {
			result.ignoredUntrusted.push(projectPath); // gate before peek
			projectIgnored = true;
		}
		const globalTier = readTier(path.join(home, ".imp", name));
		if (globalTier !== "absent" && globalTier !== "unreadable" && globalTier !== "slot-taken") {
			if (projectIgnored) result.supersededByGlobal.push(projectPath);
			return globalTier;
		}
		return undefined;
	};
	const override = resolvePair("SYSTEM.md");
	if (override) result.override = override;
	const append = resolvePair("APPEND_SYSTEM.md");
	if (append) result.append = append;
	return result;
}
