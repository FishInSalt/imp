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
	/** M12 skills: extra skill files/directories, settings tier (a bare string
	 *  is coerced to a one-element array; non-string entries are dropped
	 *  silently at parse time — design §9: settings loading is deliberately
	 *  forgiving, the teaching line would be a layer mismatch). */
	skills?: string[];
	/** /skill:name command registration (default true; M12 batch 2 consumes it). */
	enableSkillCommands?: boolean;
	/** M13 batch 2: image pipeline switches. `autoResize` (default true)
	 *  resizes read/attached images through the photon ladder (2000×2000 /
	 *  4.5 MB encoded); false keeps conversion but ships original bytes —
	 *  oversize files then hit the batch-1 teaching error again. */
	images?: { autoResize?: boolean };
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
		if (typeof obj.skills === "string") out.skills = [obj.skills];
		else if (Array.isArray(obj.skills)) {
			out.skills = obj.skills.filter((entry): entry is string => typeof entry === "string");
		}
		if (typeof obj.enableSkillCommands === "boolean") out.enableSkillCommands = obj.enableSkillCommands;
		if (obj.images !== null && typeof obj.images === "object" && !Array.isArray(obj.images)) {
			const images = obj.images as Record<string, unknown>;
			const outImages: { autoResize?: boolean } = {};
			if (typeof images.autoResize === "boolean") outImages.autoResize = images.autoResize;
			if (Object.keys(outImages).length > 0) out.images = outImages;
		}
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
