import { contentText, type ToolResult } from "../core/messages.js";
import { builtinExcerpt } from "../core/tools/presentation.js";
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
	sourceId?: string;
	/** Original identity for diagnostic comparisons; never rendered. */
	originalLines?: string[];
	caption: string;
	lines: string[];
	discarded: number;
	diff?: boolean;
}
export interface HostNotice {
	kind: "exit" | "truncation" | "artifact" | "diagnostic";
	artifact?: {
		completeness: "full" | "partial" | "unavailable";
		interrupted: boolean;
		prefixCapped: boolean;
	};
	raw: string;
	text: string;
	sources: { section: string; index: number }[];
	/** Each dependency group requires one complete original occurrence. */
	dependencies?: { raw: string; sources: { section: string; index: number }[] }[];
}
export interface ArgumentCoverage {
	value: string;
	fieldIndex?: number;
	readableValues?: { line: number; start: number; end: number }[];
	rawValues?: { line: number; start: number; end: number }[];
	readableStart: number;
	readableEnd: number;
	rawStart: number;
	rawEnd: number;
	rawRanges?: readonly (readonly [number, number])[];
	path: boolean;
}
export interface SourceEvidence {
	raw: string;
	sources: { section: string; index: number }[];
}
export interface ToolBlock {
	promotedEvidence?: SourceEvidence;
	titleExitEvidence?: SourceEvidence & { title: string };
	summaryOwnership?: {
		fieldIndex: number;
		key: string;
		value: string;
		fragment: string;
		start: number;
		end: number;
	}[];
	commandExcerpt?: ReturnType<typeof builtinExcerpt>;
	builtinName?: string;
	fieldBodyLines?: number[];
	callPath?: { requested: string; display: string; field?: number };
	argumentCoverage?: ArgumentCoverage[];
	hostNotices?: HostNotice[];
	collapsedIndices?: number[];
	collapsedSection?: string;
	representedLines?: string[];
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
	const obj =
		record.rawArgs !== null && typeof record.rawArgs === "object" && !Array.isArray(record.rawArgs)
			? (record.rawArgs as Record<string, unknown>)
			: null;
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
	const requested = obj && typeof obj.path === "string" ? obj.path : undefined;
	const field = fields?.findIndex((f) =>
		requested === undefined
			? f.default === true && f.label === "Path" && f.value === "." && f.consumes.length === 0
			: f.consumes.length === 1 &&
				f.consumes[0] === "path" &&
				(f.value === requested || (requested === "" && f.value === '"" (effective: .)')),
	);
	const callPath = metadata.some((m) => m.startsWith("Path: "))
		? {
				requested: requested ?? ".",
				display: field !== undefined && field >= 0 ? fields![field]!.value : (requested ?? "."),
				field: field !== undefined && field >= 0 ? field : undefined,
			}
		: undefined;

	const argumentCoverage: ArgumentCoverage[] = [];
	const readableArguments = fields ? ["Arguments"] : undefined;
	const fieldBodyLines: number[] = [];
	const rawRanges = new Map<string, [number, number]>();
	const rawValues = new Map<string, { line: number; start: number; end: number }[]>();
	let rawAt = 1;
	if (obj)
		for (const key of Object.keys(obj)) {
			// Both representations come from the detached snapshot, exactly as rawArgsText.
			const valueLines = JSON.stringify(obj[key], null, 2).split("\n");
			rawRanges.set(key, [rawAt, rawAt + valueLines.length]);
			rawValues.set(
				key,
				valueLines.map((line, i) => ({
					line: rawAt + i,
					start: i === 0 ? 2 + JSON.stringify(key).length + 2 : 2,
					end: (i === 0 ? 2 + JSON.stringify(key).length + 2 : 2) + line.length,
				})),
			);
			rawAt += valueLines.length;
		}
	const appendField = (label: string, value: string, keys: readonly string[], fieldIndex?: number) => {
		if (!readableArguments) return;
		const start = readableArguments.length - 1;
		const values: { line: number; start: number; end: number }[] = [];
		if (record.builtinName && (value.includes("\n") || label.includes("\n"))) {
			readableArguments.push(...`${label}:`.split("\n"));
			for (const line of value.split("\n")) {
				const index = readableArguments.length - 1;
				fieldBodyLines.push(index);
				values.push({ line: index, start: 0, end: line.length });
				readableArguments.push(line);
			}
		} else {
			const prefix = `${label}: `;
			const rows = `${prefix}${value}`.split("\n");
			readableArguments.push(...rows);
			const labelLines = prefix.split("\n");
			const first = labelLines.length - 1;
			for (let i = first; i < rows.length; i++)
				values.push({
					line: start + i,
					start: i === first ? labelLines[first]!.length : 0,
					end: rows[i]!.length,
				});
		}
		const ranges = keys.flatMap((key) => (rawRanges.has(key) ? [rawRanges.get(key)!] : []));
		argumentCoverage.push({
			value,
			fieldIndex,
			readableValues: values,
			rawValues: keys.flatMap((key) => rawValues.get(key) ?? []),
			readableStart: start,
			readableEnd: readableArguments.length - 1,
			rawStart: ranges[0]?.[0] ?? -1,
			rawEnd: ranges.at(-1)?.[1] ?? -1,
			rawRanges: ranges,
			path: fieldIndex !== undefined && fieldIndex === callPath?.field,
		});
	};
	for (const [index, f] of (fields ?? []).entries())
		appendField(`${f.label}${f.default ? " (default)" : ""}`, f.value, f.consumes, index);
	if (readableArguments && obj) {
		const owned = new Set(fields?.flatMap((f) => [...f.consumes]));
		const other = Object.keys(obj).filter((key) => !owned.has(key));
		if (other.length) readableArguments.push("Other arguments");
		for (const key of other) appendField(key, JSON.stringify(obj[key], null, 2), [key]);
	}

	// Only captured builtin hooks may associate scalar request facts with a summary.
	// Construct the expected fragments in builtin order; never search summary prose.
	const summaryOwnership: NonNullable<ToolBlock["summaryOwnership"]> = [];
	if (obj && record.builtinName === name && (name === "read" || name === "ls")) {
		const keys = name === "read" ? ["offset", "limit"] : ["limit"];
		let expected = "";
		for (const key of keys) {
			if (!Object.hasOwn(obj, key)) continue;
			const value = obj[key];
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
			if (name === "ls" && (!Number.isInteger(value) || value > 5000)) continue;
			const fragment =
				key === "offset"
					? `from line ${value}`
					: name === "read"
						? `up to ${value} requested`
						: `up to ${value} entries requested`;
			if (expected) expected += " · ";
			const start = expected.length;
			expected += fragment;
			const fieldIndex = fields?.findIndex(
				(f) => !f.default && f.consumes.length === 1 && f.consumes[0] === key && f.value === String(value),
			);
			if (fieldIndex !== undefined && fieldIndex >= 0)
				summaryOwnership.push({
					fieldIndex,
					key,
					value: String(value),
					fragment,
					start,
					end: expected.length,
				});
		}
		if (expected !== record.callSemantic?.summary) summaryOwnership.length = 0;
	}
	return {
		summaryOwnership,
		commandExcerpt:
			record.builtinName === "bash" &&
			fields?.[0]?.consumes[0] === "command" &&
			typeof obj?.command === "string"
				? builtinExcerpt(obj.command, 160, true)
				: undefined,
		readableArguments,
		fieldBodyLines,
		builtinName: record.builtinName,
		callPath,
		argumentCoverage,
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
			) ||
			/^\[Line \d+ is \d+(?:\.\d+)?(?:KB|MB), exceeds the 50KB limit\. Use bash: sed -n '\d+p' .+ \| head -c 51200\]$/.test(
				line,
			) ||
			/^\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/.test(line)
		);
	if (name === "grep" || name === "find")
		return (
			line === "[stderr truncated: showing first 2000 bytes or fewer.]" ||
			/^\[Truncated: (?:showing first \d+ lines; at least \d+ complete lines observed; total unknown; 1048576-byte collection limit(?:, 50KB limit)?|showing first \d+ of \d+\+? lines(?:, 50KB limit)?|50KB limit|)\. Narrow the search \(subdirectory path, glob, or more specific pattern\) instead of raising the limit\.\]$/.test(
				line,
			)
		);
	if (name === "ls")
		return (
			/^\[Directory type unavailable for \d+ displayed entries; names shown without a directory suffix\.\]$/.test(
				line,
			) ||
			/^\[(?:\d+ entries limit reached\. (?:Narrow the path — \d+ is the maximum|Use limit=\d+ for more)(?:\. 50KB limit reached)?|50KB limit reached)\]$/.test(
				line,
			)
		);
	if (name === "bash")
		return (
			/^\[output truncated: only the tail is shown above\. (?:Full output saved to .+|Partial output saved to .+ \((?:artifact prefix capped; per-stream limit 10485760 bytes|command interrupted; all observed bytes retained|command interrupted; artifact prefix capped; per-stream limit 10485760 bytes)\)) — read it with the read tool if you need more \(tip: pipe through head\/tail or narrow the grep to keep output small\)\]$/.test(
				line,
			) ||
			line ===
				"[output truncated: only the tail is shown; saving the full output failed (tip: pipe through head/tail or narrow the grep to keep output small)]" ||
			line === "[full output itself capped at 10MB]" ||
			line ===
				"[output truncated: only the tail is shown; saving the output artifact failed (tip: pipe through head/tail or narrow the grep to keep output small)]" ||
			/^\[(?:stdout|stderr) preview starts within a line\.\]$/.test(line) ||
			/^\[(?:stdout|stderr) artifact incomplete: retained first \d+ of \d+ observed bytes \(10485760-byte per-stream limit\)\.\]$/.test(
				line,
			)
		);
	if (name === "task")
		return /^\[task\] result truncated to its last 50KB \(dropped \d+ bytes\)\. For large output, have the subagent write a file and report its path instead\.$/.test(
			line,
		);
	// Direct MCP names are <server>_<tool>, not necessarily prefixed "mcp".
	return name.includes("_") && line === "[truncated — kept the last 50KB]";
}
function conciseNotice(raw: string, historicalCap: boolean): string {
	const artifact =
		/^\[output truncated: only the tail is shown above\. (Full|Partial) output saved to (.+) — read it with the read tool if you need more \(tip: pipe through head\/tail or narrow the grep to keep output small\)\]$/.exec(
			raw,
		);
	if (artifact) {
		const qualifier = historicalCap && artifact[1] === "Full" ? " (prefix capped; 10MB)" : "";
		return `Output truncated; tail preview. ${historicalCap ? "Partial" : artifact[1]} output: ${artifact[2]}${qualifier}`;
	}
	if (
		/^\[output truncated: only the tail is shown; saving the (?:full output|output artifact) failed /.test(
			raw,
		)
	)
		return "Output truncated; tail preview. Output artifact unavailable (save failed).";
	if (raw === "[full output itself capped at 10MB]") return "Output artifact prefix capped at 10MB.";
	if (/^\[(?:stdout|stderr) preview starts within a line\.\]$/.test(raw)) return raw.slice(1, -2);
	if (raw.startsWith("[task] result truncated")) return raw.split(". For large output")[0]!;
	if (raw.startsWith("[Truncated:"))
		return raw.replace(
			" (subdirectory path, glob, or more specific pattern) instead of raising the limit",
			"",
		);
	return raw;
}
export function outputBlock(result: ToolResult, replay = false): ToolBlock {
	const original = contentText(result.content);
	const originalShown = result.display ?? original;
	const diagnostic = result.isError
		? (original || originalShown).split("\n").find((s) => s.trim() !== "")
		: undefined;
	const persisted = sanitizeDisplay(original);
	let shown = sanitizeDisplay(originalShown);
	// Raw line indices prove visibility only when sanitization preserves the
	// line-by-line correspondence. Multiline control strings can consume LFs.
	const contentAligned = original.split("\n").map(sanitizeDisplay).join("\n") === persisted;
	const displayAligned = originalShown.split("\n").map(sanitizeDisplay).join("\n") === shown;
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
	for (const line of `${originalShown}\n${original}`.split("\n")) {
		if (notice(result.toolName, line)) metadata.push(line);
		if (
			(result.toolName === "grep" || result.toolName === "find") &&
			/^Error: (?:rg|fd) (?:terminated by signal [A-Z0-9]+|ended without an exit status)\.$/.test(line)
		) {
			status = "failed";
			metadata.push(line);
		}
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
				/^Error: command (?:timed out after \d+(?:\.\d+)?s and was killed|aborted by user|terminated by signal [A-Z0-9]+|ended without an exit status)\. Partial output:$/.test(
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
	const promoted = [...new Set(metadata)];
	const exits = promoted.filter((line) => /^Exit code: -?\d+$/.test(line));
	if (exits.length > 1 && status.startsWith("exit ")) status = "failed";
	const exitInTitle = exits.length === 1 && status === `exit ${exits[0]!.slice("Exit code: ".length)}`;
	const capped = promoted.includes("[full output itself capped at 10MB]");
	const sourceOccurrences = (raw: string) =>
		[
			...(contentAligned ? [{ section: "result-content", text: original }] : []),
			...(originalShown === original || !displayAligned
				? []
				: [{ section: "result-display", text: originalShown }]),
		].flatMap(({ section, text }) =>
			lines(text).flatMap((line, index) => (line === raw ? [{ section, index }] : [])),
		);
	const hostNotices: HostNotice[] = promoted
		.filter((line) => line !== diagnostic)
		.map((raw) => ({
			artifact:
				notice(result.toolName, raw) && raw.startsWith("[output truncated:")
					? {
							completeness: raw.startsWith("[output truncated: only the tail is shown; saving the ")
								? "unavailable"
								: raw.startsWith(
											"[output truncated: only the tail is shown above. Partial output saved to ",
										) || capped
									? "partial"
									: "full",
							interrupted:
								/\(command interrupted; (?:all observed bytes retained|artifact prefix capped; per-stream limit 10485760 bytes)\) — read it/.test(
									raw,
								),
							prefixCapped:
								capped ||
								/\((?:command interrupted; )?artifact prefix capped; per-stream limit 10485760 bytes\) — read it/.test(
									raw,
								),
						}
					: undefined,
			kind: /^Exit code: -?\d+$/.test(raw)
				? "exit"
				: notice(result.toolName, raw)
					? "truncation"
					: "diagnostic",
			raw,
			text: notice(result.toolName, raw) ? conciseNotice(raw, capped) : raw,
			sources: sourceOccurrences(raw),
			dependencies:
				capped && raw.startsWith("[output truncated: only the tail is shown above.")
					? [
							{
								raw: "[full output itself capped at 10MB]",
								sources: sourceOccurrences("[full output itself capped at 10MB]"),
							},
						]
					: [],
		}));
	const represented = new Set(promoted);
	if (diagnostic !== undefined) represented.add(diagnostic);
	const source = lines(originalShown);
	const removed = source.map((line) => represented.has(line));
	// Only blank separators touching a promoted host line are removed.
	for (let i = 0; i < source.length; ) {
		if (source[i] !== "") {
			i++;
			continue;
		}
		const start = i;
		while (source[i] === "") i++;
		if (removed[start - 1] || removed[i]) for (let j = start; j < i; j++) removed[j] = true;
	}
	const collapsedIndices = source.slice(0, 1000).flatMap((_, index) => (removed[index] ? [] : [index]));
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
				sourceId: "result-content",
				originalLines: contentAligned ? lines(original).slice(0, 1000) : undefined,
				lines: lines(persisted).slice(0, 1000),
				discarded: Math.max(0, lines(persisted).length - 1000),
			},
			...(result.display === undefined || result.display === original
				? []
				: [
						{
							caption: "Live display",
							sourceId: "result-display",
							originalLines: displayAligned ? lines(originalShown).slice(0, 1000) : undefined,
							lines: kind === "diff" ? raw : raw.slice(0, 1000),
							discarded: kind === "diff" ? 0 : Math.max(0, raw.length - 1000),
							diff: kind === "diff",
						},
					]),
		],
		lines: discarded ? raw.slice(0, 1000) : raw,
		promotedEvidence:
			diagnostic === undefined ? undefined : { raw: diagnostic, sources: sourceOccurrences(diagnostic) },
		titleExitEvidence: exitInTitle
			? { raw: exits[0]!, sources: sourceOccurrences(exits[0]!), title: status }
			: undefined,
		promotedDiagnostic: exitInTitle && diagnostic === exits[0] ? undefined : diagnostic,
		collapsedLines:
			kind === "diff"
				? undefined
				: displayAligned
					? collapsedIndices.map((index) => sanitizeDisplay(source[index]!))
					: raw.slice(0, 1000),
		representedLines: [...represented],
		collapsedIndices: kind === "diff" || !displayAligned ? undefined : collapsedIndices,
		collapsedSection:
			result.display === undefined || result.display === original ? "Result text" : "Live display",
		hostNotices: hostNotices.filter((n) => !(n.kind === "exit" && exitInTitle)),
		metadata: promoted.map(sanitizeDisplay),
		discarded,
		error: status !== "completed",
	};
}

/** Updates are optional for append-only consumers; interruption styling requires them. */
export function createToolSink(
	append: (block: ToolBlock) => void,
	update?: (previous: ToolBlock, next: ToolBlock) => void,
): ToolPresentationSink {
	const entries = new Map<string, { record?: PreparedToolCall; input?: ToolBlock; terminal: boolean }>();
	let resolver: ToolPresentationResolver | undefined;
	let finalizing = false;
	const prepare = (id: string, name: string, args: unknown): PreparedToolCall => {
		let entry = entries.get(id);
		if (!entry) {
			entry = { record: prepareCall(id, name, args, resolver), terminal: false };
			entries.set(id, entry);
		}
		// An orphan result is terminal; never resolve a late call hook.
		entry.record ??= prepareCall(id, name, null, undefined);
		return entry.record;
	};
	return {
		prepare,
		setResolver: (value) => {
			resolver = value;
		},
		start: (id, name, args) => {
			prepare(id, name, args);
			const entry = entries.get(id)!;
			if (entry.terminal || entry.input) return;
			entry.input = preparedInputBlock(entry.record!);
			append(entry.input);
		},
		end: (result, replay = false) => {
			let entry = entries.get(result.toolCallId);
			if (entry?.terminal) return;
			if (!entry) {
				entry = { terminal: false };
				entries.set(result.toolCallId, entry);
			}
			entry.terminal = true;
			if (!entry.input) {
				entry.input = entry.record
					? preparedInputBlock(entry.record)
					: {
							...inputBlock(result.toolCallId, result.toolName, null),
							lines: ["Arguments unavailable"],
							metadata: ["Arguments unavailable"],
							sections: [],
						};
				append(entry.input);
			}
			append({
				...outputBlock(result, replay),
				semantic: prepareResult(entry.record, result, replay, resolver),
			});
		},
		finalize: () => {
			if (finalizing) return;
			finalizing = true;
			const pending = [...entries.values()].filter((entry) => !entry.terminal && entry.input);
			// Keep terminal identities through update callbacks, including reentrant finalize.
			for (const entry of entries.values()) entry.terminal = true;
			try {
				for (const entry of pending) {
					const input = entry.input!;
					update?.(input, {
						...input,
						title: `${input.title} · interrupted (no result)`,
						error: true,
					});
				}
			} finally {
				entries.clear();
				finalizing = false;
			}
		},
		clear: () => entries.clear(),
	};
}
