import { type Component, truncateToWidth, visibleWidth } from "../../tui.js";
import { type RawSection, sanitizeDisplay, type ToolBlock } from "../tool-presentation.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
interface StyleSpan {
	start: number;
	end: number;
	style: string;
}
/** Apply host-owned spans only after sanitization and physical-row layout. */
function styled(text: string, spans: StyleSpan[], offset = 0): string {
	let out = "";
	let at = 0;
	for (const span of spans) {
		const start = Math.max(0, span.start - offset);
		const end = Math.min(text.length, span.end - offset);
		if (end <= start) continue;
		out += text.slice(at, start) + span.style + text.slice(start, end) + RESET;
		at = end;
	}
	return out + text.slice(at);
}
function styledPrefix(prefix: string, style: string, spans: StyleSpan[] = []): string {
	// Reset the neutral marker before restoring diff color for numbered lines.
	if (prefix.startsWith("  ⎿ ")) return `  ${DIM}⎿${RESET}${style}${prefix.slice(3)}`;
	return style + styled(prefix, spans);
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Stream screen rows so the expanded cap does not retain the omitted suffix.
 * A glyph wider than the terminal is defensively clamped, as in TranscriptSink. */
export function* wrappedRows(text: string, width: number, spans: StyleSpan[] = []): Generator<string> {
	const w = Math.max(1, width);
	let offset = 0;
	for (const line of text.split("\n")) {
		let row = "";
		let columns = 0;
		let start = offset;
		for (const { segment } of segmenter.segment(line)) {
			const size = visibleWidth(segment);
			if (columns + size > w && row !== "") {
				yield styled(row, spans, start);
				row = "";
				columns = 0;
				start = offset;
			}
			row += size > w ? sanitizeDisplay(truncateToWidth(segment, w, "")) : segment;
			columns += Math.min(w, size);
			offset += segment.length;
			if (row === "") start = offset;
		}
		yield styled(row, spans, start);
		offset++;
	}
}

function ellipsize(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let out = "";
	for (const { segment } of segmenter.segment(text)) {
		if (visibleWidth(out + segment) > width - 1) break;
		out += segment;
	}
	return width > 0 ? `${out}…` : "";
}

export class ToolBlockFold implements Component {
	private expanded = false;
	private raw = false;
	private cache?: { width: number; expanded: boolean; raw: boolean; rows: string[] };
	constructor(readonly block: ToolBlock) {}
	hasStructuredArguments(): boolean {
		return this.block.kind === "input" && this.block.readableArguments !== undefined;
	}
	setRawArguments(value: boolean): void {
		if (this.hasStructuredArguments()) this.raw = value;
	}
	isExpanded(): boolean {
		return this.expanded;
	}
	setExpanded(value: boolean): void {
		this.expanded = value;
	}
	toggle(): void {
		this.expanded = !this.expanded;
	}
	invalidate(): void {
		this.cache = undefined;
	}
	render(width: number): string[] {
		const w = Math.max(1, width);
		if (this.cache?.width === w && this.cache.expanded === this.expanded && this.cache.raw === this.raw)
			return this.cache.rows;
		const block = this.block;
		const call = block.kind === "input";
		const rows: string[] = [];
		const notices: string[] = [];
		const indent = w > 4 ? "    " : "";
		let marker = !call;
		const add = (text: string, prefix = "", style = "", spans: StyleSpan[] = []): void => {
			if (visibleWidth(prefix) >= w) prefix = "";
			let first = true;
			for (const row of wrappedRows(sanitizeDisplay(text), w - visibleWidth(prefix), spans)) {
				rows.push(`${styledPrefix(first ? prefix : " ".repeat(visibleWidth(prefix)), style)}${row}${RESET}`);
				first = false;
			}
		};
		const resultPrefix = (): string => {
			const prefix = marker && w > 4 ? "  ⎿ " : indent;
			marker = false;
			return prefix;
		};
		const semantic = block.semantic;
		const sourceRows =
			semantic?.sources?.map((source) => {
				const title = sanitizeDisplay(source.title.replace(/[\n\r\u2028\u2029]/gu, " ")).replace(
					/\p{Cf}/gu,
					(c) => `\\u${c.codePointAt(0)?.toString(16).padStart(4, "0")}`,
				);
				const host = new URL(source.url).hostname;
				const available = w - indent.length;
				const room = available - visibleWidth(host) - 3;
				return title && room >= 1 ? `${ellipsize(title, room)} — ${host}` : ellipsize(host, available);
			}) ?? [];
		const structured = this.hasStructuredArguments();
		const body = semantic
			? [
					...(semantic.summary || !semantic.sources ? [semantic.summary] : []),
					...sourceRows,
					...(semantic.preview ?? []),
				]
					.flatMap((line) => line.split("\n"))
					.filter((line) => this.expanded || line !== block.promotedDiagnostic)
			: (block.collapsedLines ?? block.lines);
		const limit = this.expanded ? 1000 : block.kind === "diff" && !semantic ? 8 : 3;
		let count = 0;
		let number: number | null = null;
		const emit = (line: string, diff = false, prefix = indent, spans: StyleSpan[] = []): void => {
			let style = "";
			if (diff) {
				if (line.startsWith("@@")) {
					number = Number(/^@@ line (\d+) @@$/.exec(line)?.[1]) || null;
					style = "\x1b[36m";
				} else if (line.startsWith("- ")) style = "\x1b[31m";
				else {
					style = line.startsWith("+ ") ? "\x1b[32m" : "\x1b[2m";
					if (number !== null) {
						prefix += `${number} `;
						number++;
					}
				}
			}
			if (visibleWidth(prefix) >= w) prefix = "";
			let first = true;
			for (const row of wrappedRows(sanitizeDisplay(line), w - visibleWidth(prefix))) {
				if (count < limit)
					rows.push(
						`${styledPrefix(first ? prefix : " ".repeat(visibleWidth(prefix)), style, first ? spans : [])}${row}${RESET}`,
					);
				count++;
				first = false;
			}
		};
		let inline = false;
		if (call) {
			const title = sanitizeDisplay(block.title);
			const decoration = w > 2 ? "● " : "";
			const header = `${decoration}${title}`;
			const name = sanitizeDisplay(block.name);
			const spans: StyleSpan[] = decoration ? [{ start: 0, end: 1, style: DIM }] : [];
			if (title === name || title === `${name} · interrupted (no result)`) {
				spans.push({ start: decoration.length, end: decoration.length + name.length, style: BOLD });
				if (title !== name)
					spans.push({ start: decoration.length + name.length, end: header.length, style: RED });
			}
			const prefix = `${header}  `;
			if (!this.expanded && !title.includes("\n") && visibleWidth(prefix) < w && body.length) {
				// Header is chrome; only the summary's wrapped rows consume the budget.
				const start = rows.length;
				emit(body[0] ?? "", false, prefix, spans);
				// Continuation indentation is established by emit, not another header.
				inline = rows.length > start;
			} else add(header, "", "", spans);
		} else if (block.title)
			add(
				block.title,
				resultPrefix(),
				/^(?:failed|exit -?\d+|partial|limited)$/.test(block.title) ? RED : "",
			);
		for (const meta of block.metadata)
			add(
				meta,
				call ? indent : resultPrefix(),
				meta === sanitizeDisplay(block.promotedDiagnostic ?? "") ? "" : DIM,
			);
		if (this.expanded && block.sections?.length) {
			const sections: RawSection[] =
				structured && !this.raw
					? [{ caption: "Arguments", lines: (block.readableArguments ?? []).slice(1), discarded: 0 }]
					: block.sections.map((section) => ({
							...section,
							caption: structured ? "Raw arguments" : section.caption,
						}));
			for (const section of sections) {
				const before = Math.max(0, count - limit);
				for (const line of [section.caption, ...section.lines])
					emit(line, "diff" in section && section.diff === true, call ? indent : resultPrefix());
				const omitted = Math.max(0, count - limit) - before;
				if (omitted) notices.push(`${section.caption}: ${omitted} wrapped rows omitted from this view`);
				if (section.discarded)
					notices.push(`${section.caption}: ${section.discarded} source lines omitted from this view`);
			}
			if (!structured) {
				let detailRows = 0;
				const available = Math.min(100, Math.max(0, limit - count));
				for (const line of semantic?.detail ?? [])
					for (const row of wrappedRows(sanitizeDisplay(line), w - indent.length)) {
						if (detailRows < available) add(row, indent);
						detailRows++;
					}
				if (detailRows > available)
					notices.push(`${detailRows - available} semantic detail rows omitted from this view`);
			}
		} else {
			for (const line of body.slice(inline ? 1 : 0))
				emit(line, block.kind === "diff" && !semantic, call ? indent : resultPrefix());

			for (const section of block.sections ?? [])
				if (section.discarded)
					notices.push(`${section.caption}: ${section.discarded} source lines omitted from this view`);
			if (!block.sections?.length && block.discarded)
				notices.push(`${block.discarded} source lines omitted from this view`);
			// Compute actual selected-mode reachability, including captions, without hooks.
			let remaining = 1000;
			const reachable: string[] = [];
			const sections: RawSection[] =
				structured && !this.raw
					? [{ caption: "Arguments", lines: (block.readableArguments ?? []).slice(1), discarded: 0 }]
					: (block.sections ?? [{ caption: "", lines: block.lines, discarded: 0 }]).map((section) => ({
							...section,
							caption: structured ? "Raw arguments" : section.caption,
						}));
			for (const section of sections) {
				for (const [index, line] of [section.caption, ...section.lines].entries()) {
					for (const row of wrappedRows(sanitizeDisplay(line), w - indent.length)) {
						if (
							remaining > 0 &&
							index > 0 &&
							!(
								block.promotedDiagnostic !== undefined &&
								section.originalLines?.[index - 1] === block.promotedDiagnostic
							)
						)
							reachable.push(row);
						remaining--;
					}
				}
			}
			if (!structured) {
				let detailBudget = Math.min(100, Math.max(0, remaining));
				for (const line of semantic?.detail ?? [])
					for (const row of wrappedRows(sanitizeDisplay(line), w - indent.length))
						if (detailBudget-- > 0) reachable.push(row);
			}
			const normalize = (text: string): string => sanitizeDisplay(text).replace(/\s/gu, "");
			// Chrome and raw JSON formatting are not evidence of additional content.
			const visible = normalize(rows.join("") + block.metadata.join(""));
			const reached = normalize(reachable.join(""));
			let additional = false;
			if (structured) {
				const fields = semantic?.argumentFields ?? [];
				let fieldBudget = 1000 - [...wrappedRows("Arguments", w - indent.length)].length;
				let uncovered = visible;
				additional = fields.some((field) => {
					const label = `${field.label}${field.default ? " (default)" : ""}: `;
					const fieldRows = [...wrappedRows(sanitizeDisplay(label + field.value), w - indent.length)];
					const allocated = fieldRows.slice(0, Math.max(0, fieldBudget));
					fieldBudget -= fieldRows.length;
					// Reachability belongs to this field, not another field with the same value.
					const selected = this.raw
						? field.consumes
								.map((key) => normalize(`${JSON.stringify(key)}:`))
								.find((key) => reached.includes(key))
						: normalize(allocated.join(""));
					if (!selected) return false;
					const labelled = normalize(label + field.value);
					const value = normalize(field.value);
					// A summary consisting solely of the value (notably a full URL) is
					// sufficient, but one occurrence cannot cover multiple field identities.
					const coverage = uncovered.includes(labelled)
						? labelled
						: value && normalize(semantic?.summary ?? "") === value && !field.default
							? value
							: !this.raw && uncovered.includes(selected)
								? selected
								: undefined;
					if (!coverage || !uncovered.includes(coverage)) return true;
					uncovered = uncovered.replace(coverage, "");
					return false;
				});
				const owned = new Set(fields.flatMap((field) => [...field.consumes]));
				// Unknown fields are retained in readable form and in raw JSON.
				additional ||= (block.readableArguments ?? []).slice(1).some((line) => {
					const key = line.split(":")[0] ?? "";
					return (
						!owned.has(key) &&
						!fields.some(
							(field) => line.startsWith(`${field.label}:`) || line.startsWith(`${field.label} (default):`),
						) &&
						line !== "Other arguments" &&
						!!normalize(line) &&
						!visible.includes(normalize(line)) &&
						(this.raw
							? reached.replaceAll('"', "").includes(normalize(line).replaceAll('"', ""))
							: reached.includes(normalize(line)))
					);
				});
			} else if (call) {
				// Generic JSON alternate formatting alone never warrants an action.
				additional =
					count > limit &&
					reached.length > 0 &&
					!visible.includes(normalize(body.join(""))) &&
					reachable.some(
						(row) => !!normalize(row).replace(/[{}[\],"]/g, "") && !visible.includes(normalize(row)),
					);
			} else {
				let unseen = visible;
				additional = reachable.some((row) => {
					const value = normalize(row);
					if (!value) return false;
					const at = unseen.indexOf(value);
					if (at < 0) return true;
					unseen = unseen.slice(0, at) + unseen.slice(at + value.length);
					return false;
				});
			}
			if (!this.expanded && additional) notices.push("… more · Ctrl+O");
			else if (count > limit) notices.push(`${count - limit} wrapped rows omitted from this view`);
		}

		if (notices.length) add(notices.join(" · "), indent, DIM);
		this.cache = { width: w, expanded: this.expanded, raw: this.raw, rows };
		return rows;
	}
}

/** Strict three-row total. Status/elapsed goes first, omission replaces row 3. */
export class ToolActivity implements Component {
	private sanitized?: string;
	private preview?: { width: number; rows: string[] };
	constructor(
		private status: string,
		private label: string,
	) {}
	update(status: string, label = this.label): void {
		this.status = status;
		if (label !== this.label) {
			this.label = label;
			this.invalidate();
		}
	}
	invalidate(): void {
		this.sanitized = undefined;
		this.preview = undefined;
	}
	render(width: number): string[] {
		const w = Math.max(1, width);
		const rows = [truncateToWidth(sanitizeDisplay(this.status).replaceAll("\n", " "), w, "…")];
		if (this.preview?.width !== w) {
			this.sanitized ??= sanitizeDisplay(this.label);
			const preview: string[] = [];
			for (const row of wrappedRows(this.sanitized, w)) {
				if (preview.length === 2) {
					preview[1] = truncateToWidth("… omitted", w, "");
					break;
				}
				preview.push(row);
			}
			this.preview = { width: w, rows: preview };
		}
		rows.push(...this.preview.rows);
		return rows.map((r) => `\x1b[2m${r}${RESET}`);
	}
}
