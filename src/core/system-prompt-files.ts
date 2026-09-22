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
	/** An existing project-tier file was skipped because the directory is
	 *  untrusted. `supersededByGlobal` marks the one surprising case worth a
	 *  note: a global-tier file took over the pair the user probably meant
	 *  (D6 — otherwise the startup trust line already told the story). */
	ignoredUntrusted?: { supersededByGlobal: boolean };
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
	let ignored = false;
	let superseded = false;
	const resolvePair = (name: string): { text: string; path: string } | undefined => {
		const projectPath = path.join(cwd, ".imp", name);
		if (projectAllowed) {
			const tier = readTier(projectPath);
			if (tier !== "absent" && tier !== "unreadable" && tier !== "slot-taken") return tier;
			if (tier === "slot-taken") return undefined;
			// absent or unreadable → try the global tier (D5 fall-through)
		} else if (isFile(projectPath)) {
			ignored = true; // gate before peek — untrusted content is never read
		}
		const globalTier = readTier(path.join(home, ".imp", name));
		if (globalTier !== "absent" && globalTier !== "unreadable" && globalTier !== "slot-taken") {
			if (ignored) superseded = true;
			return globalTier;
		}
		return undefined;
	};
	const result: SystemPromptOverride = {};
	const override = resolvePair("SYSTEM.md");
	if (override) result.override = override;
	const append = resolvePair("APPEND_SYSTEM.md");
	if (append) result.append = append;
	if (ignored) result.ignoredUntrusted = { supersededByGlobal: superseded };
	return result;
}
