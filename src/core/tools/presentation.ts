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
const timeout = numeric("timeout", "Timeout (seconds)", "30", 1, 600);

/** Inspect only a bounded prefix; never split a surrogate pair or emit controls in chrome. */
function excerpt(value: string, limit = 160): string {
	let text = "";
	let count = 0;
	for (const point of value) {
		if (count++ === limit) return `${text}…`;
		text += /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(point)
			? point === "\n"
				? "\\n"
				: point === "\r"
					? "\\r"
					: point === "\t"
						? "\\t"
						: `\\u{${point.codePointAt(0)?.toString(16)}}`
			: point;
	}
	return text;
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
		return `${excerpt(a.path as string)} · ${lines} lines · ${Buffer.byteLength(content)} bytes`;
	},
);
export const readPresentation = presentation(
	[
		requiredPath,
		{ key: "offset", label: "Start line", accept: positive, fallback: "1" },
		{
			key: "limit",
			label: "Requested line limit (hard cap 2000 lines / 50KB)",
			accept: positive,
			fallback: "not specified; hard cap 2000 lines / 50KB",
		},
	],
	(a) =>
		`${excerpt(a.path as string)} · from line ${a.offset ?? 1}${Object.hasOwn(a, "limit") ? ` · up to ${a.limit} requested` : ""}`,
);
export const grepPresentation = presentation(
	[
		{ key: "pattern", label: "Pattern", accept: string },
		path,
		{
			key: "glob",
			label: "File glob",
			accept: string,
			fallback: "none",
			format: (v) => (v === "" ? '"" (no filter)' : String(v)),
		},
		{ key: "ignoreCase", label: "Ignore case", accept: boolean, fallback: "false" },
		{ key: "literal", label: "Literal", accept: boolean, fallback: "false" },
		numeric("context", "Context lines", "0", 0, 10),
		numeric("limit", "Output line limit", "100", 1, 1000),
		timeout,
	],
	(a) =>
		`${excerpt(a.pattern as string)} · path ${excerpt((a.path as string) || ".")}${a.glob ? ` · glob ${excerpt(a.glob as string)}` : ""}`,
);
export const findPresentation = presentation(
	[
		{ key: "pattern", label: "Name glob", accept: string },
		path,
		{ key: "type", label: "Type", accept: (v) => v === "file" || v === "directory", fallback: "both" },
		numeric("limit", "Output line limit", "200", 1, 1000),
		timeout,
	],
	(a) =>
		`${excerpt(a.pattern as string)} · path ${excerpt((a.path as string) || ".")} · type ${a.type ?? "both"}`,
);
export const lsPresentation = presentation(
	[path, numeric("limit", "Entry limit", "500", 1, 5000, true)],
	(a) =>
		`${excerpt((a.path as string) || ".")} · up to ${effective(a.limit ?? 500, 1, 5000, true)} entries requested`,
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
