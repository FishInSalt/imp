/** #tool-name-colors (design D1/D3; Amendment 1): the closed token set for
 *  tool-name colors and the one place a token becomes SGR bytes. There are
 *  NO shipped default colors — extensions are the only source, so without
 *  one every call header renders the pre-#tool-name-colors bytes.
 *  Importable by both `extensions/` (API validation, registry storage) and
 *  `repl/` (rendering) — same dependency direction as `repl/commands.js`,
 *  which the registry already imports. */

/** The 16 standard-16 color tokens (theme-relative on purpose — the hues
 *  follow the user's terminal theme) plus `none`: an explicit opt-out that
 *  overrides another registration for the same name and renders the name
 *  bold-only. */
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

const TOOL_COLOR_SGR = new Map<string, string>([
	["black", "\u001b[30m"],
	["red", "\u001b[31m"],
	["green", "\u001b[32m"],
	["yellow", "\u001b[33m"],
	["blue", "\u001b[34m"],
	["magenta", "\u001b[35m"],
	["cyan", "\u001b[36m"],
	["white", "\u001b[37m"],
	["gray", "\u001b[90m"],
	["brightRed", "\u001b[91m"],
	["brightGreen", "\u001b[92m"],
	["brightYellow", "\u001b[93m"],
	["brightBlue", "\u001b[94m"],
	["brightMagenta", "\u001b[95m"],
	["brightCyan", "\u001b[96m"],
	["brightWhite", "\u001b[97m"],
	["none", ""],
]);

/** Token → SGR bytes; `none` maps to the empty string (bold-only name).
 *  Keyed through a Map so an out-of-contract token (a buggy resolver) fails
 *  closed to bold-only — never `Object.prototype` members or `undefined`. */
export function toolColorSgr(token: ToolColorName): string {
	return TOOL_COLOR_SGR.get(token) ?? "";
}

/** The composed resolver (design D2/D5; Amendment 1): extension
 *  registrations only — exact lookup then `*`, both inside the registry —
 *  and `undefined` for everything else (no token, no color). `registry` is
 *  structurally typed; repl.ts passes the ExtensionRegistry, unit hosts
 *  may pass any map-shaped stub. */
export function composeToolColorResolver(registry?: {
	toolColorFor(name: string): ToolColorName | undefined;
}): (name: string) => ToolColorName | undefined {
	return (name) => registry?.toolColorFor(name);
}
