import { contentText, type ToolResult } from "../core/messages.js";
import type { ToolSemanticPresentation } from "../core/tools/types.js";
import {
	type PreparedToolCall,
	prepareCall,
	prepareResult,
	type ToolPresentationResolver,
} from "./tool-presentation-hooks.js";

export type { ToolPresentationResolver } from "./tool-presentation-hooks.js";

/** Terminal-local policy: consume control sequences before escaping controls. */
export function sanitizeDisplay(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; ) {
		const code = text.charCodeAt(i);
		const c = text[i] ?? "";
		if (c === "\r" && text[i + 1] === "\n") {
			out += "\n";
			i += 2;
			continue;
		}
		const esc = code === 27;
		const csi = code === 155 || (esc && text[i + 1] === "[");
		const osc = code === 157 || (esc && text[i + 1] === "]");
		if (csi) {
			let j = i + (esc ? 2 : 1);
			while (j < text.length && /[\x30-\x3f]/.test(text[j] ?? "")) j++;
			while (j < text.length && /[\x20-\x2f]/.test(text[j] ?? "")) j++;
			if (j < text.length && /[\x40-\x7e]/.test(text[j] ?? "")) {
				i = j + 1;
				continue;
			}
		} else if (osc || (esc && "PX^_".includes(text[i + 1] ?? "\0"))) {
			let j = i + (esc ? 2 : 1);
			while (
				j < text.length &&
				!(osc && text.charCodeAt(j) === 7) &&
				text.charCodeAt(j) !== 156 &&
				!(text.charCodeAt(j) === 27 && text[j + 1] === "\\")
			)
				j++;
			if (j < text.length) {
				i = j + (text.charCodeAt(j) === 27 ? 2 : 1);
				continue;
			}
			// No terminator: escape the entire suffix once, avoiding rescans.
			out += escapeControls(text.slice(i).replaceAll("\r\n", "\n"));
			break;
		} else if (esc) {
			let j = i + 1;
			while (j < text.length && /[\x20-\x2f]/.test(text[j] ?? "")) j++;
			if (j < text.length && /[\x30-\x7e]/.test(text[j] ?? "")) {
				i = j + 1;
				continue;
			}
		}
		out += escapeControls(c);
		i++;
	}
	return out;
}
function escapeControls(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly escaping terminal control bytes
	return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (c) =>
		c === "\t" ? "    " : c === "\r" ? "\\r" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
}

export interface RawSection {
	/** Original identity for diagnostic comparisons; never rendered. */
	originalLines?: string[];
	caption: string;
	lines: string[];
	discarded: number;
	diff?: boolean;
}
export interface ToolBlock {
	semantic?: ToolSemanticPresentation;
	readableArguments?: string[];
	collapsedLines?: string[];
	/** Exact raw error line promoted to metadata; compare before display sanitization. */
	promotedDiagnostic?: string;
	sections?: RawSection[];
	id: string;
	name: string;
	kind: "input" | "output" | "diff";
	title: string;
	lines: string[];
	metadata: string[];
	discarded: number;
	error: boolean;
}
export interface ToolPresentationSink {
	start(id: string, name: string, args: unknown): void;
	prepare(id: string, name: string, args: unknown): PreparedToolCall;
	setResolver(resolver: ToolPresentationResolver): void;
	end(result: ToolResult, replay?: boolean): void;
	finalize(): void;
	clear(): void;
}
const unique = (rows: string[]): string[] => [...new Set(rows.map(sanitizeDisplay))];
function lines(text: string): string[] {
	const rows = text.split("\n");
	if (rows.at(-1) === "") rows.pop();
	return rows.length ? rows : ["(no output)"];
}
export function inputBlock(id: string, name: string, args: unknown): ToolBlock {
	return preparedInputBlock(prepareCall(id, name, args));
}
export function preparedInputBlock(record: PreparedToolCall): ToolBlock {
	const { toolCallId: id, toolName: name } = record;
	let text = record.rawArgsText;
	const metadata: string[] = [];
	const obj = record.rawArgs as Record<string, unknown> | null;
	if (obj && typeof obj === "object" && !Array.isArray(obj)) {
		if (name === "bash" && typeof obj.command === "string") {
			const { command, ...rest } = obj;
			text = command;
			if (Object.keys(rest).length) text += `\n${JSON.stringify(rest, null, 2)}`;
		}
		if (["read", "write", "edit", "grep", "find", "ls"].includes(name)) {
			if (typeof obj.path === "string") metadata.push(`Path: ${obj.path}`);
			else if (["grep", "find", "ls"].includes(name)) metadata.push("Path: .");
		}
	}
	if (record.serializationStatus === "unavailable") metadata.push(record.rawArgsText);
	const fields = record.callSemantic?.argumentFields;
	const readableArguments = fields
		? [
				"Arguments",
				...fields.flatMap((f) => `${f.label}${f.default ? " (default)" : ""}: ${f.value}`.split("\n")),
			]
		: undefined;
	if (readableArguments && obj) {
		const owned = new Set(fields?.flatMap((f) => [...f.consumes]));
		const other = Object.keys(obj).filter((k) => !owned.has(k));
		if (other.length)
			readableArguments.push(
				"Other arguments",
				...other.flatMap((k) => `${k}: ${JSON.stringify(obj[k], null, 2)}`.split("\n")),
			);
	}
	return {
		readableArguments,
		id,
		name: sanitizeDisplay(name),
		kind: "input",
		title: sanitizeDisplay(name),
		lines: lines(sanitizeDisplay(text)),
		metadata: unique(metadata),
		discarded: 0,
		error: false,
		semantic: record.callSemantic,
		sections: [{ caption: "Arguments", lines: lines(sanitizeDisplay(record.rawArgsText)), discarded: 0 }],
	};
}

/** Exact built-in textual contracts, not arbitrary mentions of errors or paths.
 * Bash status can be spoofed by command output; structured exits are not persisted. */
function notice(name: string, line: string): boolean {
	if (name === "read")
		return (
			/^\[Showing lines \d+-\d+ of \d+ \((?:\d+KB|\d+ line) limit\)\. Use offset=\d+ to continue\.\]$/.test(
				line,
			) || /^\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/.test(line)
		);
	if (name === "grep" || name === "find")
		return /^\[Truncated: (?:showing first \d+ of \d+\+? lines(?:, 50KB limit)?|50KB limit|)\. Narrow the search \(subdirectory path, glob, or more specific pattern\) instead of raising the limit\.\]$/.test(
			line,
		);
	if (name === "ls")
		return /^\[(?:\d+ entries limit reached\. (?:Narrow the path — \d+ is the maximum|Use limit=\d+ for more)(?:\. 50KB limit reached)?|50KB limit reached)\]$/.test(
			line,
		);
	if (name === "bash")
		return (
			/^\[output truncated: only the tail is shown above\. Full output saved to .+ — read it with the read tool if you need more \(tip: pipe through head\/tail or narrow the grep to keep output small\)\]$/.test(
				line,
			) ||
			line ===
				"[output truncated: only the tail is shown; saving the full output failed (tip: pipe through head/tail or narrow the grep to keep output small)]" ||
			line === "[full output itself capped at 10MB]"
		);
	if (name === "task")
		return /^\[task\] result truncated to its last 50KB \(dropped \d+ bytes\)\. For large output, have the subagent write a file and report its path instead\.$/.test(
			line,
		);
	// Direct MCP names are <server>_<tool>, not necessarily prefixed "mcp".
	return name.includes("_") && line === "[truncated — kept the last 50KB]";
}
export function outputBlock(result: ToolResult, replay = false): ToolBlock {
	const original = contentText(result.content);
	const originalShown = result.display ?? original;
	const diagnostic = result.isError
		? (original || originalShown).split("\n").find((s) => s.trim() !== "")
		: undefined;
	const persisted = sanitizeDisplay(original);
	let shown = sanitizeDisplay(result.display ?? contentText(result.content));
	const metadata: string[] = [];
	let status = result.isError ? "failed" : "completed";
	if (result.toolName === "task") {
		// Built-in failure handoff: the next indented line is the recovery
		// artifact, not arbitrary paths found in the child's answer.
		const handoff =
			/^(?:task (?:timed out after \d+s|aborted before completion) \(\d+ turns ran\)\.|task failed after \d+ turns: [^\n]+\.|\[task\] child spent all \d+ turns without producing a final answer \(it was still calling tools on the last turn\)\.) work is preserved in the full transcript:\n {2}([^\n]+)/.exec(
				persisted,
			);
		if (handoff?.[1]) metadata.push(`Transcript: ${handoff[1]}`);
	}
	if (result.isError) metadata.push(diagnostic ?? "Tool failed");
	for (const line of `${shown}\n${persisted}`.split("\n")) {
		if (notice(result.toolName, line)) metadata.push(line);
		if (result.toolName === "task") {
			if (/^\[task\] child failed after \d+ turns: .*; partial result above\.$/.test(line)) {
				status = "partial";
				metadata.push(line);
			}
			if (
				/^\[task\] hit the \d+-turn cap; this is the child's wrap-up answer, not a confirmed completion\.$/.test(
					line,
				) ||
				/^\[task\] child spent all \d+ turns without producing a final answer \(it was still calling tools on the last turn\)\. (?:work is preserved in the full transcript:|\(transcript not persisted — work was not saved\))$/.test(
					line,
				)
			) {
				if (status === "completed") status = "limited";
				metadata.push(line);
			}
			if (
				/^\[task\] changes kept in worktree (.+) on branch (\S+)(?: \(.*\))? — merge it in the parent directory with `git merge \2`, or inspect first with `git -C \1 diff`\.$/.test(
					line,
				)
			)
				metadata.push(line);
		}
		if (result.toolName === "bash") {
			const exit = /^Exit code: (-?\d+)$/.exec(line);
			if (exit && Number(exit[1]) !== 0) {
				status = `exit ${exit[1]}`;
				metadata.push(line);
			}
			if (
				/^Error: command (?:timed out after \d+s and was killed|aborted by user)\. Partial output:$/.test(
					line,
				)
			) {
				status = "failed";
				metadata.push(line);
			}
		}
	}
	let kind: ToolBlock["kind"] = "output";
	if (result.toolName === "edit" && !result.isError) {
		const split = shown.indexOf(":\n");
		if (split !== -1) {
			// Keep the summary as budgeted body text, not unrestricted metadata.
			shown = `${shown.slice(0, split)}\n${shown.slice(split + 2)}`;
			kind = "diff";
		} else if (replay) metadata.push("Diff unavailable in saved history");
	}
	if (typeof result.content !== "string")
		for (const block of result.content) {
			if (block.type === "image") {
				const bytes = (block.data.length * 3) / 4;
				const size =
					bytes < 1024
						? `${Math.round(bytes)} B`
						: bytes >= 1024 * 1024
							? `${(bytes / 1024 / 1024).toFixed(1)} MB`
							: `${(bytes / 1024).toFixed(1)} KB`;
				metadata.push(`▪ image [${block.mimeType}, ${size}]`);
			}
		}
	const raw = lines(shown);
	const discarded = kind === "diff" ? 0 : Math.max(0, raw.length - 1000);
	return {
		id: result.toolCallId,
		name: sanitizeDisplay(result.toolName),
		kind,
		title: status === "completed" ? "" : status,
		sections: [
			{
				caption: "Result text",
				originalLines: lines(original).slice(0, 1000),
				lines: lines(persisted).slice(0, 1000),
				discarded: Math.max(0, lines(persisted).length - 1000),
			},
			...(result.display === undefined || result.display === original
				? []
				: [
						{
							caption: "Live display",
							originalLines: lines(originalShown).slice(0, 1000),
							lines: kind === "diff" ? raw : raw.slice(0, 1000),
							discarded: kind === "diff" ? 0 : Math.max(0, raw.length - 1000),
							diff: kind === "diff",
						},
					]),
		],
		lines: discarded ? raw.slice(0, 1000) : raw,
		promotedDiagnostic: diagnostic,
		collapsedLines:
			diagnostic === undefined
				? undefined
				: lines(originalShown)
						.slice(0, 1000)
						.filter((line) => line !== diagnostic)
						.map(sanitizeDisplay),
		metadata: unique(metadata),
		discarded,
		error: status !== "completed",
	};
}

export function createToolSink(append: (block: ToolBlock) => void): ToolPresentationSink {
	const pending = new Map<string, PreparedToolCall>();
	let resolver: ToolPresentationResolver | undefined;
	const prepare = (id: string, name: string, args: unknown): PreparedToolCall => {
		let record = pending.get(id);
		if (!record) {
			record = prepareCall(id, name, args, resolver);
			pending.set(id, record);
		}
		return record;
	};
	return {
		prepare,
		setResolver: (value) => {
			resolver = value;
		},
		start: (id, name, args) => {
			prepare(id, name, args);
		},
		end: (result, replay = false) => {
			const record = pending.get(result.toolCallId);
			const input = record
				? preparedInputBlock(record)
				: {
						...inputBlock(result.toolCallId, result.toolName, null),
						lines: ["Arguments unavailable"],
						metadata: ["Arguments unavailable"],
						sections: [],
					};
			pending.delete(result.toolCallId);
			append(input);
			append({ ...outputBlock(result, replay), semantic: prepareResult(record, result, replay, resolver) });
		},
		finalize: () => {
			for (const record of pending.values()) {
				const input = preparedInputBlock(record);
				append({ ...input, title: `${input.title} · interrupted (no result)`, error: true });
			}
			pending.clear();
		},
		clear: () => pending.clear(),
	};
}
