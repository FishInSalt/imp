/** #tool-name-colors: the owner's tool-name theme.
 *
 * Link or copy this file into `~/.ink/extensions/` to switch it on — with
 * no theme extension nothing is colored (the pre-#tool-name-colors look).
 *
 * Two tiers exist (Amendment 3): a tool's own extension can *suggest* a
 * default (`api.suggestToolColor`), and a theme *registers* the user's
 * decision (`api.registerToolColor`, used here) — any user registration
 * beats any suggestion (user exact > user `"*"` > suggested exact >
 * suggested `"*"`). The web-search tools take their warm beige from the
 * web-search extension's own suggestion; this file decides the built-ins.
 *
 * The palette below: the seven built-in tools (bash, read, edit, write,
 * grep, find, ls) share one dark orange — Claude's brand color `#d97757`
 * (truecolor; absolute colors deliberately do NOT follow the terminal
 * theme). `task` keeps the theme-relative bright cyan so it stays the one
 * hue that tracks your terminal. Edit freely: any of the 16 named tokens
 * (`black` … `brightWhite`, theme-relative), `"none"` (bold-only), or an
 * absolute token — `#rrggbb` (truecolor) or `ansi256:N` (0-255; the
 * portable choice). `"*"` is the fallback for every tool without an exact
 * registration; exact names beat the wildcard.
 *
 * @param {import("../../src/extensions/types.js").ExtensionApi} api
 */
export default function (api) {
	for (const tool of ["bash", "read", "edit", "write", "grep", "find", "ls"]) {
		api.registerToolColor(tool, "#d97757"); // Claude brand orange (absolute)
	}
	api.registerToolColor("task", "brightCyan"); // theme-relative by choice
}
