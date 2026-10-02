/** #tool-name-colors: the owner's tool-name theme.
 *
 * Link or copy this file into `~/.imp/extensions/` to switch it on — with
 * no theme extension nothing is colored (the pre-#tool-name-colors look).
 * The pairs below are the preference palette: exec yellow, reads blue,
 * writes magenta, search cyan, and the task call on its own bright magenta
 * slot. Edit freely: any of the 16 standard-16 tokens (`black` …
 * `brightWhite`) or `"none"` (bold-only, overriding another registration);
 * `"*"` is the fallback for every tool without an exact registration, and
 * exact names beat the wildcard. Colors follow your terminal theme.
 *
 * @param {import("../../src/extensions/types.js").ExtensionApi} api
 */
export default function (api) {
	api.registerToolColor("bash", "yellow"); // exec
	api.registerToolColor(["read", "ls"], "blue"); // reads
	api.registerToolColor(["edit", "write"], "magenta"); // writes
	api.registerToolColor(["grep", "find"], "cyan"); // search
	api.registerToolColor("task", "brightMagenta"); // the subagent's own slot
}
