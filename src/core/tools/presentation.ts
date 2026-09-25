import type { ToolArgumentPresentationField, ToolPresentationHooks, ToolPresentationValue } from "./types.js";

type Args = { readonly [key: string]: ToolPresentationValue };
type Rule = {
	key: string;
	label: string;
	accept: (value: ToolPresentationValue) => boolean;
	fallback?: string;
	format?: (value: ToolPresentationValue) => string;
};
const string = (v: ToolPresentationValue) => typeof v === "string";
const boolean = (v: ToolPresentationValue) => typeof v === "boolean";
const finite = (v: ToolPresentationValue) => typeof v === "number" && Number.isFinite(v);
const positive = (v: ToolPresentationValue) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const path: Rule = {
	key: "path",
	label: "Path",
	accept: string,
	fallback: ".",
	format: (v) => (v === "" ? '"" (effective: .)' : String(v)),
};
const effective = (v: ToolPresentationValue, min: number, max: number, trunc = false) =>
	Math.min(max, Math.max(min, trunc ? Math.trunc(v as number) : Math.floor(v as number)));
function numeric(
	key: string,
	label: string,
	fallback: string,
	min: number,
	max: number,
	trunc = false,
): Rule {
	return {
		key,
		label,
		fallback,
		accept: finite,
		format: (v) => {
			const n = effective(v, min, max, trunc);
			return n === v ? String(v) : `${v} (effective: ${n})`;
		},
	};
}
const timeout = numeric("timeout", "Timeout (s)", "30", 1, 600);

/** Inspect only a bounded prefix; never split a surrogate pair or emit controls in chrome. */
export function builtinExcerpt(
	value: string,
	limit = 160,
	literalLF = false,
): {
	text: string;
	spans: { start: number; end: number; sourceStart: number; sourceEnd: number }[];
} {
	let text = "";
	const spans: { start: number; end: number; sourceStart: number; sourceEnd: number }[] = [];
	let sourceStart = 0;
	let count = 0;
	for (const point of value) {
		if (count++ === limit) return { text: `${text}…`, spans };
		const start = text.length;
		text += /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(point)
			? point === "\n"
				? literalLF
					? "\n"
					: "\\n"
				: point === "\r"
					? "\\r"
					: point === "\t"
						? "\\t"
						: `\\u{${point.codePointAt(0)?.toString(16)}}`
			: point;
		spans.push({ start, end: text.length, sourceStart, sourceEnd: sourceStart + point.length });
		sourceStart += point.length;
	}
	return { text, spans };
}
function excerpt(value: string, limit = 160, literalLF = false): string {
	return builtinExcerpt(value, limit, literalLF).text;
}

/** Full fields are checked before summaries count or traverse payload text. */
function presentation(rules: readonly Rule[], summary: (args: Args) => string): ToolPresentationHooks {
	return {
		call(context) {
			if (
				!context.argsAvailable ||
				!context.args ||
				typeof context.args !== "object" ||
				Array.isArray(context.args)
			)
				return undefined;
			const args = context.args as Args;
			const fields: ToolArgumentPresentationField[] = [];
			let total = 0;
			for (const rule of rules) {
				const supplied = Object.hasOwn(args, rule.key);
				const value = args[rule.key] as ToolPresentationValue;
				if (supplied && (!rule.accept(value) || (typeof value === "string" && value.length > 16384)))
					return undefined;
				if (!supplied && rule.fallback === undefined) return undefined;
				if (!supplied && rule.fallback !== undefined && rule.key !== "path") continue;
				const text = supplied
					? rule.format
						? rule.format(value)
						: String(value)
					: (rule.fallback as string);
				if (text.length > 16384 || rule.label.length > 256) return undefined;
				total += rule.label.length + text.length + (supplied ? rule.key.length : 0);
				if (total > 100000) return undefined;
				fields.push({
					label: rule.label,
					value: text,
					consumes: supplied ? [rule.key] : [],
					...(!supplied ? { default: true as const } : {}),
				});
			}
			if (fields.length > 100) return undefined;
			const text = summary(args);
			if (text.length > 4096 || total + text.length > 100000) return undefined;
			return { summary: text, argumentFields: fields };
		},
	};
}
const requiredPath: Rule = { key: "path", label: "Path", accept: string };
export const writePresentation = presentation(
	[requiredPath, { key: "content", label: "Content", accept: string }],
	(a) => {
		const content = a.content as string;
		let lines = content === "" ? 0 : 1;
		for (const c of content) if (c === "\n") lines++;
		if (content.endsWith("\n")) lines--;
		return `${lines} lines · ${Buffer.byteLength(content)} bytes`;
	},
);
export const readPresentation = presentation(
	[
		requiredPath,
		{ key: "offset", label: "Start line", accept: positive, fallback: "1" },
		{
			key: "limit",
			label: "Line limit",
			accept: positive,
			fallback: "not specified; hard cap 2000 lines / 50KB",
		},
	],
	(a) =>
		[
			Object.hasOwn(a, "offset") ? `from line ${a.offset}` : "",
			Object.hasOwn(a, "limit") ? `up to ${a.limit} requested` : "",
		]
			.filter(Boolean)
			.join(" · "),
);
export const grepPresentation = presentation(
	[
		{ key: "pattern", label: "Pattern", accept: string },
		path,
		{
			key: "glob",
			label: "Glob",
			accept: string,
			fallback: "none",
			format: (v) => (v === "" ? '"" (no filter)' : String(v)),
		},
		{ key: "ignoreCase", label: "Ignore case", accept: boolean, fallback: "false" },
		{ key: "literal", label: "Literal", accept: boolean, fallback: "false" },
		numeric("context", "Context lines", "0", 0, 10),
		numeric("limit", "Line limit", "100", 1, 1000),
		timeout,
	],
	(a) => `${excerpt(a.pattern as string)}${a.glob ? ` · glob ${excerpt(a.glob as string)}` : ""}`,
);
export const findPresentation = presentation(
	[
		{ key: "pattern", label: "Pattern", accept: string },
		path,
		{ key: "type", label: "Type", accept: (v) => v === "file" || v === "directory", fallback: "both" },
		numeric("limit", "Line limit", "200", 1, 1000),
		timeout,
	],
	(a) => `${excerpt(a.pattern as string)}${a.type ? ` · type ${a.type}` : ""}`,
);
export const lsPresentation = presentation(
	[path, numeric("limit", "Entry limit", "500", 1, 5000, true)],
	(a) => (Object.hasOwn(a, "limit") ? `up to ${effective(a.limit!, 1, 5000, true)} entries requested` : ""),
);
export const taskPresentation = presentation(
	[
		{ key: "prompt", label: "Prompt", accept: string },
		{ key: "agent", label: "Agent", accept: (v) => string(v) && v !== "", fallback: "generic subagent" },
		{
			key: "timeoutMs",
			label: "Timeout (ms)",
			accept: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1000,
			fallback: "inherited from agent/host",
		},
		{
			key: "worktree",
			label: "Worktree",
			accept: boolean,
			fallback: "inherited from agent; otherwise false",
		},
	],
	(a) => `${excerpt((a.agent as string) ?? "generic subagent")} · ${excerpt(a.prompt as string, 120)}`,
);

export const bashPresentation = presentation(
	[
		{ key: "command", label: "Command", accept: string },
		{ key: "timeout", label: "Timeout (s)", accept: (v) => finite(v) && (v as number) > 0, fallback: "" },
	],
	(a) => excerpt(a.command as string, 160, true),
);

function replacements(value: ToolPresentationValue): string {
	return (value as readonly Args[])
		.map((edit, index) => {
			const payload = (label: string, text: string) =>
				text === ""
					? `${label}: (empty string)`
					: `${label}:\n${text
							.split("\n")
							.map((line) => `  ${line}`)
							.join("\n")}`;
			return `Replacement ${index + 1}\n${payload("oldText", edit.oldText as string)}\n${payload("newText", edit.newText as string)}`;
		})
		.join("\n");
}
export const editPresentation = presentation(
	[
		requiredPath,
		{
			key: "edits",
			label: "Replacements",
			accept: (v) =>
				Array.isArray(v) &&
				v.length > 0 &&
				v.every(
					(e) =>
						e !== null &&
						typeof e === "object" &&
						!Array.isArray(e) &&
						Object.keys(e).length === 2 &&
						Object.hasOwn(e, "oldText") &&
						Object.hasOwn(e, "newText") &&
						typeof e.oldText === "string" &&
						typeof e.newText === "string",
				),
			format: replacements,
		},
	],
	(a) =>
		`${(a.edits as readonly Args[]).length} replacement${(a.edits as readonly Args[]).length === 1 ? "" : "s"}`,
);

/** Private host association: captured function identity, never a tool-name heuristic. */
export function builtinCallName(call: ToolPresentationHooks["call"]): string | undefined {
	return Object.entries({
		read: readPresentation,
		write: writePresentation,
		edit: editPresentation,
		ls: lsPresentation,
		bash: bashPresentation,
		grep: grepPresentation,
		find: findPresentation,
		task: taskPresentation,
	}).find(([, hooks]) => hooks.call === call)?.[0];
}
