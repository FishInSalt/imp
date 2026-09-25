import { types } from "node:util";
import { contentText, type ToolResult } from "../core/messages.js";
import type {
	ToolArgumentPresentationField,
	ToolCallPresentationContext,
	ToolPresentationHooks,
	ToolPresentationValue,
	ToolResultPresentationContext,
	ToolSemanticPresentation,
	ToolSourcePresentation,
} from "../core/tools/types.js";

export type ToolPresentationResolver = (name: string) => ToolPresentationHooks | undefined;
export const UNAVAILABLE_ARGUMENTS_TEXT = "[Arguments unavailable: could not be safely serialized as JSON]";

export interface PreparedToolCall extends ToolCallPresentationContext {
	readonly callSemantic: ToolSemanticPresentation | undefined;
	readonly resultHook: ToolPresentationHooks["result"];
	/** Safe detached raw data, independent of semantic limits. Never use event args as fallback. */
	readonly rawArgs: ToolPresentationValue;
	readonly rawArgsText: string;
	readonly serializationStatus: "available" | "unavailable";
}

const promiseThen = Promise.prototype.then;
const intrinsicApply = Reflect.apply;

function data(value: object, key: PropertyKey): unknown {
	const d = Object.getOwnPropertyDescriptor(value, key);
	if (!d || !("value" in d)) throw new Error("Not own data");
	return d.value;
}
function plain(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

/** Reflection may execute proxy traps: these are crash guards, not a sandbox.
 * Walk once, retaining safe raw data even after the semantic budget is exceeded.
 * Never run getters/toJSON or retry rejected inputs through JSON.stringify. */
function snapshot(input: unknown): { raw: ToolPresentationValue; available: boolean; text: string } {
	let nodes = 0;
	let units = 0;
	let available = true;
	let raw: ToolPresentationValue = null;
	const active = new Set<object>();
	type Job =
		| { value: unknown; depth: number; put: (v: ToolPresentationValue) => void }
		| { exit: object; copy: object };
	const jobs: Job[] = [
		{
			value: input,
			depth: 0,
			put: (v) => {
				raw = v;
			},
		},
	];
	while (jobs.length) {
		const job = jobs.pop();
		if (!job) break;
		if ("exit" in job) {
			active.delete(job.exit);
			Object.freeze(job.copy);
			continue;
		}
		const { value, depth, put } = job;
		nodes++;
		if (typeof value === "string") units += value.length;
		if (depth > 64 || nodes > 100_000 || units > 1_000_000) available = false;
		if (value === null || typeof value === "string" || typeof value === "boolean") {
			put(value);
			continue;
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			put(value);
			continue;
		}
		if (typeof value !== "object" || value === null || active.has(value)) throw new Error("Unsafe arguments");
		const array = Array.isArray(value);
		if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value))
			throw new Error("Unsupported prototype");
		const keys = Reflect.ownKeys(value);
		const length = array ? data(value, "length") : 0;
		if (array && (typeof length !== "number" || keys.length !== length + 1))
			throw new Error("Sparse or decorated array");
		const copy: Record<string, ToolPresentationValue> | ToolPresentationValue[] = array
			? []
			: Object.create(null);
		put(copy);
		active.add(value);
		jobs.push({ exit: value, copy });
		for (let i = keys.length - 1; i >= 0; i--) {
			const key = keys[i];
			if (typeof key !== "string" || key === "toJSON") throw new Error("Unsupported key");
			if (array && key === "length") continue;
			if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (length as number)))
				throw new Error("Invalid index");
			units += key.length;
			if (units > 1_000_000) available = false;
			const child = data(value, key);
			jobs.push({
				value: child,
				depth: depth + 1,
				put: (v) => {
					Object.defineProperty(copy, key, {
						value: v,
						enumerable: true,
						configurable: true,
						writable: true,
					});
				},
			});
		}
	}
	return { raw, available, text: JSON.stringify(raw, null, 2) };
}

function capture(name: string, resolver?: ToolPresentationResolver): ToolPresentationHooks {
	try {
		const hooks = resolver?.(name);
		if (!hooks || typeof hooks !== "object" || !plain(hooks)) return {};
		const read = (key: "call" | "result") => {
			const descriptor = Object.getOwnPropertyDescriptor(hooks, key);
			return descriptor && "value" in descriptor && typeof descriptor.value === "function"
				? descriptor.value
				: undefined;
		};
		return { call: read("call"), result: read("result") };
	} catch {
		return {};
	}
}

function validate(
	value: unknown,
	phase: "call" | "result",
	args?: ToolPresentationValue,
): ToolSemanticPresentation | undefined {
	if (types.isPromise(value)) {
		try {
			intrinsicApply(promiseThen, value, [undefined, () => undefined]);
		} catch {
			/* hostile species */
		}
		return undefined;
	}
	if (!value || typeof value !== "object" || !plain(value)) return undefined;
	const keys = Reflect.ownKeys(value);
	if (
		keys.some(
			(k) =>
				k !== "summary" && k !== "preview" && k !== "detail" && k !== "argumentFields" && k !== "sources",
		)
	)
		return undefined;
	const summary = data(value, "summary");
	if (typeof summary !== "string" || summary.length > 4096) return undefined;
	let total = summary.length;
	const out: {
		summary: string;
		preview?: readonly string[];
		detail?: readonly string[];
		argumentFields?: readonly ToolArgumentPresentationField[];
		sources?: readonly ToolSourcePresentation[];
	} = { summary };
	for (const key of ["preview", "detail"] as const) {
		if (!keys.includes(key)) continue;
		const rows = data(value, key);
		if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) return undefined;
		const length = data(rows, "length") as number;
		if (length > 1000 || Reflect.ownKeys(rows).length !== length + 1) return undefined;
		const copied: string[] = [];
		for (let i = 0; i < length; i++) {
			const row = data(rows, String(i));
			if (typeof row !== "string" || row.length > 16_384) return undefined;
			total += row.length;
			if (total > 100_000) return undefined;
			copied.push(row);
		}
		out[key] = Object.freeze(copied);
	}
	if (keys.includes("argumentFields")) {
		if (phase !== "call") return undefined;
		if (!args || typeof args !== "object" || Array.isArray(args) || !plain(args)) return undefined;
		const dense = (v: unknown, max: number): unknown[] => {
			if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) throw Error("Invalid array");
			const length = data(v, "length") as number;
			if (length > max || Reflect.ownKeys(v).length !== length + 1) throw Error("Invalid array");
			return Array.from({ length }, (_, i) => data(v, String(i)));
		};
		const owned = new Set<string>();
		const fields: ToolArgumentPresentationField[] = [];
		for (const field of dense(data(value, "argumentFields"), 100)) {
			if (!field || typeof field !== "object" || !plain(field)) return undefined;
			const keys = Reflect.ownKeys(field);
			if (keys.some((k) => !["label", "value", "consumes", "default"].includes(k as string)))
				return undefined;
			const label = data(field, "label");
			const text = data(field, "value");
			const isDefault = keys.includes("default");
			if (isDefault && data(field, "default") !== true) return undefined;
			if (
				typeof label !== "string" ||
				!label.length ||
				label.length > 256 ||
				typeof text !== "string" ||
				text.length > 16384
			)
				return undefined;
			const consumes: string[] = [];
			for (const key of dense(data(field, "consumes"), 1000)) {
				if (typeof key !== "string" || key.length > 4096 || !Object.hasOwn(args, key) || owned.has(key))
					return undefined;
				owned.add(key);
				consumes.push(key);
				total += key.length;
			}
			if (isDefault ? consumes.length !== 0 : consumes.length === 0) return undefined;
			total += label.length + text.length;
			if (total > 100000) return undefined;
			fields.push(
				Object.freeze({
					label,
					value: text,
					consumes: Object.freeze(consumes),
					...(isDefault ? { default: true as const } : {}),
				}),
			);
		}
		out.argumentFields = Object.freeze(fields);
	}

	if (keys.includes("sources")) {
		if (phase !== "result") return undefined;
		const sources = data(value, "sources");
		if (!Array.isArray(sources) || Object.getPrototypeOf(sources) !== Array.prototype) return undefined;
		const length = data(sources, "length") as number;
		if (length < 1 || length > 10 || Reflect.ownKeys(sources).length !== length + 1) return undefined;
		const copy: ToolSourcePresentation[] = [];
		for (let i = 0; i < length; i++) {
			const source = data(sources, String(i));
			if (!source || typeof source !== "object" || !plain(source)) return undefined;
			const keys = Reflect.ownKeys(source);
			if (keys.length !== 2 || !keys.includes("title") || !keys.includes("url")) return undefined;
			const title = data(source, "title");
			const url = data(source, "url");
			if (typeof title !== "string" || title.length > 4096 || typeof url !== "string" || !safeSourceUrl(url))
				return undefined;
			total += title.length + url.length;
			if (total > 100000) return undefined;
			copy.push(Object.freeze({ title, url }));
		}
		out.sources = Object.freeze(copy);
	}

	return Object.freeze(out);
}
function invoke<C>(
	hook: ((context: C) => unknown) | undefined,
	context: C,
	phase: "call" | "result",
	args?: ToolPresentationValue,
): ToolSemanticPresentation | undefined {
	try {
		return hook ? validate(hook(context), phase, args) : undefined;
	} catch {
		return undefined;
	}
}

export function prepareCall(
	toolCallId: string,
	toolName: string,
	args: unknown,
	resolver?: ToolPresentationResolver,
): PreparedToolCall {
	const hooks = capture(toolName, resolver);
	let rawArgs: ToolPresentationValue = null;
	let rawArgsText = UNAVAILABLE_ARGUMENTS_TEXT;
	let argsAvailable = false;
	let serializationStatus: PreparedToolCall["serializationStatus"] = "unavailable";
	try {
		const saved = snapshot(args);
		rawArgs = saved.raw;
		rawArgsText = saved.text;
		argsAvailable = saved.available;
		serializationStatus = "available";
	} catch {
		/* Never retraverse the original input. */
	}
	const context = Object.freeze({
		toolCallId,
		toolName,
		args: argsAvailable ? rawArgs : null,
		argsAvailable,
	});
	return Object.freeze({
		...context,
		rawArgs,
		rawArgsText,
		serializationStatus,
		resultHook: argsAvailable ? hooks.result : undefined,
		callSemantic: argsAvailable ? invoke(hooks.call, context, "call", context.args) : undefined,
	});
}

/** Paired results use captured hooks, never a replacement registry entry.
 * Orphans may invoke the current result hook with argsAvailable=false. */
export function prepareResult(
	record: PreparedToolCall | undefined,
	result: ToolResult,
	replay: boolean,
	resolver?: ToolPresentationResolver,
): ToolSemanticPresentation | undefined {
	try {
		const hook = record ? record.resultHook : capture(result.toolName, resolver).result;
		if (!hook) return undefined;
		const images =
			typeof result.content === "string"
				? []
				: result.content.flatMap((b) =>
						b.type === "image" ? [Object.freeze({ mimeType: b.mimeType, encodedLength: b.data.length })] : [],
					);
		const context: ToolResultPresentationContext = Object.freeze({
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			args: record?.args ?? null,
			argsAvailable: record?.argsAvailable ?? false,
			result: Object.freeze({
				text: contentText(result.content),
				...(result.display === undefined ? {} : { display: result.display }),
				isError: result.isError,
				images: Object.freeze(images),
			}),
			replay,
		});
		return invoke(hook, context, "result");
	} catch {
		return undefined;
	}
}

/** Display syntax only; local/private hosts are allowed. Never normalizes input. */
export function safeSourceUrl(value: string): boolean {
	if (
		!value.length ||
		value.length > 2048 ||
		/[\s\p{Cc}\p{Cf}\\]/u.test(value) ||
		/%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/i.test(value)
	)
		return false;
	try {
		const url = new URL(value);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!!url.hostname &&
			!url.username &&
			!url.password &&
			url.href === value
		);
	} catch {
		return false;
	}
}
