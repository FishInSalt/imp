// examples/extensions/guardian.mjs — a minimal config-driven permission gate.
//
// Install: copy this file into <project>/.ink/extensions/ (or
// ~/.ink/extensions/) and restart Ink. guardian watches bash / write / edit
// tool calls and matches them against two rule lists in
// ~/.ink/guardian.json:
//
//   • deny rules block the call outright — the model receives the rule's
//     reason as a teaching-style tool result and the run continues;
//   • ask rules ask the human first (approved runs, declined blocks); the
//     prompt offers "don't ask again this session" once, which stops every
//     further ask prompt for the rest of the session; the picker
//     red-highlights the span the matched rule covers; an optional top-level
//     "askTimeoutMs" (milliseconds) bounds how long a question waits once
//     visible — a timeout counts as declined, and the model is told the
//     confirmation timed out (distinct from a manual decline);
//   • a call matching neither rule runs — the default is allow.
//
// Patterns are plain text where `*` matches anything (including newlines);
// a `regex` entry is the escape hatch for full regular expressions. Entries
// target bash by default; add "tool" (write/edit) to guard file paths — the
// resolved absolute path is matched. No modes, no model calls.
//
// A missing config file is valid (zero rules). An invalid one keeps the last
// valid rules, shows a footer flag and an audit line, and is recoverable
// with /guardian reload. One audit line per deny/ask decision goes to
// ~/.ink/guardian.log (created with mode 0600).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** One line, whitespace flattened, capped like Ink's own diagnostics. */
const oneLine = (text, cap = 160) => {
	const flat = String(text).replaceAll(/\s+/gu, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
};

const plainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** #ask-timeout: pinned duration wording for agent-facing copy — minutes at
 *  60 s and above, seconds below, rounded, never zero (999 → "1 second",
 *  59999 → "60 seconds", 90000 → "2 minutes"). */
const humanDuration = (ms) => {
	if (ms >= 60000) {
		const minutes = Math.max(1, Math.round(ms / 60000));
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const seconds = Math.max(1, Math.round(ms / 1000));
	return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

const TOOL_NAMES = ["bash", "write", "edit"];

/** Linear wildcard locate: `*` spans any run of characters (newlines
 *  included), no backtracking. Returns the matched span — first segment
 *  start … last segment end — or undefined. */
const wildcardLocate = (pattern, text) => {
	let position = 0;
	let start = -1;
	let end = -1;
	for (const segment of pattern.split("*")) {
		if (segment === "") continue;
		const index = text.indexOf(segment, position);
		if (index === -1) return undefined;
		if (start === -1) start = index;
		position = index + segment.length;
		end = position;
	}
	return start === -1 ? { start: 0, end: 0 } : { start, end };
};

/** Compile one rule entry; returns `{rule}` or `{error}`. */
const compileEntry = (entry, where) => {
	let wildcard;
	let regexSource;
	let flags = "";
	let reason;
	let toolValue;
	if (typeof entry === "string") {
		if (entry.trim() === "") {
			return { error: `${where}: entry must be a non-empty pattern or an object` };
		}
		wildcard = entry;
	} else if (plainObject(entry)) {
		for (const key of Object.keys(entry)) {
			if (!["pattern", "regex", "flags", "reason", "tool"].includes(key)) {
				return { error: `${where}: unknown key "${key}"` };
			}
		}
		if (entry.pattern !== undefined && entry.regex !== undefined) {
			return { error: `${where}: give "pattern" or "regex", not both` };
		}
		if (entry.pattern === undefined && entry.regex === undefined) {
			return { error: `${where}: one of "pattern" or "regex" is required` };
		}
		if (entry.pattern !== undefined) {
			if (typeof entry.pattern !== "string" || entry.pattern.trim() === "") {
				return { error: `${where}: pattern must be a non-empty string` };
			}
			if (entry.flags !== undefined) {
				return { error: `${where}: flags only apply to regex entries` };
			}
			wildcard = entry.pattern;
		} else {
			if (typeof entry.regex !== "string" || entry.regex.trim() === "") {
				return { error: `${where}: regex must be a non-empty string` };
			}
			if (entry.flags !== undefined) {
				if (typeof entry.flags !== "string") return { error: `${where}: flags must be a string` };
				flags = entry.flags;
			}
			regexSource = entry.regex;
		}
		if (entry.reason !== undefined && typeof entry.reason !== "string") {
			return { error: `${where}: reason must be a string` };
		}
		reason = entry.reason;
		toolValue = entry.tool;
	} else {
		return { error: `${where}: entry must be a string or an object` };
	}
	if (flags.includes("g") || flags.includes("y")) {
		return { error: `${where}: flags must not contain "g" or "y" (stateful regex)` };
	}
	let tools = ["bash"];
	if (toolValue !== undefined) {
		const names = typeof toolValue === "string" ? [toolValue] : toolValue;
		if (!Array.isArray(names) || names.length === 0) {
			return { error: `${where}: tool must be a tool name or a non-empty array of them` };
		}
		for (const name of names) {
			if (typeof name !== "string" || !TOOL_NAMES.includes(name)) {
				return { error: `${where}: unknown tool ${JSON.stringify(name)} (use bash, write, or edit)` };
			}
		}
		tools = [...new Set(names)];
	}
	let locate;
	if (wildcard !== undefined) {
		locate = (text) => wildcardLocate(wildcard, text);
	} else {
		let regex;
		try {
			regex = new RegExp(regexSource, flags);
		} catch (err) {
			return { error: `${where}: invalid regex (${oneLine(err && err.message ? err.message : err)})` };
		}
		locate = (text) => {
			const found = regex.exec(text);
			return found === null ? undefined : { start: found.index, end: found.index + found[0].length };
		};
	}
	return {
		rule: {
			source: wildcard !== undefined ? wildcard : regexSource,
			locate,
			reason: reason ?? "",
			tools: new Set(tools),
		},
	};
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
	/** Ask deadline (#ask-timeout): absent = questions wait indefinitely. */
	let askTimeoutMs;
	for (const key of Object.keys(root)) {
		if (key.startsWith("_")) continue; // top-level `_`-prefixed keys ignored
		if (key === "askTimeoutMs") {
			const value = root[key];
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
				return { error: "askTimeoutMs must be a positive integer of milliseconds (at most 2147483647)" };
			}
			askTimeoutMs = value;
			continue;
		}
		if (key !== "deny" && key !== "ask") return { error: `unknown key "${key}"` };
		if (!Array.isArray(root[key])) return { error: `${key} must be an array` };
		for (let index = 0; index < root[key].length; index++) {
			const compiled = compileEntry(root[key][index], `${key}[${index}]`);
			if (compiled.error !== undefined) return compiled;
			rules[key].push(compiled.rule);
		}
	}
	return { rules, askTimeoutMs };
};

/* ------------------------------------------------------------------ */
/* the extension                                                      */
/* ------------------------------------------------------------------ */

/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	const configFile = path.join(os.homedir(), ".ink", "guardian.json");
	const logFile = path.join(os.homedir(), ".ink", "guardian.log");

	/** The last valid rules (zero defaults before any valid load). */
	let rules = { deny: [], ask: [] };
	/** The last valid ask deadline (#ask-timeout); undefined = no deadline.
	 *  Swaps atomically with `rules` on every successful reload. */
	let askTimeoutMs;
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
				askTimeoutMs = undefined; // rules and deadline swap together
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
		askTimeoutMs = parsed.askTimeoutMs;
		degraded = false;
		setFlag();
		return { ok: true };
	};

	const match = (tool, text) => {
		for (const rule of rules.deny) {
			if (!rule.tools.has(tool)) continue;
			const span = rule.locate(text);
			if (span !== undefined) return { kind: "deny", rule, span };
		}
		for (const rule of rules.ask) {
			if (!rule.tools.has(tool)) continue;
			const span = rule.locate(text);
			if (span !== undefined) return { kind: "ask", rule, span };
		}
		return undefined;
	};

	reload();

	api.on("tool_call", async (event) => {
		const tool = event?.name;
		let text;
		if (tool === "bash") {
			text = typeof event.args?.command === "string" ? event.args.command : undefined;
		} else if (tool === "write" || tool === "edit") {
			const target = typeof event.args?.path === "string" ? event.args.path : undefined;
			const base = typeof event.cwd === "string" ? event.cwd : api.cwd;
			text = target === undefined ? undefined : path.resolve(base, target);
		}
		const who = event.subagent === true ? ` (child${event.agent ? `:${event.agent}` : ""})` : "";
		const subject = text === undefined ? "?" : oneLine(text);
		const preview = tool === "bash" && text !== undefined ? { kind: "command", tool: "bash", text } : undefined;
		try {
			if ((tool !== "bash" && tool !== "write" && tool !== "edit") || text === undefined) return undefined;
			const hit = match(tool, text);
			if (hit === undefined) return undefined;
			if (hit.kind === "deny") {
				audit(`[deny] ${oneLine(hit.rule.source)} — ${subject} — blocked${who}`);
				return {
					block: true,
					reason: hit.rule.reason === "" ? `blocked by guardian rule: ${hit.rule.source}` : hit.rule.reason,
				};
			}
			const detail = hit.rule.reason === "" ? `guardian ask rule: ${hit.rule.source}` : hit.rule.reason;
			const options = {
				sessionKey: "guardian:session",
				rememberLabel: "all guardian ask prompts this session",
				// #ask-timeout: only when configured — an absent deadline keeps
				// the option bag byte-identical to the pre-timeout shape.
				...(askTimeoutMs !== undefined ? { timeoutMs: askTimeoutMs } : {}),
			};
			const warnSpans = hit.span.end > hit.span.start ? [[hit.span.start, hit.span.end]] : undefined;
			const outcome =
				tool === "bash"
					? await api.confirm("allow this bash command?", detail, {
							...options,
							preview: warnSpans === undefined ? preview : { ...preview, warnSpans },
						})
					: await api.confirm(`allow this ${tool}?`, `${text}\n${detail}`, options);
			// Strict three-way result: "timeout" is TRUTHY — `if (outcome)` would
			// approve a question nobody answered.
			const verdict = outcome === true ? "approved" : outcome === "timeout" ? "timeout" : "denied";
			audit(`[ask] ${oneLine(hit.rule.source)} — ${subject} — ${verdict}${who}`);
			if (outcome === true) return undefined;
			const declined =
				outcome === "timeout"
					? askTimeoutMs === undefined
						? "the confirmation timed out — the call was not approved" // contract-violating host; unreachable otherwise
						: `the confirmation timed out after ${humanDuration(askTimeoutMs)} — the call was not approved`
					: "the user declined this call";
			return {
				block: true,
				reason: hit.rule.reason === "" ? declined : `${hit.rule.reason} — ${declined}`,
			};
		} catch {
			try {
				// Fail toward asking; deliberately no sessionKey (a session-wide
				// "stop asking" grant must not auto-approve this fallback).
				// #ask-timeout: the fallback carries the configured deadline too.
				const fallbackOptions = preview === undefined ? {} : { preview };
				if (askTimeoutMs !== undefined) fallbackOptions.timeoutMs = askTimeoutMs;
				const outcome = await api.confirm(
					"guardian hit an internal error — allow this call?",
					subject,
					fallbackOptions,
				);
				const verdict = outcome === true ? "approved" : outcome === "timeout" ? "timeout" : "denied";
				audit(`[ask] internal error — ${subject} — ${verdict}${who}`);
				return outcome === true
					? undefined
					: { block: true, reason: "guardian internal error — the call was not allowed" };
			} catch {
				return { block: true, reason: "guardian internal error — the call was not allowed" };
			}
		}
	});

	api.registerCommand({
		name: "guardian",
		usage: "/guardian [status|reload]",
		summary: "guardian: wildcard deny/ask gate for bash and file paths",
		allowedDuringRun: true,
		run: (args, ctx) => {
			try {
				const note = (line) => ctx.renderer.note(`▪ guardian: ${line}`);
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
						`deny ${rules.deny.length}, ask ${rules.ask.length} — config ${configFile}${degraded ? " (config error — /guardian reload to recover)" : ""}`,
					);
					return "handled";
				}
				note(`unknown argument "${arg}" — /guardian [status|reload]`);
				return "handled";
			} catch (err) {
				ctx.renderer.note(`▪ guardian: internal error — ${oneLine(String((err && err.message) || err))}`);
				return "handled";
			}
		},
	});
}
