/**
 * Settings (#thinking-levels → M15 #settings-panel): two scopes with deep
 * merge, keyed to the settings imp actually consumes.
 *
 *   global  ~/.imp/settings.json
 *   project <cwd>/.imp/settings.json   (loads ONLY when the project passes
 *                                       the M8 trust gate — a cloned repo
 *                                       must not grow settings that
 *                                       redirect the model)
 *
 * Precedence everywhere: env var > project > global > code default.
 *
 * pi parity notes (docs/m15-settings-design.md): load is forgiving (a
 * corrupt or wrong-typed file never blocks startup — unknown keys are
 * PRESERVED through read-modify-write for forward compat), writes are
 * atomic (tmp+rename) but not locked (D16: single-user CLI,
 * last-writer-wins), the /settings UI is a lean selector (D17), and
 * programmatic persistence targets the global scope (D18).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "../provider/thinking.js";

export type QueueMode = "all" | "one-at-a-time";

export interface ImpSettings {
	/** Startup model when -m/IMP_MODEL is absent (M15; env still wins). */
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	hideThinkingBlock?: boolean;
	/** Auto-compaction gate (M15; IMP_AUTOCOMPACT=0 still wins). Default true. */
	autoCompact?: boolean;
	/** M12 skills: extra skill files/directories, settings tier (a bare string
	 *  is coerced to a one-element array; non-string entries are dropped
	 *  silently at parse time — design §9: settings loading is deliberately
	 *  forgiving, the teaching line would be a layer mismatch). */
	skills?: string[];
	/** /skill:name command registration (default true; M12 batch 2 consumes it). */
	enableSkillCommands?: boolean;
	/** M17 queue drain modes (pi settings keys, same literals). Defaults are a
	 *  DELIBERATE divergence from pi (docs/m17-followup-runs-design.md §2):
	 *  steering batches (timely supplementary info — one boundary delivers
	 *  the complete correction set; a one-at-a-time backlog would delay newer
	 *  messages), follow-ups run one per boundary (independent next tasks —
	 *  keeps the esc+p revision window between them). pi defaults both to
	 *  one-at-a-time. */
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	/** M13 batch 2: image pipeline switches. `autoResize` (default true)
	 *  resizes read/attached images through the photon ladder (2000×2000 /
	 *  4.5 MB encoded); false keeps conversion but ships original bytes —
	 *  oversize files then hit the batch-1 teaching error again. */
	images?: { autoResize?: boolean };
	/** M18 MCP: master gate (default true — with no mcp.json anywhere the
	 *  module is inert anyway, D4 zero-cost-without-config). false skips
	 *  discovery and connections entirely; /mcp then reports the gate. */
	mcp?: { enabled?: boolean };
}

/** The global settings file path (IMP_SETTINGS_PATH overrides — hermetic tests). */
export function settingsFilePath(override?: string): string {
	return override ?? process.env.IMP_SETTINGS_PATH ?? join(homedir(), ".imp", "settings.json");
}

/** The project settings file path for a working directory. */
export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".imp", "settings.json");
}

/** Coerce one parsed JSON object into ImpSettings; unknown keys are
 *  DROPPED from this view (they survive in the file — see readRaw). */
function coerceQueueMode(value: unknown): QueueMode | undefined {
	return value === "all" || value === "one-at-a-time" ? value : undefined;
}

function coerceSettings(parsed: Record<string, unknown>): ImpSettings {
	const out: ImpSettings = {};
	if (typeof parsed.defaultModel === "string" && parsed.defaultModel !== "")
		out.defaultModel = parsed.defaultModel;
	if (typeof parsed.defaultThinkingLevel === "string") {
		out.defaultThinkingLevel = parsed.defaultThinkingLevel as ThinkingLevel;
	}
	if (typeof parsed.hideThinkingBlock === "boolean") out.hideThinkingBlock = parsed.hideThinkingBlock;
	if (typeof parsed.autoCompact === "boolean") out.autoCompact = parsed.autoCompact;
	if (typeof parsed.skills === "string") out.skills = [parsed.skills];
	else if (Array.isArray(parsed.skills)) {
		out.skills = parsed.skills.filter((entry): entry is string => typeof entry === "string");
	}
	if (typeof parsed.enableSkillCommands === "boolean") out.enableSkillCommands = parsed.enableSkillCommands;
	const steeringMode = coerceQueueMode(parsed.steeringMode);
	if (steeringMode !== undefined) out.steeringMode = steeringMode;
	const followUpMode = coerceQueueMode(parsed.followUpMode);
	if (followUpMode !== undefined) out.followUpMode = followUpMode;
	if (parsed.images !== null && typeof parsed.images === "object" && !Array.isArray(parsed.images)) {
		const images = parsed.images as Record<string, unknown>;
		const outImages: { autoResize?: boolean } = {};
		if (typeof images.autoResize === "boolean") outImages.autoResize = images.autoResize;
		if (Object.keys(outImages).length > 0) out.images = outImages;
	}
	if (parsed.mcp !== null && typeof parsed.mcp === "object" && !Array.isArray(parsed.mcp)) {
		const mcp = parsed.mcp as Record<string, unknown>;
		const outMcp: { enabled?: boolean } = {};
		if (typeof mcp.enabled === "boolean") outMcp.enabled = mcp.enabled;
		if (Object.keys(outMcp).length > 0) out.mcp = outMcp;
	}
	return out;
}

/** Parse one file into a coerced view; missing/malformed reads as empty. */
function loadFrom(file: string): ImpSettings {
	try {
		const raw = readFileSync(file, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return coerceSettings(parsed as Record<string, unknown>);
	} catch {
		return {}; // missing, unreadable, or malformed JSON
	}
}

/** Read the GLOBAL settings; a missing or malformed file reads as empty. */
export function loadSettings(path?: string): ImpSettings {
	return loadFrom(settingsFilePath(path));
}

/** Read the PROJECT settings for a cwd. `allowed` false (trust gate) reads
 *  as empty WITHOUT touching the file — an untrusted repo's settings are
 *  invisible, not merely overridden. */
export function loadProjectSettings(cwd: string, allowed: boolean, pathOverride?: string): ImpSettings {
	if (!allowed) return {};
	return loadFrom(pathOverride ?? projectSettingsPath(cwd));
}

/** pi's deep merge: project wins, nested objects merge recursively, arrays
 *  replace (never concatenate). */
function deepMergeSettings(base: ImpSettings, override: ImpSettings): ImpSettings {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = out[key];
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			current !== null &&
			typeof current === "object" &&
			!Array.isArray(current)
		) {
			out[key] = deepMergeSettings(current as ImpSettings, value);
		} else {
			out[key] = value;
		}
	}
	return out as ImpSettings;
}

/** The merged view both scopes feed: global ← project. */
export function effectiveSettings(options: {
	cwd: string;
	projectAllowed: boolean;
	globalPath?: string;
	projectPath?: string;
}): ImpSettings {
	const globalSettings = loadSettings(options.globalPath);
	const projectSettings = loadProjectSettings(options.cwd, options.projectAllowed, options.projectPath);
	return deepMergeSettings(globalSettings, projectSettings);
}

/** Read one file RAW (unknown keys preserved) for read-modify-write. */
function readRaw(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Read-modify-write one scope. Raw merge keeps unknown keys (forward
 *  compat, pi parity — a future imp version reading this file loses
 *  nothing). Atomic (tmp+rename) + mkdir; best-effort: a write failure
 *  must never take the session down. */
function saveScope(patch: Record<string, unknown>, file: string): boolean {
	try {
		const raw = readRaw(file);
		const merged = { ...raw, ...patch };
		// nested patches (images.*) must deep-merge into the RAW tree too —
		// read the pre-spread base, not `merged` (which already carries the
		// patch; merging patch-into-patch would drop raw siblings — caught by
		// the M15 test suite)
		for (const [key, value] of Object.entries(patch)) {
			const current = raw[key];
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				current !== null &&
				typeof current === "object" &&
				!Array.isArray(current)
			) {
				merged[key] = { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) };
			}
		}
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(merged, null, "\t")}\n`, "utf-8");
		renameSync(tmp, file);
		return true;
	} catch {
		// unreadable dir / full disk: the session keeps running without the
		// cross-session default; the in-memory value is unaffected — but the
		// CALLER must be able to tell (review P2-2: /settings must not echo
		// success for a silent no-op).
		return false;
	}
}

/** Patch the GLOBAL scope (programmatic persistence target — D18).
 *  Returns false when the write failed (review P2-2). */
export function saveSettings(patch: Partial<ImpSettings>, path?: string): boolean {
	return saveScope(patch as Record<string, unknown>, settingsFilePath(path));
}

/** Patch the PROJECT scope (the /settings command's project writes).
 *  Returns false when the write failed. */
export function saveProjectSettings(
	patch: Partial<ImpSettings>,
	cwd: string,
	pathOverride?: string,
): boolean {
	return saveScope(patch as Record<string, unknown>, pathOverride ?? projectSettingsPath(cwd));
}
