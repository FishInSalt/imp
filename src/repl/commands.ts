import { homedir } from "node:os";
import { estimateContextTokens } from "../core/compaction.js";
import type { AssistantBlock } from "../core/messages.js";
import type { SessionStore } from "../core/session/store.js";
import {
	effectiveSettings,
	loadProjectSettings,
	loadSettings,
	projectSettingsPath,
	type QueueMode,
	saveProjectSettings,
	saveSettings,
} from "../core/settings.js";
import {
	canonicalizeDir,
	defaultTrustStorePath,
	nearestTrustEntry,
	readTrustFile,
	removeTrust,
} from "../core/trust.js";
import { listChildWorktrees, resolveRepoState } from "../core/worktree.js";
import type { RegisteredExtensionCommand } from "../extensions/types.js";
import { formatTokens } from "../format.js";
import { mcpConfigPaths } from "../mcp/config.js";
import type { McpManager } from "../mcp/manager.js";
import {
	type ApiKeyFamily,
	clearApiKey,
	loadApiKey,
	saveApiKey,
	storedApiKeyFamilies,
} from "../provider/auth-store.js";
import { catalogModelIds, refreshCatalog } from "../provider/catalog.js";
import { loadCodexCredential, loginCodex, logoutCodex } from "../provider/codex-auth.js";
import { discoverModels, familyConfigured } from "../provider/discover.js";
import {
	supportedThinkingLevels,
	THINKING_LEVELS,
	type ThinkingLevel,
	thinkingMetaFor,
} from "../provider/thinking.js";
import type { Renderer } from "../render.js";
import type { Runner } from "../runner.js";
import { copyToClipboard } from "./clipboard-write.js";
import { buildTreeRows, TREE_FILTER_MODES } from "./components/tree-selector.js";
import type { SelectOptions, TreeSelectRequest } from "./line-input.js";

export interface CommandContext {
	runner: Runner;
	renderer: Renderer;
	isActive: () => boolean; // running || compacting
	requestExit(code: number): void; // graceful path
	abortActive(): boolean; // abort controller if active
	/** Replay a session's history on screen (wired in repl.ts; records in tests). */
	replay(session: SessionStore): number;
	/** Submit a prompt as if typed — used by markdown quick commands (M11 #6)
	 *  and skill commands (M12 §11.3). Idle starts a turn; a running turn
	 *  queues it. Wired by repl.ts; test environments inject a recorder.
	 *  `display` overrides ONLY the transcript echo (skill commands pass a
	 *  one-line summary instead of the expanded block; the session record
	 *  always keeps the full text — replay fidelity). Injection-surface note
	 *  (review): the full ctx is handed to EVERY command run() — extension
	 *  commands can call this too; extensions are arbitrary code by contract,
	 *  so this adds no new capability, only a documented one. */
	submitPrompt(text: string, opts?: { display?: string }): void;
	/** TUI shells only: wipe transcript + folds. /new calls it BEFORE
	 *  newSession so the "▪ new session" note lands on the fresh screen
	 *  (debt clearance); wired in repl.ts, absent in test recorders unless
	 *  injected. */
	clearView?: () => void;
	/** Repaint the TUI footer (wired in repl.ts; /think changes its level
	 *  segment). Absent in test recorders unless injected. */
	refreshFooter?: () => void;
	/** Clipboard write, bound in repl.ts (/copy). Injectable in tests so
	 *  the suite never touches the real clipboard. */
	copyText?: (text: string) => Promise<void>;
	/** M18 MCP manager, bound in repl.ts when the module is active (config
	 *  found + settings gate on). Absent otherwise — /mcp prints its own
	 *  guidance without it. */
	mcp?: McpManager;
	/** Item picker, bound in repl.ts ONLY when the input shell implements it
	 *  (TuiShell; the readline shell has none). Commands must keep a text
	 *  fallback for a missing select. Resolves the chosen index, or null on
	 *  cancel. */
	select?: (options: SelectOptions) => Promise<number | null>;
	/** #tree: session-tree navigator (TUI only; the legacy shell renders a
	 *  numbered text tree instead). Resolves the chosen entry id, or null
	 *  on cancel. */
	treeSelect?: (options: TreeSelectRequest) => Promise<string | null>;
	/** #tree: the editor's current draft (TUI only) — editorText backfill
	 *  lands only when the user is not mid-typing (pi parity). */
	getEditorText?: () => string;
	/** #tree: replace the editor text (TUI only). */
	setEditorText?: (text: string) => void;
	/** Secret text question (/login's key prompt) — bound like select; both
	 *  shells implement it (the readline one echoes). Resolves the typed
	 *  text, or null on cancel. */
	secret?: (question: string) => Promise<string | null>;
	/** M8 trust store location — hermetic tests inject a temp path. */
	trustStorePath?: string;
	/** #login-repl: credential store location — hermetic tests inject a temp
	 *  path; production defaults to ~/.imp/auth.json. */
	authStorePath?: string;
	/** #login-repl batch B: the codex device-code OAuth base URL — hermetic
	 *  tests inject a local fake; production uses auth.openai.com. */
	codexAuthBaseUrl?: string;
	/** #login-repl batch B: register the long operation's AbortController so
	 *  the machine's Ctrl+C can cancel it (the OAuth poll runs up to 15 min).
	 *  Wired by the machine's commandContext; absent in dispatch-only tests. */
	onLongOpAbort?: (controller: AbortController | null) => void;
	/** /worktrees resolves the repo here — hermetic tests inject a temp repo. */
	worktreeCwd?: string;
}

export type CommandOutcome = "handled" | "exit-requested";

export interface SlashCommand {
	readonly name: string;
	/** Display label in /help (defaults to the name; e.g. "/model [id]"). */
	readonly usage?: string;
	/** One line, shown by /help. */
	readonly summary: string;
	readonly allowedDuringRun: boolean;
	run(args: string, ctx: CommandContext): CommandOutcome | Promise<CommandOutcome>;
}

/** The current model's thinking style, derived from the display reference
 *  (bare = anthropic; prefixed = that family — resolve.ts's rule). */
function thinkingMetaForRunner(runner: Runner): ReturnType<typeof thinkingMetaFor> {
	const reference = runner.modelReference();
	const slash = reference.indexOf("/");
	const provider = slash === -1 ? "anthropic" : reference.slice(0, slash);
	const modelId = slash === -1 ? reference : reference.slice(slash + 1);
	return thinkingMetaFor(provider, modelId);
}

/** "/model glm-4.6 extra" → { name: "model", args: "glm-4.6 extra" }; non-slash → null. */
export function parseCommand(line: string): { name: string; args: string } | null {
	if (line[0] !== "/") return null; // leading space (" /foo") makes it plain text
	const rest = line.slice(1);
	const spaceAt = rest.search(/\s/);
	if (spaceAt === -1) return { name: rest, args: "" };
	return { name: rest.slice(0, spaceAt), args: rest.slice(spaceAt).trim() };
}

const HELP_KEYS = `
Keys:
  Ctrl+C             abort the running turn (press twice to force quit);
                     at an empty prompt: press twice to exit
  Esc                abort the running turn (same as Ctrl+C); with the
                     autocomplete panel open, one Esc closes the panel only
  Ctrl+D             exit
  Ctrl+O             expand/collapse all folds (results, errors, diffs)
  Shift+Tab          cycle the thinking level (models with thinking)
  Ctrl+T             hide/show reasoning traces (pi's toggle, persisted)
  newline            Shift+Enter · Ctrl+J · backslash at end of line + Enter
  follow-up          Alt+Enter queues the line for the SAME run — consumed
                     when the model would stop, one per answer (Enter steers into
                     the next model call instead)
  queued input       Alt+Up (or Esc,p — works without the Kitty protocol)
                     pulls all queued lines back into the editor; Ctrl+C
                     abort hands them back the same way — never dropped
  ! prefix           run a shell command directly — e.g. ! ls -la
  autocomplete (/ commands · @ files):
    ↑/↓              move the selection
    Tab / Enter      complete — Enter on a command completes and runs it
    Esc              close the panel
  while a picker is open:
    ↑/↓              move the selection
    Enter            pick · Esc or Ctrl+C cancels (no interrupt)
    typing           filters the list (/resume — Enter picks the original row)
  while a question is pending (/login keys, confirms):
    Enter            submits the answer · Esc or Ctrl+C cancels
`;

/** SlashCommand | RegisteredExtensionCommand → its dispatch name (teaching lines). */
function entryName(entry: SlashCommand | RegisteredExtensionCommand): string {
	return "command" in entry ? entry.command.name : entry.name;
}

/** Column where the dim [source] tag starts in /help extension rows. */
const SOURCE_TAG_COLUMN = 66;

/**
 * Generated from COMMANDS + the extension commands so the listing cannot
 * drift (design §8.2). Without extras the output is byte-identical to the
 * pre-M4b help; extension rows carry a dim [source] suffix via `dimTag`
 * (plain in tests — renderers decide ANSI, never this module).
 */
// Long summaries (>~62 chars) exceed SOURCE_TAG_COLUMN and degrade to a
// 2-space gap instead of an aligned tag — acceptable; revisit if M5
// redesigns help rendering (review P3-2).
export function helpText(
	extraCommands: readonly RegisteredExtensionCommand[] = [],
	dimTag: (tag: string) => string = (tag) => tag,
): string {
	const lines = ["Commands:"];
	for (const command of COMMANDS) {
		const label = command.usage ?? `/${command.name}`;
		lines.push(`  ${label.padEnd(19)}${command.summary}`);
	}
	for (const entry of extraCommands) {
		const label = entry.command.usage ?? `/${entry.command.name}`;
		const row = `  ${label.padEnd(19)}${entry.command.summary}`;
		const pad = row.length >= SOURCE_TAG_COLUMN ? "  " : " ".repeat(SOURCE_TAG_COLUMN - row.length);
		lines.push(`${row}${pad}${dimTag(`[${entry.source}]`)}`);
	}
	lines.push("");
	lines.push(HELP_KEYS.trimEnd());
	lines.push("");
	lines.push("Lines typed while imp is working are queued and injected when the current turn ends.");
	return lines.join("\n");
}

/** Local time `YYYY-MM-DD HH:MM` for /sessions rows. */
function formatWhen(date: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** v1 selector candidates for /model: no model registry exists, so this is
 *  the README-documented set (claude-sonnet-4-5 default; the GLM coding-plan
 *  ids) with the runner's current id prepended when it is not among them — a
 *  custom IMP_MODEL / -m id must stay pickable. Replace when a real model
 *  registry lands. */
const MODEL_CANDIDATES: readonly string[] = [
	"claude-sonnet-4-5",
	"zai/glm-5.3",
	"zai/glm-5.3-highspeed",
	"zai/glm-4.7",
	"openai-codex/gpt-5.5",
	"openai/gpt-5.2",
];

function modelCandidates(current: string): string[] {
	return MODEL_CANDIDATES.includes(current) ? [...MODEL_CANDIDATES] : [current, ...MODEL_CANDIDATES];
}

/** Static seeds shown when a CONFIGURED family's listing is unreachable. */
const FAMILY_FALLBACKS: Record<string, readonly string[]> = {
	// GLM is NOT advertised under anthropic anymore — pi parity: zai is the
	// one official GLM path (bare glm-* ids still route there via ZAI_API_KEY)
	anthropic: ["claude-sonnet-4-5"],
	openai: ["openai/gpt-5.2"],
	// The complete official coding-plan catalog (pi's generated
	// openai-codex.json is the sourced truth — probe confirmed the backend's
	// /codex/models returns an empty list for plan accounts today).
	"openai-codex": [
		"openai-codex/gpt-6-astra",
		"openai-codex/gpt-5.5",
		"openai-codex/gpt-5.4",
		"openai-codex/gpt-5.4-mini",
		"openai-codex/gpt-5.3-codex-spark",
		"openai-codex/gpt-5.6-luna",
		"openai-codex/gpt-5.6-sol",
		"openai-codex/gpt-5.6-terra",
	],
	// pi.dev's live zai catalog (2026-09)
	zai: [
		"zai/glm-5.3",
		"zai/glm-5.3-highspeed",
		"zai/glm-5.3-flash",
		"zai/glm-5.2",
		"zai/glm-5.2-highspeed",
		"zai/glm-5-turbo",
		"zai/glm-4.7",
	],
};

/** Row descriptions identify the family — a bare id cannot (P2-5 lesson). */
function familyLabel(id: string): string {
	if (id.startsWith("openai-codex/")) return "ChatGPT plan (Codex)";
	if (id.startsWith("zai/")) return "Z.ai GLM coding plan";
	if (id.startsWith("openai/")) return "OpenAI-compatible endpoint";
	return "anthropic-compatible endpoint";
}

// ---------------------------------------------------------------------------
// /settings (M15) — pi's settings-selector, lean form
// ---------------------------------------------------------------------------

interface SettingEntry {
	key: string;
	label: string;
	current: string;
	/** env vars shadow a key (the imp invariant: env is the session override). */
	envShadow?: string;
	source: "env" | "project" | "global" | "default";
	kind: "boolean" | "level" | "string" | "mode";
	/** Cycle values for kind "mode" (batch B §4 P2: the queue pair is no
	 *  longer hardcoded — pi's settings-selector values array). */
	values?: string[];
}

/** Per-key source (review P2-3): env > project > global > default. */
function settingSource(ctx: CommandContext, key: string): "env" | "project" | "global" | "default" {
	const pick = (o: object) => {
		if (key.startsWith("images.")) return (o as { images?: { autoResize?: boolean } }).images?.autoResize;
		if (key.startsWith("mcp.")) return (o as { mcp?: { enabled?: boolean } }).mcp?.enabled;
		if (key.startsWith("branchSummary."))
			return (o as { branchSummary?: { skipPrompt?: boolean } }).branchSummary?.skipPrompt;
		return (o as Record<string, unknown>)[key];
	};
	if (key === "defaultModel" && process.env.IMP_MODEL !== undefined) return "env";
	if (key === "autoCompact" && process.env.IMP_AUTOCOMPACT === "0") return "env";
	if (pick(loadProjectSettings(ctx.runner.runnerCwd, ctx.runner.projectSettingsAllowed)) !== undefined) {
		return "project";
	}
	if (pick(loadSettings(ctx.runner.globalSettingsPath())) !== undefined) return "global";
	return "default";
}

function settingsEntries(ctx: CommandContext): SettingEntry[] {
	// LIVE read, not the runner's construction-time snapshot (review P1-1):
	// the command's own writes must show immediately — a snapshot here made
	// /settings contradict its own previous write in the same session.
	const effective = effectiveSettings({
		cwd: ctx.runner.runnerCwd,
		projectAllowed: ctx.runner.projectSettingsAllowed,
		globalPath: ctx.runner.globalSettingsPath(),
	});
	const env = (name: string) => (process.env[name] === undefined ? undefined : process.env[name]);
	const bool = (v: boolean | undefined, dflt: boolean) => (v === undefined ? dflt : v).toString();
	const src = (key: string) => settingSource(ctx, key);
	return [
		{
			key: "defaultModel",
			label: "startup model (-m and IMP_MODEL win)",
			current: env("IMP_MODEL") ?? effective.defaultModel ?? "(builtin default)",
			envShadow: env("IMP_MODEL") !== undefined ? "IMP_MODEL" : undefined,
			kind: "string",
			source: src("defaultModel"),
		},
		{
			key: "defaultThinkingLevel",
			label: "thinking level for new sessions",
			current: effective.defaultThinkingLevel ?? "(medium)",
			kind: "level",
			source: src("defaultThinkingLevel"),
		},
		{
			key: "hideThinkingBlock",
			label: "hide thinking text (ctrl+t toggles live)",
			current: bool(effective.hideThinkingBlock, false),
			kind: "boolean",
			source: src("hideThinkingBlock"),
		},
		{
			key: "autoCompact",
			label: "auto-compaction on context pressure",
			current: process.env.IMP_AUTOCOMPACT === "0" ? "false" : bool(effective.autoCompact, true),
			envShadow: process.env.IMP_AUTOCOMPACT === "0" ? "IMP_AUTOCOMPACT=0" : undefined,
			kind: "boolean",
			source: src("autoCompact"),
		},
		{
			key: "enableSkillCommands",
			label: "register skills as /skill:name",
			current: bool(effective.enableSkillCommands, true),
			kind: "boolean",
			source: src("enableSkillCommands"),
		},
		{
			key: "images.autoResize",
			label: "resize large images before sending",
			current: bool(effective.images?.autoResize, true),
			kind: "boolean",
			source: src("images.autoResize"),
		},
		{
			key: "mcp.enabled",
			label: "connect MCP servers from mcp.json",
			current: bool(effective.mcp?.enabled, true),
			kind: "boolean",
			source: src("mcp.enabled"),
			envShadow: process.env.IMP_MCP === "0" ? "IMP_MCP=0" : undefined,
		},
		{
			key: "steeringMode",
			label: "steering drain per turn boundary",
			current: effective.steeringMode ?? "all",
			kind: "mode",
			source: src("steeringMode"),
		},
		{
			key: "followUpMode",
			label: "follow-up drain per run boundary",
			current: effective.followUpMode ?? "one-at-a-time",
			kind: "mode",
			values: [...QUEUE_MODES],
			source: src("followUpMode"),
		},
		{
			key: "treeFilterMode",
			label: "default filter when /tree opens",
			current: effective.treeFilterMode ?? "default",
			kind: "mode",
			values: [...TREE_FILTER_MODES],
			source: src("treeFilterMode"),
		},
		{
			key: "branchSummary.skipPrompt",
			label: "skip the “summarize branch?” ask on /tree",
			current: bool(effective.branchSummary?.skipPrompt, false),
			kind: "boolean",
			source: src("branchSummary.skipPrompt"),
		},
	];
}

const SETTING_KEYS = [
	"defaultModel",
	"defaultThinkingLevel",
	"hideThinkingBlock",
	"autoCompact",
	"enableSkillCommands",
	"images.autoResize",
	"mcp.enabled",
	"steeringMode",
	"followUpMode",
	"treeFilterMode",
	"branchSummary.skipPrompt",
] as const;

const QUEUE_MODES = ["all", "one-at-a-time"] as const;

function parseSettingValue(
	key: string,
	raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	switch (key) {
		case "defaultModel":
			return raw.trim() === ""
				? { ok: false, error: "defaultModel needs a model id" }
				: { ok: true, value: raw.trim() };
		case "defaultThinkingLevel":
			return (THINKING_LEVELS as readonly string[]).includes(raw)
				? { ok: true, value: raw }
				: { ok: false, error: `thinking level must be one of: ${THINKING_LEVELS.join(", ")}` };
		case "hideThinkingBlock":
		case "autoCompact":
		case "enableSkillCommands":
		case "images.autoResize":
		case "mcp.enabled":
		case "branchSummary.skipPrompt":
			if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
			return { ok: false, error: `${key} must be true or false` };
		case "steeringMode":
		case "followUpMode":
			return (QUEUE_MODES as readonly string[]).includes(raw)
				? { ok: true, value: raw }
				: { ok: false, error: `${key} must be one of: ${QUEUE_MODES.join(", ")}` };
		case "treeFilterMode":
			return (TREE_FILTER_MODES as readonly string[]).includes(raw)
				? { ok: true, value: raw }
				: { ok: false, error: `${key} must be one of: ${TREE_FILTER_MODES.join(", ")}` };
		default:
			return {
				ok: false,
				error: `unknown setting — one of: ${SETTING_KEYS.join(", ")} (skills[] is file-edit only)`,
			};
	}
}

function settingPatchFor(key: string, value: unknown): Record<string, unknown> {
	if (key.startsWith("images.")) {
		return { images: { [key.slice("images.".length)]: value } };
	}
	if (key.startsWith("mcp.")) {
		return { mcp: { [key.slice("mcp.".length)]: value } };
	}
	if (key.startsWith("branchSummary.")) {
		return { branchSummary: { [key.slice("branchSummary.".length)]: value } };
	}
	return { [key]: value };
}

async function runSettingsCommand(args: string, ctx: CommandContext): Promise<CommandOutcome> {
	const parts = args.trim().split(/\s+/).filter(Boolean);

	// ---- /settings key value [scope] ----
	if (parts.length >= 2) {
		const key = parts[0] as string;
		const scope = parts[2] ?? "global";
		if (scope !== "global" && scope !== "project") {
			ctx.renderer.error(`imp: scope must be global or project — got ${JSON.stringify(scope)}`);
			return "handled";
		}
		if (scope === "project" && !ctx.runner.projectSettingsAllowed) {
			ctx.renderer.error(
				"imp: project settings need this directory trusted — start imp with --trust (or without --no-trust) and accept the prompt",
			);
			return "handled";
		}
		const parsed = parseSettingValue(key, parts[1] as string);
		if (!parsed.ok) {
			ctx.renderer.error(`imp: ${parsed.error}`);
			return "handled";
		}
		const before = settingsEntries(ctx).find((e) => e.key === key)?.current ?? "(unset)";
		const patch = settingPatchFor(key, parsed.value);
		const saved =
			scope === "project"
				? saveProjectSettings(
						patch as Partial<import("../core/settings.js").ImpSettings>,
						ctx.runner.runnerCwd,
					)
				: saveSettings(
						patch as Partial<import("../core/settings.js").ImpSettings>,
						ctx.runner.globalSettingsPath(),
					);
		if (!saved) {
			ctx.renderer.error(`imp: could not write the ${scope} settings file — changes NOT saved`);
			return "handled";
		}
		const when = key === "treeFilterMode" || key === "branchSummary.skipPrompt" ? "live" : "next session";
		ctx.renderer.status(`settings: ${key} ${before} → ${String(parsed.value)} (${scope}, ${when})`);
		return "handled";
	}

	// ---- /settings key ----
	if (parts.length === 1) {
		const key = parts[0] as string;
		if (!SETTING_KEYS.includes(key as (typeof SETTING_KEYS)[number])) {
			ctx.renderer.error(`imp: unknown setting ${JSON.stringify(key)} — one of: ${SETTING_KEYS.join(", ")}`);
			return "handled";
		}
		const entry = settingsEntries(ctx).find((e) => e.key === key);
		ctx.renderer.writeLine(
			`${key} = ${entry?.current ?? "(unset)"}${entry?.envShadow ? ` (env ${entry.envShadow} wins)` : ""}`,
		);
		ctx.renderer.writeLine(`set with: /settings ${key} <value> [global|project]`);
		return "handled";
	}

	// ---- no-arg: table, or the TUI picker ----
	const entries = settingsEntries(ctx);
	const table = entries
		.map((e) => `${e.key} = ${e.current} [${e.source}]${e.envShadow ? ` (env ${e.envShadow} wins)` : ""}`)
		.join("\n");
	if (ctx.select === undefined) {
		ctx.renderer.writeLine(table);
		ctx.renderer.writeLine(
			`global: ${ctx.runner.globalSettingsPath()}  project: ${projectSettingsPath(ctx.runner.runnerCwd)}${ctx.runner.projectSettingsAllowed ? "" : " (untrusted — inactive)"}`,
		);
		return "handled";
	}

	const rows = entries.map((e) => ({
		label: e.key,
		description: `${e.current} · ${e.source}${e.envShadow ? ` · env ${e.envShadow} wins` : ""}`,
	}));
	const index = await ctx.select({
		title: "settings — Enter edits, Esc closes",
		items: rows,
	});
	if (index === null) return "handled";
	const entry = entries[index];
	if (entry === undefined) return "handled";

	// value entry: cycle booleans/levels, ask for strings (review P2-4: the
	// typed value runs through the SAME validation as the text form — a
	// pasted trailing space must not become the startup model)
	let next: string | null;
	if (entry.kind === "string") {
		const typed = (await ctx.secret?.(`${entry.key} =`)) ?? null;
		if (typed === null || typed.trim() === "") next = null;
		else {
			const checked = parseSettingValue(entry.key, typed);
			if (!checked.ok) {
				ctx.renderer.error(`imp: ${checked.error}`);
				return "handled";
			}
			next = String(checked.value);
		}
	} else if (entry.kind === "level") {
		const order = THINKING_LEVELS as readonly string[];
		const at = order.indexOf(entry.current === "(medium)" ? "medium" : entry.current);
		next = order[(at + 1) % order.length] ?? null;
	} else if (entry.kind === "mode") {
		// Batch B §4 P2: cycle within the entry's own values (the hardcoded
		// queue pair once wrote invalid treeFilterMode literals that coerce
		// then silently dropped).
		const cycle = entry.values ?? [...QUEUE_MODES];
		const at = cycle.indexOf(entry.current);
		next = at === -1 ? (cycle[0] ?? null) : (cycle[(at + 1) % cycle.length] ?? null);
	} else {
		next = entry.current === "true" ? "false" : "true";
	}
	if (next === null) return "handled";

	// scope: project only offered when trusted
	const scopeItems = [
		{ label: "global", description: ctx.runner.globalSettingsPath() },
		...(ctx.runner.projectSettingsAllowed
			? [{ label: "project", description: projectSettingsPath(ctx.runner.runnerCwd) }]
			: []),
	];
	let scope: "global" | "project" = "global";
	if (scopeItems.length > 1) {
		const pick = await ctx.select({ title: "write to which settings file?", items: scopeItems });
		if (pick === null) return "handled";
		scope = pick === 1 ? "project" : "global";
	}
	const patch = settingPatchFor(entry.key, entry.kind === "boolean" ? next === "true" : next);
	const saved =
		scope === "project"
			? saveProjectSettings(patch as Partial<import("../core/settings.js").ImpSettings>, ctx.runner.runnerCwd)
			: saveSettings(
					patch as Partial<import("../core/settings.js").ImpSettings>,
					ctx.runner.globalSettingsPath(),
				);
	if (!saved) {
		ctx.renderer.error(`imp: could not write the ${scope} settings file — changes NOT saved`);
		return "handled";
	}
	const when =
		entry.key === "treeFilterMode" || entry.key === "branchSummary.skipPrompt" ? "live" : "next session";
	ctx.renderer.status(`settings: ${entry.key} ${entry.current} → ${next} (${scope}, ${when})`);
	return "handled";
}

export interface ModelListDeps {
	/** Families that currently hold a credential. */
	configured: (family: "anthropic" | "openai" | "openai-codex" | "zai") => boolean;
	/** Endpoint listing, null when unreachable — injectable for tests. */
	discover: (family: "anthropic" | "openai" | "openai-codex" | "zai") => Promise<string[] | null>;
	/** M14: pi.dev overlay ids for the family, null when the catalog has
	 *  nothing — injectable for tests. */
	catalogIds?: (family: "anthropic" | "openai" | "openai-codex" | "zai") => string[] | null;
}

/**
 * Build the picker list: the union of what every CONFIGURED family serves
 * (#model-discovery — "what you can use right now"). Unconfigured families
 * are excluded outright; a configured family whose listing fails falls back
 * to its static seed. When NOTHING is configured (fresh install) the classic
 * global seed list keeps the picker useful. The current model always leads,
 * even when it is a custom id the endpoints never listed.
 */
export async function buildModelList(
	current: string,
	deps: ModelListDeps,
): Promise<{
	rows: Array<{ label: string; description?: string }>;
	fallbackNotes: string[];
}> {
	const families = ["anthropic", "openai", "openai-codex", "zai"] as const;
	const fallbackNotes: string[] = [];
	let ids: string[] = [];
	const configuredFamilies = families.filter((f) => deps.configured(f));
	if (configuredFamilies.length === 0) {
		ids = modelCandidates(current).filter((id) => id !== current);
	} else {
		for (const family of configuredFamilies) {
			let discovered = await deps.discover(family);
			// M14: the pi.dev disk cache stands between live discovery and the
			// static floor — offline picker lists the real family catalog. The
			// live probe still runs FIRST (fresh 5-min data wins; no staleness
			// regression); the 4h catalog cache answers only when the probe is
			// unreachable, so a dropped endpoint still shows real ids (at the
			// cost of a second pi.dev hit for openai-codex on /model open).
			if (discovered === null && family === "openai-codex") {
				discovered = deps.catalogIds?.(family) ?? null;
			}
			if (family === "openai-codex") {
				// pi.dev's catalog is the primary truth (it served gpt-6-astra the
				// day it shipped); the static seeds are the offline fallback — a
				// union floor so a catalog regression can never HIDE models.
				if (discovered === null) {
					ids.push(...(FAMILY_FALLBACKS[family] ?? []));
					fallbackNotes.push("model catalog (pi.dev)");
				} else {
					for (const id of discovered) ids.push(`openai-codex/${id}`);
				}
				continue;
			}
			if (discovered === null) {
				const catalogIds = deps.catalogIds?.(family) ?? null;
				if (catalogIds !== null) {
					// Same shaping as the discovery path — offline catalog rows
					// are indistinguishable from live ones (no "unreachable" note:
					// the catalog is the truth source, not a degraded copy).
					const listed =
						family === "anthropic"
							? catalogIds.filter((id) => !id.toLowerCase().startsWith("glm-"))
							: catalogIds;
					ids.push(...listed.map((id) => (family === "anthropic" ? id : `${family}/${id}`)));
				} else {
					fallbackNotes.push(familyLabel(`${family}/`));
					ids.push(...(FAMILY_FALLBACKS[family] ?? []));
				}
			} else {
				// #glm-retire: GLM is never ADVERTISED under anthropic — a
				// compat endpoint (ANTHROPIC_BASE_URL → z.ai) serves glm ids
				// that duplicate the zai family's rows. zai is the one
				// official GLM path; explicit anthropic/glm-* still works by
				// typing it. Claude/other ids pass through untouched.
				const listed =
					family === "anthropic"
						? discovered.filter((id) => !id.toLowerCase().startsWith("glm-"))
						: discovered;
				ids.push(...listed.map((id) => (family === "anthropic" ? id : `${family}/${id}`)));
			}
		}
	}
	ids = [...new Set(ids)];
	const rows = (ids.includes(current) ? ids : [current, ...ids]).map((id) => ({
		label: id,
		description: id === current ? "current" : familyLabel(id),
	}));
	return { rows, fallbackNotes };
}

/** The switch itself, shared by "/model <id>" and the picker's pick — the
 *  write and the note are byte-identical whichever way the id arrived. */
function switchModel(ctx: CommandContext, id: string): void {
	ctx.runner.setModel(id); // re-resolves the provider too (multi-provider)
	// Canonical refs on both sides (review P2-5): "gpt-5.4" alone cannot tell
	// the user WHICH protocol family the switch landed on.
	ctx.renderer.status(`Model: ${ctx.runner.modelReference()}`); // pi's showStatus form
}

/** /resume <id>'s body, shared by the by-arg path and the picker's pick — the
 *  resume, replay, and note are byte-identical whichever way the id arrived. */
function resumeById(ctx: CommandContext, id: string): CommandOutcome {
	try {
		const { id8, messages } = ctx.runner.resumeSession(id);
		ctx.clearView?.(); // the old conversation leaves the screen FIRST (debt clearance)
		const session = ctx.runner.session;
		if (session !== null && messages > 0) ctx.replay(session);
		ctx.renderer.note(`▪ resumed ${id8} — ${messages} message${messages === 1 ? "" : "s"} restored`);
	} catch (err) {
		ctx.renderer.error(`imp: ${err instanceof Error ? err.message : String(err)}`);
	}
	return "handled";
}

/** Picker-row description: local time, message count, and a truncated title
 *  preview (SessionInfo.title is the first user message — a cheap preview). */
function sessionRowDescription(modified: Date, messageCount: number, title: string): string {
	const preview = title.length > 40 ? `${title.slice(0, 40)}…` : title;
	return `${formatWhen(modified)} · ${messageCount} msgs · ${preview}`;
}

/** One /login row — pi's auth metadata table, scoped to imp's families.
 *  Every api-key family shows its status (pi's OAuthSelector rows show
 *  status.type + source the same way); codex is OAuth-only, bridged to the
 *  CLI flow until the in-REPL dialog lands. */
interface LoginTarget {
	family: ApiKeyFamily | "openai-codex";
	/** pi's provider display name. */
	name: string;
	/** The env-var alternative (the description's source label). */
	envVar: string;
	method: "api_key" | "oauth";
	/** Post-login /model hint when the current family differs. */
	switchHint: string;
}

const LOGIN_TARGETS: readonly LoginTarget[] = [
	{ family: "zai", name: "Z.AI", envVar: "ZAI_API_KEY", method: "api_key", switchHint: "zai/glm-5.3" },
	{
		family: "anthropic",
		name: "Anthropic",
		envVar: "ANTHROPIC_API_KEY",
		method: "api_key",
		switchHint: "claude-sonnet-4-5",
	},
	{
		family: "openai",
		name: "OpenAI",
		envVar: "OPENAI_API_KEY",
		method: "api_key",
		switchHint: "openai/gpt-5.2",
	},
	{
		family: "openai-codex",
		name: "OpenAI (ChatGPT plan)",
		envVar: "none — OAuth",
		method: "oauth",
		switchHint: "openai-codex/gpt-5.5",
	},
];

/** A row's status line (pi: configured rows carry type + source). */
function loginStatus(target: LoginTarget, authPath?: string): string {
	if (target.family === "openai-codex") {
		return loadCodexCredential(authPath) !== null ? "signed in — stored token" : "not signed in";
	}
	if (loadApiKey(target.family, authPath) !== null) return "signed in — stored key";
	if (process.env[target.envVar] !== undefined) return `env: ${target.envVar}`;
	return "not signed in";
}

/** Resolve "/login <ref>" to its target — case-insensitive against family
 *  id AND display name (pi's findLoginProviderOptions). */
export function loginTargetFor(ref: string): LoginTarget | undefined {
	const needle = ref.trim().toLowerCase();
	if (needle === "") return undefined;
	return LOGIN_TARGETS.find((t) => t.family === needle || t.name.toLowerCase() === needle);
}

/** Whether a /login line needs the machine's guarded long-op state (the
 *  codex OAuth poll runs up to 15 minutes): no-arg /login (the picker may
 *  land on codex) or a ref that resolves to the oauth target. */
export function loginNeedsGuard(line: string): boolean {
	const parsed = parseCommand(line);
	if (parsed === null || parsed.name !== "login") return false;
	if (parsed.args.trim() === "") return true; // picker — codex is pickable
	return loginTargetFor(parsed.args)?.method === "oauth";
}

/** /login's body, shared by the picker's pick and "/login <family>". */
async function loginToTarget(ctx: CommandContext, target: LoginTarget): Promise<void> {
	if (target.method === "oauth") {
		// pi's LoginDialog: the URL + user code render, the poll runs in the
		// background, Esc/Ctrl+C cancels ("Login cancelled" stays silent).
		// The machine guards the dispatch (loginNeedsGuard) so Ctrl+C aborts
		// THIS controller instead of counting toward a force quit.
		const controller = new AbortController();
		ctx.onLongOpAbort?.(controller);
		try {
			await loginCodex({
				authPath: ctx.authStorePath,
				// IMP_CODEX_AUTH_BASE: machine-level e2e seam (dispatch tests
				// use ctx.codexAuthBaseUrl; the machine builds no such ctx)
				authBaseUrl: ctx.codexAuthBaseUrl ?? process.env.IMP_CODEX_AUTH_BASE,
				signal: controller.signal,
				onDeviceCode: ({ verificationUri, userCode }) => {
					ctx.renderer.note(`▪ open ${verificationUri} and enter code: ${userCode}`);
				},
			});
			ctx.renderer.status(`Logged in to ${target.name}`); // pi's wording
			const current = ctx.runner.modelReference();
			const currentFamily = current.includes("/") ? current.slice(0, current.indexOf("/")) : "anthropic";
			if (currentFamily !== target.family) {
				ctx.renderer.note(`▪ switch with /model ${target.switchHint}`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === "Login cancelled") return; // pi: silent cancel
			ctx.renderer.error(`imp: ${target.name} login failed — ${message}`);
		} finally {
			ctx.onLongOpAbort?.(null);
		}
		return;
	}
	if (target.family === "openai-codex") return; // unreachable: oauth returned above
	const secret = ctx.secret;
	if (secret === undefined) {
		ctx.renderer.error(
			`imp: /login needs an interactive prompt — or set the key directly:\n  export ${target.envVar}=<key>`,
		);
		return;
	}
	// pi's prompt: `Enter ${name}` (packages/ai/src/auth/helpers.ts).
	const key = await secret(`Enter ${target.name} API key`);
	if (key === null || key.trim() === "") return; // cancelled/blank — silent, like pi's "Login cancelled"
	saveApiKey(target.family, key, ctx.authStorePath);
	ctx.renderer.status(`Saved API key for ${target.name}`); // pi's wording
	// pi switches the model only when none was selected; imp always has one,
	// so the pointer takes pi's place when the login changed the available
	// family.
	const current = ctx.runner.modelReference();
	const currentFamily = current.includes("/") ? current.slice(0, current.indexOf("/")) : "anthropic";
	if (currentFamily !== target.family) {
		ctx.renderer.note(`▪ switch with /model ${target.switchHint}`);
	}
}

export const COMMANDS: readonly SlashCommand[] = [
	{
		name: "help",
		summary: "show this help",
		allowedDuringRun: true,
		run: (_args, ctx) => {
			ctx.renderer.writeLine(helpText());
			return "handled";
		},
	},
	{
		name: "exit",
		summary: "exit (Ctrl+D works too)",
		allowedDuringRun: true,
		run: (_args, ctx) => {
			ctx.requestExit(0); // during a run: aborts, awaits settle, then exits
			return "exit-requested";
		},
	},
	{
		name: "new",
		summary: "start a fresh session (the old one stays on disk)",
		allowedDuringRun: false,
		run: (_args, ctx) => {
			// Clear FIRST: newSession's "▪ new session …" note must land on
			// the fresh screen, not be wiped by it (debt clearance).
			ctx.clearView?.();
			ctx.runner.newSession();
			return "handled";
		},
	},
	{
		name: "fork",
		summary: "branch the conversation before an earlier message (the old branch stays)",
		allowedDuringRun: false,
		run: async (args, ctx): Promise<CommandOutcome> => {
			const points = ctx.runner.forkPoints();
			if (points.length === 0) {
				ctx.renderer.note("▪ nothing to fork from — no user messages on this branch");
				return "handled";
			}
			const trimmed = args.trim();
			let entryId: string | undefined;
			if (/^[1-9]\d*$/.test(trimmed)) {
				const target = points[Number(trimmed) - 1];
				if (target === undefined) {
					ctx.renderer.error(`imp: /fork ${trimmed} — the list runs #1–#${points.length}`);
					return "handled";
				}
				entryId = target.id;
			} else if (trimmed !== "") {
				ctx.renderer.error(
					"imp: /fork takes no text — /fork opens the picker, /fork <n> forks before message #n",
				);
				return "handled";
			} else if (ctx.select !== undefined) {
				const pick = await ctx.select({
					title: "Fork before which message? (it is re-typed on the new branch)",
					items: points.map((p, i) => ({ label: p.preview, description: `#${i + 1}` })),
					filterable: true,
				});
				if (pick === null) return "handled"; // cancelled — the picker closing is its own feedback
				entryId = points[pick]?.id;
			} else {
				// Text fallback (legacy shell / recorders without a picker): the
				// numbered list IS the picker — /fork <n> executes.
				ctx.renderer.writeLine(ctx.renderer.dim("fork before which message?"));
				points.forEach((p, i) => {
					ctx.renderer.writeLine(ctx.renderer.dim(`  #${i + 1} `) + p.preview);
				});
				ctx.renderer.note(`▪ pick with /fork <n> (oldest is #1, newest is #${points.length})`);
				return "handled";
			}
			if (entryId === undefined) return "handled"; // unreachable; type guard
			// Batch B D6: the fork IS a tree navigation now (one "move the
			// position + rebuild history" path in the runner). The note speaks
			// navigateTree's language: one honest count (the tree keeps the
			// abandoned tail visible — /tree switches back).
			const result = await ctx.runner.forkSessionAt(entryId);
			if ("noop" in result) {
				ctx.renderer.note("▪ already at that point — nothing to fork before");
				return "handled";
			}
			if ("aborted" in result) return "handled"; // summarize:false — unreachable, kept for the union
			ctx.clearView?.(); // the abandoned tail leaves the screen FIRST
			const session = ctx.runner.session;
			if (session !== null && result.messages > 0) ctx.replay(session); // same flow as /resume
			if (result.editorText !== undefined && result.editorText.trim() !== "") {
				// What /fork always lacked (D6): the re-typed message lands back
				// in the editor — same backfill rules as /tree.
				const current = ctx.getEditorText?.() ?? "";
				const suffix = result.editorTextDroppedImages === true ? " (text only — images dropped)" : "";
				if (current.trim() === "" && ctx.setEditorText !== undefined) {
					ctx.setEditorText(result.editorText);
					if (suffix !== "") ctx.renderer.note(`▪ re-edit restores text only${suffix}`);
				} else {
					ctx.renderer.note(`▪ back in the editor: “${result.editorText.slice(0, 80)}”${suffix}`);
				}
			}
			ctx.renderer.note(
				`▪ forked before “${result.preview}” — ${result.messages} message${result.messages === 1 ? "" : "s"} kept on this branch (/tree switches back)`,
			);
			return "handled";
		},
	},
	{
		name: "tree",
		summary: "navigate the session tree — jump to any point, optionally summarizing the left branch",
		allowedDuringRun: false,
		run: async (args, ctx): Promise<CommandOutcome> => {
			const session = ctx.runner.session;
			if (session === null) {
				ctx.renderer.note("▪ sessions are off — /tree needs a session to navigate");
				return "handled";
			}
			// The numbered tree (legacy fallback AND /tree <n>) shares
			// buildTreeRows with the TUI picker — one numbering, both shells.
			const rows = buildTreeRows(session.getTree(), session.getLeafId(), { filter: "default" });
			if (rows.length === 0) {
				ctx.renderer.note("▪ nothing in this session yet");
				return "handled";
			}
			const trimmed = args.trim();
			let targetId: string | null = null;
			let summarize = false;
			let customInstructions: string | undefined;
			let viaPicker = false; // the TUI navigator already asked; the numbered path never asks
			if (/^0\d*$/.test(trimmed)) {
				// numeric but invalid (zero / leading zero) — a precise message
				ctx.renderer.error(`imp: /tree ${trimmed} — row numbers run #1–#${rows.length}`);
				return "handled";
			} else if (/^[1-9]\d*$/.test(trimmed)) {
				const target = rows[Number(trimmed) - 1];
				if (target === undefined) {
					ctx.renderer.error(`imp: /tree ${trimmed} — the tree runs #1–#${rows.length}`);
					return "handled";
				}
				targetId = target.entryId;
			} else if (trimmed !== "") {
				ctx.renderer.error("imp: /tree takes no text — /tree opens the navigator, /tree <n> goes to row #n");
				return "handled";
			} else if (ctx.treeSelect !== undefined) {
				// The pick → ask loop (review P2: Esc at the ask RETURNS TO THE
				// TREE, and a cancelled custom prompt re-asks — pi's flow; only
				// cancelling the tree itself ends the command).
				viaPicker = true;
				// Batch B: LIVE reads (a /settings write this session applies
				// immediately — settingsEntries precedent), not the runner's
				// construction-time snapshot.
				const live = effectiveSettings({
					cwd: ctx.runner.runnerCwd,
					projectAllowed: ctx.runner.projectSettingsAllowed,
					globalPath: ctx.runner.globalSettingsPath(),
				});
				const skipPrompt = live.branchSummary?.skipPrompt === true;
				while (true) {
					const picked = await ctx.treeSelect({
						roots: session.getTree(),
						leafId: session.getLeafId(),
						initialFilterMode: live.treeFilterMode ?? "default",
						// Commit-to-disk for the L key. try/catch: an append
						// failure must not ride the TUI key path out of the
						// process (§4 P3); the in-place tree update already
						// happened — the selector stays open either way.
						onLabelChange: (entryId, label) => {
							if (session.getEntry(entryId) === undefined) {
								ctx.renderer.error(`imp: cannot label ${entryId} — entry not found`);
								return;
							}
							try {
								session.appendLabelChange(entryId, label);
							} catch (err) {
								ctx.renderer.error(
									`imp: label write failed — ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						},
					});
					if (picked === null) return "handled"; // cancelled the command
					// The current position is a selectable row (absolute
					// visibility) — pi answers "already there" BEFORE any ask.
					if (picked === session.getLeafId()) {
						ctx.renderer.note("▪ already at that point");
						return "handled";
					}
					targetId = picked; // set before every exit from the loop
					if (skipPrompt || ctx.select === undefined || process.env.IMP_BRANCH_SUMMARY === "0") break;
					const choice = await ctx.select({
						title: "Summarize the branch you are leaving into the new one?",
						items: [
							{ label: "No summary", description: "switch without carrying the left branch over" },
							{ label: "Summarize", description: "keep the left branch's lessons in context" },
							{
								label: "Summarize with custom prompt",
								description: "add your own instructions",
							},
						],
					});
					if (choice === null) continue; // Esc → back to the tree selector
					if (choice === 1 || choice === 2) summarize = true;
					if (choice === 2) {
						const typed = (await ctx.secret?.("custom summarization instructions:")) ?? null;
						if (typed === null || typed.trim() === "") continue; // re-ask (pi loops too)
						customInstructions = typed.trim();
					}
					break;
				}
			} else {
				// Legacy readline shell: the numbered text tree (same rows).
				ctx.renderer.writeLine(ctx.renderer.dim("session tree (pick with /tree <n>):"));
				rows.forEach((row, i) => {
					const cursor = row.isCurrentLeaf ? " ◂" : "";
					ctx.renderer.writeLine(
						ctx.renderer.dim(`  #${i + 1} ${row.prefix}`) + row.text + ctx.renderer.dim(cursor),
					);
				});
				ctx.renderer.note("▪ /tree <n> goes to that row (the left branch is summarized in)");
				return "handled";
			}
			if (targetId === null) return "handled"; // unreachable; type guard
			// The current position is a selectable row (absolute visibility) —
			// pi's flow answers "already there" BEFORE any ask or progress note.
			if (targetId === session.getLeafId()) {
				ctx.renderer.note("▪ already at that point");
				return "handled";
			}

			// /tree <n> (both shells) and IMP_BRANCH_SUMMARY=0 keep the old
			// behavior — summarize when enabled, never otherwise (no ask).
			if (targetId !== null && !viaPicker && process.env.IMP_BRANCH_SUMMARY !== "0") {
				summarize = true;
			}

			// Progress feedback BEFORE the potentially 5-20s summarizer await —
			// the state machine holds input in the queue meanwhile (review P2-1).
			if (summarize) ctx.renderer.note("▪ switching branches… summarizing the left one");
			else ctx.renderer.note("▪ switching branches…");
			// The abort channel (design §3.4, review P1-3): compacting-state
			// Ctrl+C aborts THIS controller (the /login precedent), which the
			// summarizer sees and navigateTree reports as aborted.
			const controller = new AbortController();
			ctx.onLongOpAbort?.(controller);
			try {
				const result = await ctx.runner.navigateTree(targetId, {
					summarize,
					...(customInstructions === undefined ? {} : { customInstructions }),
					signal: controller.signal,
				});
				if ("noop" in result) {
					ctx.renderer.note("▪ already at that point");
					return "handled";
				}
				if ("aborted" in result) {
					ctx.renderer.note("▪ summarization cancelled — stayed on the current branch");
					return "handled";
				}
				ctx.clearView?.();
				if (result.messages > 0) ctx.replay(session);
				// editorText backfill (design §3.4): a user-message target puts the
				// old text back for re-editing — only over an EMPTY editor (pi parity),
				// and as a note where there is no editor (legacy shell).
				if (result.editorText !== undefined && result.editorText.trim() !== "") {
					const current = ctx.getEditorText?.() ?? "";
					// Design §7 P3: re-edit restores TEXT only — say so when the
					// original message carried images.
					const suffix = result.editorTextDroppedImages === true ? " (text only — images dropped)" : "";
					if (current.trim() === "" && ctx.setEditorText !== undefined) {
						ctx.setEditorText(result.editorText);
						if (suffix !== "") ctx.renderer.note(`▪ re-edit restores text only${suffix}`);
					} else {
						ctx.renderer.note(`▪ back in the editor: “${result.editorText.slice(0, 80)}”${suffix}`);
					}
				}
				const tail =
					result.summary === "written"
						? "the left branch is summarized in context"
						: result.summary === "empty"
							? "nothing was written beyond that point to summarize"
							: result.summary === "disabled"
								? "summary off — IMP_BRANCH_SUMMARY=0"
								: "summarizer failed — see imp-log; switched without it";
				ctx.renderer.note(`▪ navigated — ${result.messages} messages here (${tail})`);
				return "handled";
			} finally {
				ctx.onLongOpAbort?.(null);
			}
		},
	},
	{
		name: "sessions",
		summary: "list saved sessions for this directory",
		allowedDuringRun: false,
		run: (_args, ctx) => {
			const sessions = ctx.runner.listSessions();
			if (sessions.length === 0) {
				ctx.renderer.note("▪ no saved sessions for this directory yet");
				return "handled";
			}
			const currentId = ctx.runner.session?.header.id;
			const shown = sessions.slice(0, 20);
			for (const info of shown) {
				const mark = info.id === currentId ? "▸" : " ";
				const meta = ctx.renderer.dim(
					`${formatWhen(info.modified)} · ${info.messageCount} msg · ${info.turnCount} turn${info.turnCount === 1 ? "" : "s"}`,
				);
				ctx.renderer.writeLine(`${mark} ${info.id.slice(0, 8)}  ${meta}  ${info.title}`);
			}
			const hidden = sessions.length - shown.length;
			const extra = hidden > 0 ? ` (${hidden} older hidden)` : "";
			ctx.renderer.note(`▪ switch with /resume <id> — or restart: imp -r <id>${extra}`);
			ctx.renderer.note("▪ use /resume (no args) to pick one");
			return "handled";
		},
	},
	{
		name: "resume",
		usage: "/resume <id>",
		summary: "switch to a saved session (history replays on screen)",
		allowedDuringRun: false,
		run: async (args, ctx): Promise<CommandOutcome> => {
			if (args === "") {
				const select = ctx.select;
				if (select === undefined) {
					ctx.renderer.writeLine("/resume <id> — pick an id from /sessions");
					return "handled";
				}
				const sessions = ctx.runner.listSessions();
				if (sessions.length === 0) {
					ctx.renderer.note("▪ no saved sessions for this directory yet");
					return "handled";
				}
				// The picker mirrors /sessions' top-20 listing; a pick behaves exactly
				// like /resume <id> on the chosen row, cancelling changes nothing.
				const shown = sessions.slice(0, 20);
				const index = await select({
					title: "sessions — pick one to resume",
					filterable: true, // type to narrow by id or title (M11 #9)
					items: shown.map((info) => ({
						label: info.id.slice(0, 8),
						description: sessionRowDescription(info.modified, info.messageCount, info.title),
					})),
				});
				const picked = index === null ? undefined : shown[index];
				if (picked === undefined) {
					ctx.renderer.note("▪ resume cancelled");
					return "handled";
				}
				return resumeById(ctx, picked.id);
			}
			return resumeById(ctx, args);
		},
	},
	{
		name: "model",
		usage: "/model [id]",
		summary: "show the current model, or switch (applies next turn)",
		allowedDuringRun: true,
		run: async (args, ctx): Promise<CommandOutcome> => {
			if (args === "") {
				const select = ctx.select;
				if (select === undefined) {
					// Legacy readline shell: the text flow, byte-for-byte.
					ctx.renderer.writeLine(`model: ${ctx.runner.modelReference()}`);
					ctx.renderer.writeLine(
						"switch with: /model <id> — e.g. claude-sonnet-4-5, zai/glm-5.3 (any id your endpoint accepts)",
					);
					return "handled";
				}
				// TUI shell: a pick behaves exactly like /model <id> on the chosen
				// row; cancelling changes nothing and notes nothing. The list is what
				// the CONFIGURED endpoints actually serve (#model-discovery).
				// M14 dual trigger: opening /model checks the 4h staleness window
				// (non-blocking — the list below is built from the current
				// overlay; a refresh lands for the NEXT open).
				void refreshCatalog().catch(() => undefined);
				const { rows, fallbackNotes } = await buildModelList(ctx.runner.modelReference(), {
					configured: familyConfigured,
					discover: discoverModels,
					catalogIds: catalogModelIds,
				});
				for (const note of fallbackNotes) {
					ctx.renderer.note(`▪ model list: ${note} unreachable — showing known fallback ids`);
				}
				const index = await select({
					title: "models — switch applies from the next turn",
					items: rows,
				});
				const id = index === null ? undefined : rows[index]?.label;
				if (id !== undefined) switchModel(ctx, id);
				return "handled";
			}
			const id = args.trim();
			if (/\s/.test(id)) {
				throw new Error(`/model takes one id — got extra text. Usage: /model <id>, e.g. /model glm-4.6`);
			}
			switchModel(ctx, id);
			return "handled";
		},
	},
	{
		name: "login",
		usage: "/login [provider]",
		summary: "sign in to a provider (stored credential beats the env var)",
		allowedDuringRun: false,
		run: async (args, ctx): Promise<CommandOutcome> => {
			const target = loginTargetFor(args);
			if (args.trim() !== "" && target === undefined) {
				ctx.renderer.error(
					`imp: unknown provider "/login ${args.trim()}" — known: ${LOGIN_TARGETS.map((t) => t.family).join(", ")}`,
				);
				return "handled";
			}
			if (target !== undefined) {
				await loginToTarget(ctx, target);
				return "handled";
			}
			const select = ctx.select;
			if (select === undefined) {
				// Legacy text path (readline shell has a picker-less contract).
				ctx.renderer.writeLine(`providers: ${LOGIN_TARGETS.map((t) => t.family).join(", ")}`);
				ctx.renderer.writeLine("sign in with: /login <provider> — the key is stored in ~/.imp/auth.json");
				return "handled";
			}
			const rows = LOGIN_TARGETS.map((t) => ({
				label: t.name,
				description: loginStatus(t, ctx.authStorePath),
			}));
			const index = await select({ title: "sign in to a provider", items: rows });
			const picked = index === null ? undefined : LOGIN_TARGETS[index];
			if (picked !== undefined) await loginToTarget(ctx, picked);
			return "handled";
		},
	},
	{
		name: "logout",
		summary: "remove a stored credential (environment variables stay)",
		allowedDuringRun: false,
		run: async (_args, ctx): Promise<CommandOutcome> => {
			// pi's /logout lists ONLY stored credentials — an env-configured
			// provider is not imp's to remove (interactive-mode.ts
			// getLogoutProviderOptions reads the credential store).
			const rows: Array<{ label: string; description: string; act: () => string }> = [];
			const codexTarget = LOGIN_TARGETS.find((t) => t.family === "openai-codex");
			if (loadCodexCredential(ctx.authStorePath) !== null) {
				rows.push({
					label: codexTarget?.name ?? "OpenAI (ChatGPT plan)",
					description: "stored token",
					act: () => {
						logoutCodex(ctx.authStorePath);
						return `Logged out of ${codexTarget?.name ?? "OpenAI (ChatGPT plan)"}`; // pi's wording
					},
				});
			}
			for (const family of storedApiKeyFamilies(ctx.authStorePath)) {
				const target = LOGIN_TARGETS.find((t) => t.family === family);
				rows.push({
					label: target?.name ?? family,
					description: "stored key",
					act: () => {
						clearApiKey(family, ctx.authStorePath);
						// pi's wording, adapted (imp has no models.json)
						return `Removed stored API key for ${target?.name ?? family}. Environment variables are unchanged.`;
					},
				});
			}
			if (rows.length === 0) {
				ctx.renderer.status(
					"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables are unchanged.",
				);
				return "handled";
			}
			const select = ctx.select;
			if (select === undefined) {
				ctx.renderer.writeLine(`stored: ${rows.map((r) => r.label).join(", ")}`);
				ctx.renderer.writeLine("remove with: edit ~/.imp/auth.json (a picker lands with the TUI shell)");
				return "handled";
			}
			const index = await select({ title: "log out of a provider", items: rows });
			const picked = index === null ? undefined : rows[index];
			if (picked !== undefined) ctx.renderer.status(picked.act());
			return "handled";
		},
	},
	{
		name: "think",
		usage: "/think [level]",
		summary: "show or set the thinking level; no argument cycles (shift+tab)",
		allowedDuringRun: true,
		run: (args, ctx): CommandOutcome => {
			if (!ctx.runner.supportsThinking()) {
				// pi: "Current model does not support thinking" — a dim
				// status line, not a silent no-op.
				ctx.renderer.status("Current model does not support thinking");
				return "handled";
			}
			if (args === "") {
				// pi's shift+tab semantics: cycle through the model's levels.
				const meta = thinkingMetaForRunner(ctx.runner);
				if (meta === null) return "handled"; // unreachable: supportsThinking passed
				const levels = supportedThinkingLevels(meta);
				const current = ctx.runner.thinkingLevel;
				const next = levels[(levels.indexOf(current) + 1) % levels.length] ?? "off";
				const effective = ctx.runner.setThinkingLevel(next);
				ctx.renderer.status(`Thinking level: ${effective}`);
				ctx.refreshFooter?.();
				return "handled";
			}
			if (!(THINKING_LEVELS as readonly string[]).includes(args)) {
				ctx.renderer.error(`thinking levels: ${THINKING_LEVELS.join(", ")} — e.g. /think medium`);
				return "handled";
			}
			const effective = ctx.runner.setThinkingLevel(args as ThinkingLevel);
			ctx.renderer.status(
				effective === args
					? `Thinking level: ${effective}`
					: `Thinking level: ${effective} (${args} is not available on this model)`,
			);
			ctx.refreshFooter?.();
			return "handled";
		},
	},
	{
		name: "worktrees",
		summary: "list worktrees kept for a manual merge (M6b handbacks)",
		allowedDuringRun: false,
		// awaited (like /compact): output must land before the next command's
		// (M8 review F5 — fire-and-forget interleaved lines after later output)
		run: async (_args, ctx): Promise<CommandOutcome> => {
			try {
				const repo = await resolveRepoState(ctx.worktreeCwd ?? process.cwd());
				const entries = await listChildWorktrees(repo);
				if (entries.length === 0) {
					ctx.renderer.note("▪ no kept worktrees — task isolation cleans up after itself");
					return "handled";
				}
				const deletable: string[] = [];
				for (const entry of entries) {
					// Deletion safety needs BOTH: nothing to merge AND nothing
					// uncommitted. `merged` alone lied for dirty worktrees whose
					// branch tip is an ancestor (M8 review P1).
					let state: string;
					if (entry.missing) {
						state = "directory missing — run: git worktree prune";
					} else if (entry.merged || entry.patchEquivalent) {
						state =
							entry.stat === ""
								? `${entry.patchEquivalent ? "already in main" : "merged"} — safe to delete`
								: `${entry.patchEquivalent ? "already in main" : "merged"}, but uncommitted work remains: ${entry.stat}`;
					} else if (entry.stat === "") {
						state = "no differences vs main";
					} else {
						state = entry.stat;
					}
					ctx.renderer.writeLine(`${entry.branch}  ${ctx.renderer.dim(state)}`);
					ctx.renderer.writeLine(ctx.renderer.dim(`  ${entry.path}`));
					if (!entry.missing && (entry.merged || entry.patchEquivalent) && entry.stat === "") {
						deletable.push(entry.branch);
					}
				}
				const unmerged = entries.filter((e) => !e.missing && !e.merged && !e.patchEquivalent);
				if (unmerged.length > 0) {
					ctx.renderer.note(
						`▪ merge from the repo root: ${unmerged.map((e) => `git merge ${e.branch}`).join("; ")}`,
					);
				}
				if (deletable.length > 0) {
					ctx.renderer.note(`▪ already in main with no uncommitted work: ${deletable.join(", ")}`);
				}
			} catch (err) {
				ctx.renderer.error(`imp: ${err instanceof Error ? err.message : String(err)}`);
			}
			return "handled";
		},
	},
	{
		name: "trust",
		summary: "show the project-trust decision for this directory (and all records)",
		allowedDuringRun: false,
		run: (args, ctx) => {
			const store = ctx.trustStorePath ?? defaultTrustStorePath(homedir());
			const cwd = process.cwd();
			if (args.startsWith("remove ")) {
				const target = args.slice("remove ".length).trim();
				if (target === "") {
					ctx.renderer.error("imp: /trust remove <dir> — which record?");
					return "handled";
				}
				try {
					// echo the canonical key, not the raw input ("." vs the
					// resolved path confused users — M8 review F7)
					const shown = canonicalizeDir(target);
					ctx.renderer.note(
						removeTrust(store, target)
							? `▪ removed the trust record for ${shown}`
							: `▪ no trust record for ${shown} (paths are absolute; "~" is not expanded)`,
					);
				} catch (err) {
					ctx.renderer.error(`imp: ${err instanceof Error ? err.message : String(err)}`);
				}
				return "handled";
			}
			if (args !== "") {
				ctx.renderer.writeLine("/trust — show decisions · /trust remove <dir> — forget one record");
				return "handled";
			}
			try {
				const data = readTrustFile(store);
				const entry = nearestTrustEntry(data, cwd);
				const status =
					entry === null
						? "undecided — project .imp/ resources are skipped until trusted (imp --trust, or the startup ask)"
						: entry.trusted
							? `trusted (decided at ${entry.path})`
							: `not trusted (decided at ${entry.path})`;
				ctx.renderer.note(`▪ this directory: ${status}`);
				const records = Object.keys(data).sort();
				if (records.length === 0) {
					ctx.renderer.note("▪ no records yet");
				} else {
					for (const dir of records) {
						ctx.renderer.writeLine(`${data[dir] ? "✓" : "✗"} ${dir}`);
					}
					ctx.renderer.note("▪ /trust remove <dir> forgets a record");
				}
			} catch (err) {
				ctx.renderer.error(`imp: ${err instanceof Error ? err.message : String(err)}`);
			}
			return "handled";
		},
	},
	{
		name: "status",
		summary: "session, model, context, and trust at a glance",
		allowedDuringRun: true,
		// Read-only state dump — safe mid-run (notes interleave cleanly), and
		// "what model am I on / how full is the context" is exactly what you
		// want to ask while a long turn streams (M11 #7).
		run: (_args, ctx): CommandOutcome => {
			const runner = ctx.runner;
			ctx.renderer.note(`▪ model ${runner.model}`);
			const session = runner.session;
			if (session === null) {
				ctx.renderer.note("▪ session none (--no-session)");
			} else {
				const stats = session.stats();
				const name = session.getSessionName();
				ctx.renderer.note(
					`▪ session ${session.header.id.slice(0, 8)}${name ? ` · ${name}` : ""} · ${stats.messageCount} msgs · in ${formatTokens(stats.inputTokens)} / out ${formatTokens(stats.outputTokens)} cumulative`,
				);
			}
			const contextTokens = estimateContextTokens(runner.history).tokens;
			const contextPercent = Math.round((contextTokens / ctx.runner.contextWindow) * 100);
			ctx.renderer.note(
				`▪ context ~${formatTokens(contextTokens)} tokens · ${contextPercent}% of window${contextPercent >= 80 ? " — /compact to summarize older turns" : ""}`,
			);
			// A corrupt store degrades to "unreadable", not a thrown command
			// (the /trust command's own contract — review P2).
			try {
				const storePath = ctx.trustStorePath ?? defaultTrustStorePath(homedir());
				const entry = nearestTrustEntry(readTrustFile(storePath), canonicalizeDir(process.cwd()));
				const state =
					entry === null
						? "no entry for this tree"
						: entry.trusted
							? `granted at ${entry.path}`
							: `revoked at ${entry.path}`;
				ctx.renderer.note(`▪ project trust ${state}`);
			} catch {
				ctx.renderer.note("▪ project trust (store unreadable — /trust shows details)");
			}
			return "handled";
		},
	},
	{
		name: "mcp",
		summary: "show MCP server connections and tool counts",
		usage: "/mcp",
		allowedDuringRun: true, // read-only status, like /status (M18 §6)
		run: (_args, ctx) => {
			// Mirror createMcpSetup's gate order: environment first, then settings.
			if (process.env.IMP_MCP === "0") {
				ctx.renderer.note(
					"▪ mcp disabled via IMP_MCP=0 (environment) — unset it or set IMP_MCP=1 (next session)",
				);
				return "handled";
			}
			const settings = ctx.runner.effectiveSettings();
			if (settings.mcp?.enabled === false) {
				ctx.renderer.note(
					"▪ mcp disabled in settings — /settings mcp.enabled true re-enables (next session)",
				);
				return "handled";
			}
			if (ctx.mcp === undefined) {
				const paths = mcpConfigPaths({ cwd: ctx.runner.runnerCwd });
				ctx.renderer.note(`▪ no MCP servers configured (looked in: ${paths.join(", ")})`);
				return "handled";
			}
			for (const line of ctx.mcp.statusLines()) {
				if (line.status === "connected") {
					ctx.renderer.writeLine(
						`  ${line.name}: connected · ${line.tools} tool${line.tools === 1 ? "" : "s"}`,
					);
				} else if (line.status === "failed" && line.error !== null) {
					ctx.renderer.writeLine(`  ${line.name}: failed · ${line.error}`);
				} else {
					ctx.renderer.writeLine(`  ${line.name}: ${line.status}`);
				}
			}
			return "handled";
		},
	},
	{
		name: "settings",
		usage: "/settings [key]",
		summary: "view or change settings (scope: global|project)",
		allowedDuringRun: false,
		run: async (args, ctx): Promise<CommandOutcome> => {
			return runSettingsCommand(args, ctx);
		},
	},
	{
		name: "copy",
		summary: "copy the last agent message to the clipboard",
		allowedDuringRun: true,
		// pi parity: the source is the LIVE history tail — a message that is
		// still streaming mid-run is NOT copied (we walk finished entries),
		// but /copy stays available during a run because "grab what it said
		// so far" is a read-only operation.
		run: async (_args, ctx): Promise<CommandOutcome> => {
			// runner.history is the live array — walk it in reverse for the
			// last assistant message with text (skips tool-call-only turns).
			const history = ctx.runner.history;
			for (let i = history.length - 1; i >= 0; i--) {
				const message = history[i];
				if (message === undefined || message.role !== "assistant") continue;
				// thinking blocks stay out — pi's getLastAssistantText is the
				// message TEXT, what the user reads on screen
				const text = message.blocks
					.filter((block): block is Extract<AssistantBlock, { type: "text" }> => block.type === "text")
					.map((block) => block.text)
					.join("")
					.trim();
				if (text === "") continue;
				const write = ctx.copyText ?? ((value: string) => copyToClipboard(value));
				try {
					await write(text);
					ctx.renderer.status("Copied last agent message to clipboard");
				} catch (error) {
					ctx.renderer.error(`imp: ${error instanceof Error ? error.message : String(error)}`);
				}
				return "handled";
			}
			ctx.renderer.error("No agent messages to copy yet.");
			return "handled";
		},
	},
	{
		name: "name",
		summary: "name this session (shows in /sessions)",
		allowedDuringRun: false,
		// Names are session-tree metadata: mid-run would interleave with the
		// turn's own appends — pi also treats /name as an idle command.
		run: (args, ctx): CommandOutcome => {
			const session = ctx.runner.session;
			if (!session) {
				ctx.renderer.error("imp: /name needs a session — restart without --no-session");
				return "handled";
			}
			const trimmed = args.trim();
			if (trimmed === "") {
				const current = session.getSessionName();
				if (current) ctx.renderer.note(`▪ session name: ${current}`);
				else ctx.renderer.note("▪ no session name — /name <name> sets one");
				return "handled";
			}
			// pi parity: [\r\n]+ collapses to a space, outer whitespace
			// trims; the user is told when their text was normalized
			// (M16 review P1-2 — the comment used to claim this without the
			// note actually existing).
			const sanitized = trimmed.replace(/[\r\n]+/g, " ").trim();
			if (sanitized === "-") {
				// M16 review P1-3: the store's "empty name clears" semantic
				// was unreachable from the REPL (parseCommand trims args, so
				// whitespace-only never got here) — "-" is the explicit
				// affordance for it.
				session.appendSessionName("");
				ctx.renderer.status("Session name cleared");
				return "handled";
			}
			if (sanitized !== trimmed) {
				ctx.renderer.note(`▪ newlines collapsed: ${sanitized}`);
			}
			session.appendSessionName(sanitized);
			ctx.renderer.status(`Session name set: ${sanitized}`);
			return "handled";
		},
	},
	{
		name: "compact",
		summary: "summarize older context now",
		allowedDuringRun: false,
		run: async (_args, ctx): Promise<CommandOutcome> => {
			if (!ctx.runner.session) {
				ctx.renderer.error("imp: /compact needs a session — restart without --no-session");
				return "handled";
			}
			ctx.renderer.note("▪ compacting…");
			await ctx.runner.compactNow(); // banners come from the runner (compacted / nothing)
			return "handled";
		},
	},
];

export async function dispatchCommand(
	line: string,
	ctx: CommandContext,
	extraCommands?: readonly RegisteredExtensionCommand[],
): Promise<CommandOutcome> {
	const parsed = parseCommand(line);
	if (parsed === null) return "handled"; // not a command — caller never sends these
	const extras = extraCommands ?? [];
	// Built-ins resolve first; built-in names are reserved (design §9), so the
	// order only fixes which listing wins a collision — first registration does.
	const command =
		COMMANDS.find((c) => c.name === parsed.name) ??
		extras.find((e) => e.command.name === parsed.name)?.command;
	if (command === undefined) {
		// Teaching-style error (project convention); never sent to the model.
		ctx.renderer.error(`imp: unknown command "/${parsed.name}"`);
		const known = [...COMMANDS, ...extras]
			.map(entryName)
			.map((name) => `/${name}`)
			.join(" ");
		ctx.renderer.writeLine(`known: ${known} — /help shows what they do`);
		return "handled";
	}
	if (command.name === "help") {
		// Built-in /help renders through helpText so extension commands are
		// listed (design §8.2): run() has no path to the extras and
		// CommandContext stays unchanged — the COMMANDS entry remains the
		// built-in listing source of record; help is allowedDuringRun, so
		// intercepting right after resolution is behavior-identical.
		ctx.renderer.writeLine(helpText(extras, (tag) => ctx.renderer.dim(tag)));
		return "handled";
	}
	if (!command.allowedDuringRun && ctx.isActive()) {
		ctx.renderer.error(
			`imp: /${command.name} waits for the running turn — press Ctrl+C to abort it first, then /${command.name}`,
		);
		return "handled";
	}
	return command.run(parsed.args, ctx);
}
