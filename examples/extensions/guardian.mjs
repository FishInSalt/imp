// examples/extensions/guardian.mjs — a rule-based permission gate (M4 design §13.1).
//
// Install: copy this file into <project>/.imp/extensions/ (or ~/.imp/extensions/)
// and restart imp. A startup line confirms it loaded:
//
//   ▪ extension guardian [project] — 2 hooks
//
// Guardian watches every tool call before it executes and gates the ones that
// match a small list of risky patterns — rm -rf style deletes, force pushes,
// fork bombs, `curl … | sh` shapes, sudo — plus write/edit paths outside the
// caller's working directory. Gating is two-tier:
//
//   • hard floor — targets under /etc, ~/.ssh, ~/.gnupg, and `rm -rf` aimed
//     at a home directory root itself are denied outright, no questions;
//   • ask-first — everything else on the risky list goes through
//     api.confirm: an approved call runs, a declined one returns the same
//     teaching reason the old hard block did. Hosts without an interactive
//     prompt (print mode, tests) resolve confirm as false, so guardian
//     degrades exactly to the old always-block behavior there.
//
// Paths resolve against the CALLER's working directory (event.cwd, M6b): a
// worktree child writing an absolute path inside its own worktree is not
// "outside the project" — that false positive is why event.cwd exists.
//
// A block is NOT a crash and NOT a dead end: the model receives a
// teaching-style reason (what to do instead) as its tool result, and the run
// continues. Every blocked/error result also appends one audit line to
// ~/.imp/guardian.log; subagent calls are marked there as `child` /
// `child:<agent>` so vetoes on delegated work stand out.
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

	// The hard floor: never asks, always denies.
	const home = os.homedir();
	const hardFloors = ["/etc", path.join(home, ".ssh"), path.join(home, ".gnupg")];
	const floorOf = (resolved) => {
		for (const floor of hardFloors) {
			if (resolved === floor || resolved.startsWith(`${floor}${path.sep}`)) return floor;
		}
		return undefined;
	};
	const floorReason = (floor) =>
		`[guardian] ${floor} is protected — this rule never asks; make the change yourself or hand it to the human`;

	// Caller cwd (M6b): the loop about to execute the call. A worktree child
	// resolves against its worktree, not the parent project — absolute
	// worktree paths stop tripping the outside-project rule.
	const callerCwd = (event) => event.cwd ?? api.cwd;
	const insideDir = (target, dir) => {
		const resolved = path.resolve(dir, target);
		return resolved === dir || resolved.startsWith(`${dir}${path.sep}`);
	};

	/** Path-ish arguments of every `rm` in the command (flags skipped, surrounding quotes stripped) — heuristic, fail-closed by the caller. */
	const rmTargets = (command) => {
		const targets = [];
		for (const segment of command.split(/[;&|]/)) {
			const words = segment.trim().split(/\s+/);
			const at = words.indexOf("rm");
			if (at === -1) continue;
			for (const word of words.slice(at + 1)) {
				if (word.startsWith("-")) continue; // flags, incl. combined -rf
				targets.push(word.replace(/^["']|["']$/g, ""));
			}
		}
		return targets;
	};

	/** The rm hard floor: any rm aimed at a home-directory root itself, or at anything under a protected dir. */
	const rmFloor = (command, cwd) => {
		for (const target of rmTargets(command)) {
			if (target === "~" || target === "~/" || target === "$HOME" || target === "${HOME}") return home;
			const resolved = path.resolve(cwd, target);
			if (resolved === home) return home;
			const floor = floorOf(resolved);
			if (floor !== undefined) return floor;
		}
		return undefined;
	};

	// 1/2 — the gate: observe every validated call; floor-deny, ask, or pass.
	api.on("tool_call", async (event) => {
		if (event.name === "bash" && typeof event.args.command === "string") {
			const command = event.args.command;
			const cwd = callerCwd(event);
			const floor = rmFloor(command, cwd);
			if (floor !== undefined) return { block: true, reason: floorReason(floor) };
			const rule = rules.find((r) => r.test.test(command));
			if (rule) {
				const approved = await api.confirm("[guardian] allow this bash command?", `${command}\nwhy it matched: ${rule.reason}`);
				if (approved) return undefined; // the human said yes — run it
				return { block: true, reason: rule.reason }; // declined: same teaching text as before
			}
		}
		if ((event.name === "write" || event.name === "edit") && typeof event.args.path === "string") {
			const cwd = callerCwd(event);
			const floor = floorOf(path.resolve(cwd, event.args.path));
			if (floor !== undefined) return { block: true, reason: floorReason(floor) };
			if (!insideDir(event.args.path, cwd)) {
				const approved = await api.confirm(`[guardian] allow writing outside ${cwd}?`, event.args.path);
				if (approved) return undefined; // the human said yes — run it
				return {
					block: true,
					reason: `writing outside the project directory (${cwd}) — keep changes inside it, or hand files beyond the project to the human`,
				};
			}
		}
	});

	// 2/2 — the audit trail: one line per blocked/error result, never fatal.
	// Subagent calls are marked [tool child] / [tool child:agent] so the log
	// shows WHO was vetoed, not just what (M6a event fields).
	const logFile = path.join(home, ".imp", "guardian.log");
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
