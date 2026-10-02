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

/** #tool-name-colors A2: absolute-color tokens — a 256-palette index or a
 *  truecolor hex. The template forms are DX-only (they also admit
 *  `ansi256:007`, `-1`, `1.5`, `1e3`, `#gggggg`, `#`); `isToolColor` is the
 *  runtime authority. */
export type ToolColorAbsolute = `ansi256:${number}` | `#${string}`;
export type ToolColor = ToolColorName | ToolColorAbsolute;

const ANSI256_PATTERN = /^ansi256:(0|[1-9][0-9]{0,2})$/;
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isToolColorAbsolute(value: unknown): value is ToolColorAbsolute {
	if (typeof value !== "string") return false;
	const match = ANSI256_PATTERN.exec(value);
	if (match !== null) return Number(match[1]) <= 255;
	return HEX_PATTERN.test(value);
}

/** Full-set membership: the 16 names + `none` + absolute tokens. Every
 *  boundary (registry validation, SGR mapping) gates on this. */
export function isToolColor(value: unknown): value is ToolColor {
	return isToolColorName(value) || isToolColorAbsolute(value);
}

/** Canonical stored form: hex lowercased, everything else verbatim (A2) —
 *  called by `registerToolColor` after the `isToolColor` check. */
export function canonicalToolColor(color: ToolColor): ToolColor {
	return color.startsWith("#") ? (color.toLowerCase() as ToolColor) : color;
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
 *  Named tokens keep the exact Map bytes; absolute tokens are re-validated
 *  before parsing (hex case-insensitively, regardless of stored form), and
 *  anything out of contract fails closed to `""` — never `Object.prototype`
 *  members or `undefined` (A2). */
export function toolColorSgr(token: ToolColor): string {
	if (typeof token !== "string") return ""; // defense in depth: Symbol would throw in exec
	const named = TOOL_COLOR_SGR.get(token);
	if (named !== undefined) return named;
	const match = ANSI256_PATTERN.exec(token);
	if (match !== null) {
		const index = Number(match[1]);
		return index <= 255 ? `\u001b[38;5;${index}m` : "";
	}
	if (HEX_PATTERN.test(token)) {
		const r = Number.parseInt(token.slice(1, 3), 16);
		const g = Number.parseInt(token.slice(3, 5), 16);
		const b = Number.parseInt(token.slice(5, 7), 16);
		return `\u001b[38;2;${r};${g};${b}m`;
	}
	return "";
}

/** The composed resolver (design D2/D5; Amendment 1): extension
 *  registrations only — exact lookup then `*`, both inside the registry —
 *  and `undefined` for everything else (no token, no color). `registry` is
 *  structurally typed; repl.ts passes the ExtensionRegistry, unit hosts
 *  may pass any map-shaped stub. */
export function composeToolColorResolver(registry?: {
	toolColorFor(name: string): ToolColor | undefined;
}): (name: string) => ToolColor | undefined {
	return (name) => registry?.toolColorFor(name);
}
