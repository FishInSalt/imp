import { homedir } from "node:os";
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
	/** Item picker, bound in repl.ts ONLY when the input shell implements it
	 *  (TuiShell; the readline shell has none). Commands must keep a text
	 *  fallback for a missing select. Resolves the chosen index, or null on
	 *  cancel. */
	select?: (options: SelectOptions) => Promise<number | null>;
	/** M8 trust store location — hermetic tests inject a temp path. */
	trustStorePath?: string;
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
  Ctrl+D             exit
  Ctrl+O             expand/collapse the newest diff fold
  while a picker is open:
    ↑/↓              move the selection
    Enter            pick · Esc or Ctrl+C cancels (no interrupt)
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
const MODEL_CANDIDATES: readonly string[] = ["claude-sonnet-4-5", "glm-4.6", "glm-4.5", "glm-4.7"];

function modelCandidates(current: string): string[] {
	return MODEL_CANDIDATES.includes(current) ? [...MODEL_CANDIDATES] : [current, ...MODEL_CANDIDATES];
}

/** The switch itself, shared by "/model <id>" and the picker's pick — the
 *  write and the note are byte-identical whichever way the id arrived. */
function switchModel(ctx: CommandContext, id: string): void {
	const previous = ctx.runner.model;
	ctx.runner.model = id;
	ctx.renderer.note(`▪ model: ${previous} → ${id} (applies from the next turn)`);
}

/** /resume <id>'s body, shared by the by-arg path and the picker's pick — the
 *  resume, replay, and note are byte-identical whichever way the id arrived. */
function resumeById(ctx: CommandContext, id: string): CommandOutcome {
	try {
		const { id8, messages } = ctx.runner.resumeSession(id);
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
			ctx.runner.newSession();
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
					ctx.renderer.writeLine(`model: ${ctx.runner.model}`);
					ctx.renderer.writeLine(
						"switch with: /model <id> — e.g. claude-sonnet-4-5, glm-4.6 (any id your endpoint accepts)",
					);
					return "handled";
				}
				// TUI shell: a pick behaves exactly like /model <id> on the chosen
				// row; cancelling changes nothing and notes nothing.
				const candidates = modelCandidates(ctx.runner.model);
				const index = await select({
					title: "models — switch applies from the next turn",
					items: candidates.map((id) => ({
						label: id,
						description: id === ctx.runner.model ? "current" : undefined,
					})),
				});
				const id = index === null ? undefined : candidates[index];
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
