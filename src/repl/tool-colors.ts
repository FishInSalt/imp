/** #tool-name-colors (design D1/D3): the closed token set for tool-name
 *  colors, the shipped default palette, and the one place a token becomes
 *  SGR bytes. Importable by both `extensions/` (API validation, registry
 *  storage) and `repl/` (rendering) — same dependency direction as
 *  `repl/commands.js`, which the registry already imports. */

/** The 16 standard-16 color tokens (theme-relative on purpose — the hues
 *  follow the user's terminal theme) plus `none`: an explicit opt-out that
 *  overrides a default palette entry and renders the name bold-only. */
export const TOOL_COLOR_NAMES = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"gray",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
	"none",
] as const;

export type ToolColorName = (typeof TOOL_COLOR_NAMES)[number];

const TOOL_COLOR_SET: ReadonlySet<string> = new Set(TOOL_COLOR_NAMES);

/** Closed-set membership check (`none` included). */
export function isToolColorName(value: unknown): value is ToolColorName {
	return typeof value === "string" && TOOL_COLOR_SET.has(value);
}

const TOOL_COLOR_SGR: Record<ToolColorName, string> = {
	black: "\u001b[30m",
	red: "\u001b[31m",
	green: "\u001b[32m",
	yellow: "\u001b[33m",
	blue: "\u001b[34m",
	magenta: "\u001b[35m",
	cyan: "\u001b[36m",
	white: "\u001b[37m",
	gray: "\u001b[90m",
	brightRed: "\u001b[91m",
	brightGreen: "\u001b[92m",
	brightYellow: "\u001b[93m",
	brightBlue: "\u001b[94m",
	brightMagenta: "\u001b[95m",
	brightCyan: "\u001b[96m",
	brightWhite: "\u001b[97m",
	none: "",
};

/** Token → SGR bytes; `none` maps to the empty string (bold-only name). */
export function toolColorSgr(token: ToolColorName): string {
	return TOOL_COLOR_SGR[token];
}

/** The shipped default palette (design D3): category slots, red/green left
 *  to the ✓/✗ semantics, `task` the only bright hue. Unknown tools get no
 *  entry — they render bold-only (today's bytes), never a guessed color. */
export const DEFAULT_TOOL_COLORS: Readonly<Record<string, ToolColorName>> = {
	bash: "yellow",
	read: "blue",
	ls: "blue",
	edit: "magenta",
	write: "magenta",
	grep: "cyan",
	find: "cyan",
	task: "brightMagenta",
};
