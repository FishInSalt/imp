// examples/extensions/guardian2.mjs — a minimal config-driven permission gate.
//
// Install: copy this file into <project>/.imp/extensions/ (or
// ~/.imp/extensions/) and restart imp. guardian2 watches bash tool calls and
// matches the raw command string against two regex rule lists in
// ~/.imp/guardian2.json:
//
//   • deny rules block the call outright — the model receives the rule's
//     reason as a teaching-style tool result and the run continues;
//   • ask rules ask the human first (approved runs, declined blocks); the
//     prompt offers "don't ask again this session" once, which stops every
//     further ask prompt for the rest of the session;
//   • a command matching neither rule runs — the default is allow.
//
// No modes, no model calls. A missing config file is valid (zero rules). An
// invalid one keeps the last valid rules, shows a footer flag and an audit
// line, and is recoverable with /guardian2 reload. One audit line per
// deny/ask decision goes to ~/.imp/guardian2.log (created with mode 0600).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** One line, whitespace flattened, capped like imp's own diagnostics. */
const oneLine = (text, cap = 160) => {
	const flat = String(text).replaceAll(/\s+/gu, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
};

const plainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Compile one rule entry; returns `{rule}` or `{error}`. */
const compileEntry = (entry, where) => {
	let pattern;
	let flags = "";
	let reason;
	if (typeof entry === "string") {
		pattern = entry;
	} else if (plainObject(entry)) {
		for (const key of Object.keys(entry)) {
			if (key !== "pattern" && key !== "flags" && key !== "reason") {
				return { error: `${where}: unknown key "${key}"` };
			}
		}
		pattern = entry.pattern;
		if (typeof pattern !== "string" || pattern === "") {
			return { error: `${where}: pattern must be a non-empty string` };
		}
		if (entry.flags !== undefined) {
			if (typeof entry.flags !== "string") return { error: `${where}: flags must be a string` };
			flags = entry.flags;
		}
		if (entry.reason !== undefined && typeof entry.reason !== "string") {
			return { error: `${where}: reason must be a string` };
		}
		reason = entry.reason;
	} else {
		return { error: `${where}: entry must be a string or {pattern, flags?, reason?}` };
	}
	if (flags.includes("g") || flags.includes("y")) {
		return { error: `${where}: flags must not contain "g" or "y" (stateful regex)` };
	}
	let regex;
	try {
		regex = new RegExp(pattern, flags);
	} catch (err) {
		return { error: `${where}: invalid regex (${oneLine(err && err.message ? err.message : err)})` };
	}
	return { rule: { pattern, regex, reason: reason ?? "" } };
};

/** Validate the whole file; returns `{rules}` or `{error}`. */
const parseConfig = (text) => {
	let root;
	try {
		root = JSON.parse(text);
	} catch (err) {
		return { error: `invalid JSON: ${oneLine(err && err.message ? err.message : err)}` };
	}
	if (!plainObject(root)) return { error: "top level must be a JSON object" };
	const rules = { deny: [], ask: [] };
	for (const key of Object.keys(root)) {
		if (key.startsWith("_")) continue; // top-level `_`-prefixed keys ignored
		if (key !== "deny" && key !== "ask") return { error: `unknown key "${key}"` };
		if (!Array.isArray(root[key])) return { error: `${key} must be an array` };
		for (let index = 0; index < root[key].length; index++) {
			const compiled = compileEntry(root[key][index], `${key}[${index}]`);
			if (compiled.error !== undefined) return compiled;
			rules[key].push(compiled.rule);
		}
	}
	return { rules };
};

/* ------------------------------------------------------------------ */
/* the extension                                                      */
/* ------------------------------------------------------------------ */

/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	const configFile = path.join(os.homedir(), ".imp", "guardian2.json");
	const logFile = path.join(os.homedir(), ".imp", "guardian2.log");

	/** The last valid rules (zero defaults before any valid load). */
	let rules = { deny: [], ask: [] };
	let degraded = false;

	const audit = (line) => {
		try {
			mkdirSync(path.dirname(logFile), { recursive: true });
			appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
		} catch {
			// an observer must never break the host
		}
	};

	const setFlag = () => {
		api.setStatus("config", degraded ? "config error" : undefined);
	};

	/** Reload the config; a failure keeps the last valid rules active. */
	const reload = () => {
		let text;
		try {
			text = readFileSync(configFile, "utf8");
		} catch (err) {
			if (err && err.code === "ENOENT") {
				rules = { deny: [], ask: [] };
				degraded = false;
				setFlag();
				return { ok: true, missing: true };
			}
			const error = oneLine(String((err && err.message) || err));
			degraded = true;
			audit(`[load] config error — ${error}`);
			setFlag();
			return { ok: false, error };
		}
		const parsed = parseConfig(text);
		if (parsed.error !== undefined) {
			degraded = true;
			audit(`[load] config error — ${parsed.error}`);
			setFlag();
			return { ok: false, error: parsed.error };
		}
		rules = parsed.rules;
		degraded = false;
		setFlag();
		return { ok: true };
	};

	const match = (command) => {
		for (const rule of rules.deny) {
			if (rule.regex.test(command)) return { kind: "deny", rule };
		}
		for (const rule of rules.ask) {
			if (rule.regex.test(command)) return { kind: "ask", rule };
		}
		return undefined;
	};

	reload();

	api.on("tool_call", async (event) => {
		try {
			if (event.name !== "bash" || typeof event.args.command !== "string") return undefined;
			const command = event.args.command;
			const hit = match(command);
			if (hit === undefined) return undefined;
			const who = event.subagent === true ? ` (child${event.agent ? `:${event.agent}` : ""})` : "";
			const subject = oneLine(command);
			if (hit.kind === "deny") {
				audit(`[deny] ${oneLine(hit.rule.pattern)} — ${subject} — blocked${who}`);
				return {
					block: true,
					reason: hit.rule.reason === "" ? `blocked by guardian2 rule: ${hit.rule.pattern}` : hit.rule.reason,
				};
			}
			const approved = await api.confirm(
				"allow this bash command?",
				hit.rule.reason === "" ? `guardian2 ask rule: ${hit.rule.pattern}` : hit.rule.reason,
				{
					sessionKey: "guardian2:session",
					rememberLabel: "all guardian2 ask prompts this session",
					preview: { kind: "command", tool: "bash", text: command },
				},
			);
			audit(`[ask] ${oneLine(hit.rule.pattern)} — ${subject} — ${approved ? "approved" : "denied"}${who}`);
			if (approved) return undefined;
			return {
				block: true,
				reason: hit.rule.reason === "" ? "blocked by guardian2 — the confirmation was declined" : hit.rule.reason,
			};
		} catch {
			try {
				// Fail toward asking; deliberately no sessionKey (a session-wide
				// "stop asking" grant must not auto-approve this fallback).
				const approved = await api.confirm("guardian2 hit an internal error — allow this call?", undefined, {});
				return approved ? undefined : { block: true, reason: "guardian2 internal error — the call was not allowed" };
			} catch {
				return { block: true, reason: "guardian2 internal error — the call was not allowed" };
			}
		}
	});

	api.registerCommand({
		name: "guardian2",
		usage: "/guardian2 [status|reload]",
		summary: "guardian2: regex deny/ask gate for bash commands",
		allowedDuringRun: true,
		run: (args, ctx) => {
			try {
				const note = (line) => ctx.renderer.note(`▪ guardian2: ${line}`);
				const arg = args.trim();
				if (arg === "reload") {
					const result = reload();
					if (result.ok) {
						note(
							`config reloaded — deny ${rules.deny.length}, ask ${rules.ask.length}${result.missing ? " (no config file — zero rules)" : ""}`,
						);
					} else {
						note(`reload failed — still degraded: ${result.error}`);
					}
					return "handled";
				}
				if (arg === "" || arg === "status") {
					note(
						`deny ${rules.deny.length}, ask ${rules.ask.length} — config ${configFile}${degraded ? " (config error — /guardian2 reload to recover)" : ""}`,
					);
					return "handled";
				}
				note(`unknown argument "${arg}" — /guardian2 [status|reload]`);
				return "handled";
			} catch (err) {
				ctx.renderer.note(`▪ guardian2: internal error — ${oneLine(String((err && err.message) || err))}`);
				return "handled";
			}
		},
	});
}
