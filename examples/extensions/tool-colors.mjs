/** #tool-name-colors: a theme example for the tool-name palette.
 *
 * Copy this file (or link it) into `~/.imp/extensions/` and edit the pairs —
 * tool names in the TUI call header take the chosen color. `"*"` is the
 * fallback for every tool without an exact registration; `"none"` leaves the
 * name bold-only (it also overrides a shipped default). Colors are the 16
 * standard-16 tokens (`black` … `brightWhite`) and follow your terminal
 * theme, unlike fixed 256-color values.
 *
 * @param {import("../../src/extensions/types.js").ExtensionApi} api
 */
export default function (api) {
	// A brighter variant of the shipped exec hue.
	api.registerToolColor("bash", "brightYellow");
	// Reads and writes get the same hues as the defaults, one step brighter.
	api.registerToolColor(["read", "ls"], "brightBlue");
	api.registerToolColor(["edit", "write"], "brightMagenta");
	// This theme's agent hue — task keeps its own slot.
	api.registerToolColor("task", "brightCyan");
	// Uncomment to tint everything else (exact registrations above still win):
	// api.registerToolColor("*", "blue");
}
