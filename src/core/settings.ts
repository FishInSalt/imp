/**
 * imp's global settings file (#thinking-levels): ~/.imp/settings.json.
 *
 * pi parity: pi's SettingsManager persists the thinking level chosen in a
 * session as the cross-session default (agent-session.ts setThinkingLevel →
 * setDefaultThinkingLevel) and the ctrl+t thinking-visibility toggle
 * (setHideThinkingBlock). imp's settings stay deliberately minimal — these
 * two keys — with an injectable path so tests never touch the real home.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "../provider/thinking.js";

export interface ImpSettings {
	defaultThinkingLevel?: ThinkingLevel;
	hideThinkingBlock?: boolean;
}

/** The settings file path (IMP_SETTINGS_PATH overrides — hermetic tests). */
export function settingsFilePath(override?: string): string {
	return override ?? process.env.IMP_SETTINGS_PATH ?? join(homedir(), ".imp", "settings.json");
}

/** Read the settings; a missing or malformed file reads as empty (pi's
 *  settings load is equally forgiving — corrupt files never block startup). */
export function loadSettings(path?: string): ImpSettings {
	const file = settingsFilePath(path);
	try {
		const raw = readFileSync(file, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: ImpSettings = {};
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.defaultThinkingLevel === "string") {
			out.defaultThinkingLevel = obj.defaultThinkingLevel as ThinkingLevel;
		}
		if (typeof obj.hideThinkingBlock === "boolean") out.hideThinkingBlock = obj.hideThinkingBlock;
		return out;
	} catch {
		return {}; // missing, unreadable, or malformed JSON
	}
}

/** Read-modify-write one key. Best-effort: a settings write failure must
 *  never take the session down (pi logs and continues; imp matches). */
export function saveSettings(patch: Partial<ImpSettings>, path?: string): void {
	const file = settingsFilePath(path);
	try {
		const current = existsSync(file) ? loadSettings(file) : {};
		const merged = { ...current, ...patch };
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(merged, null, "\t")}\n`, "utf-8");
	} catch {
		// unreadable dir / full disk: the session keeps running without the
		// cross-session default; the in-memory level is unaffected
	}
}
