// examples/extensions/notify.mjs — macOS completion notification: sound + popup.
//
// Install: copy into <project>/.imp/extensions/ (or ~/.imp/extensions/) and
// restart imp. When a run finishes you get a Glass sound and a notification
// popup with the turn count — useful when you context-switch away while imp
// grinds through a long task.
//
// Env:
//   IMP_NOTIFY_MIN_SEC  only notify for runs lasting at least this many
//                       seconds (default 5 — quick Q&A stays silent)
//   IMP_NOTIFY_DRY      test hook: a file path; when set, notification
//                       payloads are appended as JSON lines instead of
//                       spawning osascript/afplay (no popups, no sound)
//
// Timing model: the run starts at its FIRST message_end (an assistant message
// completing) and ends at run_end. Runs that die before any assistant message
// (provider failure) never notify — nothing happened worth announcing.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	const minSec = Number(process.env.IMP_NOTIFY_MIN_SEC ?? "5") || 0;
	const dryPath = process.env.IMP_NOTIFY_DRY ?? "";
	let startedAt = null; // first message_end of the run currently in flight

	api.on("message_end", () => {
		if (startedAt === null) startedAt = Date.now();
	});

	api.on("run_end", (event) => {
		const start = startedAt;
		startedAt = null;
		if (start === null) return; // no assistant message this run — skip
		if ((Date.now() - start) / 1000 < minSec) return;

		const title = `imp — ${event.stopReason}`;
		const body = `${event.turns} turns · out ${event.usage.outputTokens} tokens`;
		if (dryPath) {
			appendFileSync(dryPath, `${JSON.stringify({ title, body })}\n`);
			return;
		}
		// Fire-and-forget; stdio ignored; spawn errors swallowed (a notification
		// must never take the host down — extension isolation would catch it,
		// but silence is kinder than a diagnostic for a missing sound file).
		spawn("osascript", ["-e", `display notification "${body}" with title "${title}"`], {
			stdio: "ignore",
		}).on("error", () => {});
		spawn("afplay", ["/System/Library/Sounds/Glass.aiff"], { stdio: "ignore" }).on("error", () => {});
	});
}
