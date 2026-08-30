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

/** Generated from COMMANDS so the list cannot drift. */
function helpText(): string {
	const lines = ["Commands:"];
	for (const command of COMMANDS) {
		const label = command.usage ?? `/${command.name}`;
		lines.push(`  ${label.padEnd(19)}${command.summary}`);
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
				throw new Error(
					`/model takes one id — got extra text. Usage: /model <id>, e.g. /model glm-4.6`,
				);
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

export async function dispatchCommand(line: string, ctx: CommandContext): Promise<CommandOutcome> {
	const parsed = parseCommand(line);
	if (parsed === null) return "handled"; // not a command — caller never sends these
	const command = COMMANDS.find((c) => c.name === parsed.name);
	if (command === undefined) {
		// Teaching-style error (project convention); never sent to the model.
		ctx.renderer.error(`imp: unknown command "/${parsed.name}"`);
		ctx.renderer.writeLine(
			`known: ${COMMANDS.map((c) => `/${c.name}`).join(" ")} — /help shows what they do`,
		);
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
