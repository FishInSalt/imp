import { homedir } from "node:os";
import { estimateContextTokens } from "../core/compaction.js";
import type { SessionStore } from "../core/session/store.js";
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
import {
	type ApiKeyFamily,
	clearApiKey,
	loadApiKey,
	saveApiKey,
	storedApiKeyFamilies,
} from "../provider/auth-store.js";
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
import type { SelectOptions } from "./line-input.js";

export interface CommandContext {
	runner: Runner;
	renderer: Renderer;
	isActive: () => boolean; // running || compacting
	requestExit(code: number): void; // graceful path
	abortActive(): boolean; // abort controller if active
	/** Replay a session's history on screen (wired in repl.ts; records in tests). */
	replay(session: SessionStore): number;
	/** Submit a prompt as if typed — used by markdown quick commands (M11 #6).
	 *  Idle starts a turn; a running turn queues it. Wired by repl.ts; test
	 *  environments inject a recorder. Injection-surface note (review): the
	 *  full ctx is handed to EVERY command run() — extension commands can
	 *  call this too; extensions are arbitrary code by contract, so this
	 *  adds no new capability, only a documented one. */
	submitPrompt(text: string): void;
	/** TUI shells only: wipe transcript + folds. /new calls it BEFORE
	 *  newSession so the "▪ new session" note lands on the fresh screen
	 *  (debt clearance); wired in repl.ts, absent in test recorders unless
	 *  injected. */
	clearView?: () => void;
	/** Repaint the TUI footer (wired in repl.ts; /think changes its level
	 *  segment). Absent in test recorders unless injected. */
	refreshFooter?: () => void;
	/** Item picker, bound in repl.ts ONLY when the input shell implements it
	 *  (TuiShell; the readline shell has none). Commands must keep a text
	 *  fallback for a missing select. Resolves the chosen index, or null on
	 *  cancel. */
	select?: (options: SelectOptions) => Promise<number | null>;
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
  follow-up          Alt+Enter queues the line to run AFTER the running turn
                     (plain Enter steers into it)
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

export interface ModelListDeps {
	/** Families that currently hold a credential. */
	configured: (family: "anthropic" | "openai" | "openai-codex" | "zai") => boolean;
	/** Endpoint listing, null when unreachable — injectable for tests. */
	discover: (family: "anthropic" | "openai" | "openai-codex" | "zai") => Promise<string[] | null>;
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
			const discovered = await deps.discover(family);
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
				fallbackNotes.push(familyLabel(`${family}/`));
				ids.push(...(FAMILY_FALLBACKS[family] ?? []));
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
			const { retained, abandoned, preview } = ctx.runner.forkSessionAt(entryId);
			ctx.clearView?.(); // the abandoned tail leaves the screen FIRST
			const session = ctx.runner.session;
			if (session !== null && retained > 0) ctx.replay(session); // same flow as /resume
			ctx.renderer.note(
				`▪ forked before “${preview}” — ${retained} message${retained === 1 ? "" : "s"} kept, ${abandoned} left on the old branch (/tree switches back)`,
			);
			return "handled";
		},
	},
	{
		name: "tree",
		summary: "switch to another branch of this conversation (the left one is summarized in)",
		allowedDuringRun: false,
		run: async (args, ctx): Promise<CommandOutcome> => {
			const tips = ctx.runner.branchTips();
			if (tips.length === 0) {
				ctx.renderer.note("▪ only one branch — /fork creates others");
				return "handled";
			}
			const trimmed = args.trim();
			let tipId: string | undefined;
			if (/^[1-9]\d*$/.test(trimmed)) {
				const target = tips[Number(trimmed) - 1];
				if (target === undefined) {
					ctx.renderer.error(`imp: /tree ${trimmed} — the list runs #1–#${tips.length}`);
					return "handled";
				}
				tipId = target.id;
			} else if (trimmed !== "") {
				ctx.renderer.error(
					"imp: /tree takes no text — /tree opens the picker, /tree <n> switches to branch #n",
				);
				return "handled";
			} else if (ctx.select !== undefined) {
				const pick = await ctx.select({
					title: "Switch to which branch? (the current one is summarized into the new context)",
					items: tips.map((t, i) => ({
						label: t.label,
						description: `#${i + 1} · ${t.count} message${t.count === 1 ? "" : "s"}`,
					})),
					filterable: true,
				});
				if (pick === null) return "handled"; // cancelled
				tipId = tips[pick]?.id;
			} else {
				ctx.renderer.writeLine(ctx.renderer.dim("switch to which branch?"));
				tips.forEach((t, i) => {
					ctx.renderer.writeLine(
						ctx.renderer.dim(`  #${i + 1} · ${t.count} message${t.count === 1 ? "" : "s"} `) + t.label,
					);
				});
				ctx.renderer.note(`▪ pick with /tree <n> (1–${tips.length})`);
				return "handled";
			}
			if (tipId === undefined) return "handled"; // unreachable; type guard
			// Progress feedback BEFORE the potentially 5-20s summarizer await —
			// the state machine holds input in the queue meanwhile (review P2-1).
			ctx.renderer.note("▪ switching branches…");
			const { summary, messages } = await ctx.runner.switchSessionBranch(tipId);
			ctx.clearView?.();
			const session = ctx.runner.session;
			if (session !== null && messages > 0) ctx.replay(session);
			const tail =
				summary === "written"
					? "the left one is summarized in context"
					: summary === "empty"
						? "nothing was written on the left branch to summarize"
						: summary === "disabled"
							? "summary off — IMP_BRANCH_SUMMARY=0"
							: "summarizer failed — see imp-log; switched without it";
			ctx.renderer.note(`▪ switched branches — ${messages} messages here (${tail})`);
			return "handled";
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
				const { rows, fallbackNotes } = await buildModelList(ctx.runner.modelReference(), {
					configured: familyConfigured,
					discover: discoverModels,
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
						"▪ merge from the repo root: " + unmerged.map((e) => `git merge ${e.branch}`).join("; "),
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
				ctx.renderer.note(
					`▪ session ${session.header.id.slice(0, 8)} · ${stats.messageCount} msgs · in ${formatTokens(stats.inputTokens)} / out ${formatTokens(stats.outputTokens)} cumulative`,
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
