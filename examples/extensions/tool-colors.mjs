/** #tool-name-colors: the owner's tool-name theme.
 *
 * Link or copy this file into `~/.imp/extensions/` to switch it on — with
 * no theme extension nothing is colored (the pre-#tool-name-colors look).
 *
 * The palette: the seven built-in tools (bash, read, edit, write, grep,
 * find, ls) share one dark orange — Claude's brand color `#d97757`
 * (truecolor; an absolute color does NOT follow the terminal theme on
 * purpose). `task` keeps the theme-relative bright cyan so it stays the one
 * hue that tracks your terminal. The two web-search tools take a warm
 * beige. Edit freely: any of the 16 named tokens (`black` … `brightWhite`,
 * theme-relative), `"none"` (bold-only), or an absolute token —
 * `#rrggbb` (truecolor) or `ansi256:N` (0-255; the portable choice).
 * `"*"` is the fallback for every tool without an exact registration;
 * exact names beat the wildcard.
 *
 * @param {import("../../src/extensions/types.js").ExtensionApi} api
 */
export default function (api) {
	for (const tool of ["bash", "read", "edit", "write", "grep", "find", "ls"]) {
		api.registerToolColor(tool, "#d97757"); // Claude brand orange (absolute)
	}
	api.registerToolColor("task", "brightCyan"); // theme-relative by choice
	api.registerToolColor(["web_search", "url_read"], "#e6dcc3"); // warm beige
}
