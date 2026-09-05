// examples/extensions/guardian.mjs — a rule-based permission gate (M4 design §13.1).
//
// Install: copy this file into <project>/.imp/extensions/ (or ~/.imp/extensions/)
// and restart imp. A startup line confirms it loaded:
//
//   ▪ extension guardian [project] — 2 hooks
//
// Guardian watches every tool call before it executes and blocks the ones that
// match a small list of destructive patterns — rm -rf style deletes, force
// pushes, fork bombs, `curl … | sh` shapes, sudo — plus write/edit paths
// outside the project directory. A block is NOT a crash and NOT a dead end:
// the model receives a teaching-style reason (what to do instead) as its tool
// result, and the run continues. Every blocked/error result also appends one
// audit line to ~/.imp/guardian.log; subagent calls are marked there as
// `child` / `child:<agent>` so vetoes on delegated work stand out.
//
// Non-interactive by design: M4 has no ui.confirm (there is no TUI to confirm
// in), and reading stdin directly would fight the REPL's readline. Interactive
// gating is the motivating case for M5's UI contribution point — do not "fix"
// this file into prompting.
//
// Configuration: IMP_GUARDIAN_BLOCK="regex1,regex2" adds custom bash-command
// patterns (comma-separated regex sources). An invalid pattern is skipped, not
// fatal — a gate that died on bad config would be worse than a missing rule.
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** One audit line per entry, capped like imp's own diagnostics. */
const firstLine = (text) => {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	const rules = [
		{
			test: /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
			reason:
				"recursive force delete — list the files that would go and ask first, or delete the specific files one by one",
		},
		{
			test: /\bgit\s+push\b[^\n]*--force(?!\s*-with-lease)/,
			reason:
				"force push rewrites shared history — push normally, or coordinate the rewrite with the team first (--force-with-lease is the guarded variant)",
		},
		{
			test: /\S*\(\)\s*\{[^}]*\|[^}]*&/,
			reason: "fork bomb — it spawns until the machine dies; remove the self-replicating loop",
		},
		{
			test: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
			reason: "piping a download straight into a shell — download to a file, read it, then run it deliberately",
		},
		{
			test: /(?:^|[\s;&|])sudo\b/,
			reason: "running as root — do it as the normal user, or hand the privileged step to the human",
		},
	];
	for (const source of (process.env.IMP_GUARDIAN_BLOCK ?? "").split(",")) {
		const trimmed = source.trim();
		if (trimmed === "") continue;
		try {
			rules.push({
				test: new RegExp(trimmed),
				reason: `matched your IMP_GUARDIAN_BLOCK pattern ${trimmed} — adjust the env var if this should run`,
			});
		} catch {
			// invalid regex source: skip the rule, keep the gate standing
		}
	}

	const insideProject = (target) => {
		const resolved = path.resolve(api.cwd, target);
		return resolved === api.cwd || resolved.startsWith(`${api.cwd}${path.sep}`);
	};

	// 1/2 — the gate: observe every validated call; veto the dangerous ones.
	api.on("tool_call", (event) => {
		if (event.name === "bash" && typeof event.args.command === "string") {
			const rule = rules.find((r) => r.test.test(event.args.command));
			if (rule) return { block: true, reason: rule.reason };
		}
		if ((event.name === "write" || event.name === "edit") && typeof event.args.path === "string") {
			if (!insideProject(event.args.path)) {
				return {
					block: true,
					reason: `writing outside the project directory (${api.cwd}) — keep changes inside it, or hand files beyond the project to the human`,
				};
			}
		}
	});

	// 2/2 — the audit trail: one line per blocked/error result, never fatal.
	// Subagent calls are marked [tool child] / [tool child:agent] so the log
	// shows WHO was vetoed, not just what (M6a event fields).
	const logFile = path.join(os.homedir(), ".imp", "guardian.log");
	api.on("tool_end", (event) => {
		if (!event.isError) return;
		const who = event.subagent ? ` child${event.agent ? `:${event.agent}` : ""}` : "";
		try {
			mkdirSync(path.dirname(logFile), { recursive: true });
			appendFileSync(logFile, `${new Date().toISOString()} [${event.name}${who}] ${firstLine(event.output)}\n`);
		} catch {
			// an observer must never break the host
		}
	});
}
