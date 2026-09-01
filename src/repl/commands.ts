import type { RegisteredExtensionCommand } from "../extensions/types.js";
import type { Runner } from "../runner.js";
import type { Renderer } from "./render.js";

export interface CommandContext {
	runner: Runner;
	renderer: Renderer;
	isActive: () => boolean; // running || compacting
	requestExit(code: number): void; // graceful path
	abortActive(): boolean; // abort controller if active
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
		name: "model",
		usage: "/model [id]",
		summary: "show the current model, or switch (applies next turn)",
		allowedDuringRun: true,
		run: (args, ctx) => {
			if (args === "") {
				ctx.renderer.writeLine(`model: ${ctx.runner.model}`);
				ctx.renderer.writeLine(
					"switch with: /model <id> — e.g. claude-sonnet-4-5, glm-4.6 (any id your endpoint accepts)",
				);
				return "handled";
			}
			const previous = ctx.runner.model;
			const id = args.trim();
			if (/\s/.test(id)) {
				throw new Error(`/model takes one id — got extra text. Usage: /model <id>, e.g. /model glm-4.6`);
			}
			ctx.runner.model = id;
			ctx.renderer.note(`▪ model: ${previous} → ${id} (applies from the next turn)`);
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
