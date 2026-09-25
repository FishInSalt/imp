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
interface RowSpan {
	start: number;
	end: number;
}
/** Offsets refer to the safe source, never to the shortened rendered spelling. */
function* physicalRows(text: string, width: number) {
	const w = Math.max(1, width);
	let offset = 0;
	for (const line of text.split("\n")) {
		let row = "";
		let columns = 0;
		let start = offset;
		let lossless = true;
		let retained: RowSpan[] = [];
		for (const { segment } of segmenter.segment(line)) {
			const size = visibleWidth(segment);
			if (columns + size > w && columns > 0) {
				yield { text: row, start, end: offset, lossless, retained };
				row = "";
				columns = 0;
				start = offset;
				lossless = true;
				retained = [];
			}
			row += size > w ? sanitizeDisplay(truncateToWidth(segment, w, "")) : segment;
			if (size <= w) {
				const previous = retained.at(-1);
				if (previous?.end === offset) previous.end += segment.length;
				else retained.push({ start: offset, end: offset + segment.length });
			} else lossless = false;
			columns += Math.min(w, size);
			offset += segment.length;
		}
		yield { text: row, start, end: offset, lossless, retained };
		offset++;
	}
}
export function* wrappedRows(text: string, width: number, spans: StyleSpan[] = []): Generator<string> {
	for (const row of physicalRows(text, width)) yield styled(row.text, spans, row.start);
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
			? [...(semantic.summary ? [semantic.summary] : []), ...sourceRows, ...(semantic.preview ?? [])]
					.flatMap((line) => line.split("\n"))
					.filter((line) => this.expanded || line !== block.promotedDiagnostic)
			: block.kind === "diff"
				? block.lines
				: (block.collapsedLines ?? block.lines);
		const pathFirst =
			structured &&
			block.builtinName === block.name &&
			["read", "write", "edit", "ls"].includes(block.builtinName) &&
			block.callPath?.field !== undefined;
		const pathField = block.argumentCoverage?.find((f) => f.path);
		const selectedSections: RawSection[] =
			structured && !this.raw
				? [{ caption: "Arguments", lines: (block.readableArguments ?? []).slice(1), discarded: 0 }]
				: (block.sections ?? [{ caption: "", lines: block.lines, discarded: 0 }]).map((section) => ({
						...section,
						caption: structured ? "Raw arguments" : section.caption,
					}));
		// One physical-row plan drives both rendering and selected-mode coverage.
		let plannedRows = 0;
		const sectionOmissions = new Map<RawSection, number>();
		const lineEnds = new Map<RawSection, Map<number, number>>();
		const plan: {
			section: RawSection;
			line: number;
			part: number;
			start: number;
			end: number;
			lossless: boolean;
			retained: RowSpan[];
			text: string;
			prefix: string;
			style: string;
		}[] = [];
		for (const section of selectedSections) {
			const ends = new Map<number, number>();
			lineEnds.set(section, ends);
			let number: number | null = null;
			for (const [index, text] of [section.caption, ...section.lines].entries()) {
				const lineIndex = index - 1;
				const hiddenCaption =
					selectedSections.length === 1 &&
					(section.caption === "Arguments" || section.caption === "Result text" || section.caption === "");
				if (index === 0 && hiddenCaption) continue;
				if (
					index > 0 &&
					pathFirst &&
					!this.raw &&
					pathField &&
					lineIndex >= pathField.readableStart &&
					lineIndex < pathField.readableEnd
				)
					continue;
				let prefix = indent;
				if (structured && !this.raw && block.fieldBodyLines?.includes(lineIndex)) prefix += "  ";
				let style = "";
				if (section.diff && index > 0) {
					if (text.startsWith("@@")) {
						number = Number(/^@@ line (\d+) @@$/.exec(text)?.[1]) || null;
						style = "\x1b[36m";
					} else if (text.startsWith("- ")) style = "\x1b[31m";
					else {
						style = text.startsWith("+ ") ? "\x1b[32m" : DIM;
						if (number !== null) prefix += `${number++} `;
					}
				}
				if (visibleWidth(prefix) >= w) prefix = "";
				let part = 0;
				for (const row of physicalRows(sanitizeDisplay(text), w - visibleWidth(prefix))) {
					plannedRows++;
					if (plannedRows > 1000) {
						sectionOmissions.set(section, (sectionOmissions.get(section) ?? 0) + 1);
						continue;
					}
					plan.push({
						section,
						line: index - 1,
						part,
						...row,
						prefix: part++ === 0 ? prefix : " ".repeat(visibleWidth(prefix)),
						style,
					});
				}
				ends.set(index - 1, plannedRows);
			}
		}
		const evidenceVisible = (raw: string, sources: { section: string; index: number }[]) =>
			sources.some((source) => {
				const section = selectedSections.find((s) => s.sourceId === source.section);
				if (!section || section.diff || section.originalLines?.[source.index] !== raw) return false;
				return (
					(lineEnds.get(section)?.get(source.index) ?? Infinity) <= 1000 &&
					plan.some((r) => r.section === section && r.line === source.index) &&
					plan.filter((r) => r.section === section && r.line === source.index).every((r) => r.lossless)
				);
			});
		const detailPlan: string[] = [];
		let detailRows = 0;
		const detailCapacity = Math.min(100, Math.max(0, 1000 - plannedRows));
		if (!structured && block.sections?.length)
			for (const line of semantic?.detail ?? [])
				for (const row of wrappedRows(sanitizeDisplay(line), w - indent.length)) {
					if (detailRows < detailCapacity) detailPlan.push(row);
					detailRows++;
				}
		const reached = plan;
		const argumentSection = selectedSections[0];
		const rangeReached = (start: number, end: number, complete: boolean): boolean => {
			const all = plan.filter((r) => r.section === argumentSection && r.line >= start && r.line < end);
			return (
				all.length > 0 &&
				(!complete ||
					(all.every((r) => r.lossless) &&
						(lineEnds.get(argumentSection!)?.get(end - 1) ?? Infinity) <= 1000))
			);
		};
		const valueReached = (field: NonNullable<ToolBlock["argumentCoverage"]>[number]): boolean => {
			const spans = this.raw ? field.rawValues : field.readableValues;
			return (spans ?? []).some((span) => {
				const source = argumentSection?.lines[span.line] ?? "";
				const start = sanitizeDisplay(source.slice(0, span.start)).length;
				const end = sanitizeDisplay(source.slice(0, span.end)).length;
				return plan.some(
					(r) =>
						r.section === argumentSection &&
						r.line === span.line &&
						(end === start
							? r.lossless && r.start <= start && r.end >= end
							: r.retained.some((s) => s.end > start && s.start < end)),
				);
			});
		};
		const pathCovered =
			structured &&
			pathField &&
			(!this.raw ||
				!block.callPath ||
				sanitizeDisplay(JSON.stringify(block.callPath.requested)) ===
					JSON.stringify(block.callPath.requested)) &&
			rangeReached(
				this.raw ? pathField.rawStart : pathField.readableStart,
				this.raw ? pathField.rawEnd : pathField.readableEnd,
				true,
			);

		const limit = this.expanded ? 1000 : block.kind === "diff" && !semantic ? 8 : 3;
		let count = 0;
		let summaryOffset = 0;
		const summaryVisible: { start: number; end: number }[] = [];
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
			let remaining = sanitizeDisplay(line);
			do {
				const current = first ? prefix : call ? indent : " ".repeat(visibleWidth(prefix));
				const row = wrappedRows(remaining, w - visibleWidth(current)).next().value ?? "";
				if (count < limit) rows.push(`${styledPrefix(current, style, first ? spans : [])}${row}${RESET}`);
				count++;
				// Oversize defensive clipping may not retain the original glyph spelling.
				let consumed = 0;
				let columns = 0;
				for (const { segment } of segmenter.segment(remaining)) {
					if (segment === "\n") break;
					const size = Math.min(w - visibleWidth(current), visibleWidth(segment));
					if (columns + size > w - visibleWidth(current)) break;
					columns += size;
					consumed += segment.length;
				}
				if (count <= limit && block.commandExcerpt && row === remaining.slice(0, consumed))
					summaryVisible.push({ start: summaryOffset, end: summaryOffset + consumed });
				summaryOffset += consumed;
				remaining = remaining.slice(Math.max(1, consumed));
				first = false;
			} while (remaining.length);
			// Literal LF separates summary occurrences, including empty lines.
			if (count < limit) summaryVisible.push({ start: summaryOffset, end: summaryOffset + 1 });
			summaryOffset++;
		};
		let inline = false;
		let pathCropped = false;
		let emittedSummary = "";
		const pathWidth = Math.max(1, Math.min(w - indent.length, w - visibleWidth(`● ${block.title}  `)));
		const pathText = block.callPath
			? [
					...segmenter.segment(
						(block.callPath.display || '""').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) =>
							c === "\n" ? "\\n" : `\\u{${c.codePointAt(0)!.toString(16)}}`,
						),
					),
				]
					.map(({ segment }) =>
						visibleWidth(segment) > pathWidth
							? [...segment].map((c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).join("")
							: segment,
					)
					.join("")
			: "";
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
			if (pathFirst) {
				const showPath = !this.expanded || !this.raw || !pathCovered;
				if (!showPath) add(header, "", "", spans);
				else if (this.expanded || visibleWidth(prefix) >= w) {
					if (visibleWidth(prefix) < w) {
						const first = wrappedRows(pathText, w - visibleWidth(prefix)).next().value ?? "";
						rows.push(`${styledPrefix(prefix, "", spans)}${first}${RESET}`);
						if (first.length < pathText.length) add(pathText.slice(first.length), indent);
					} else {
						add(header, "", "", spans);
						add(pathText, indent);
					}
				} else {
					const preview = ellipsize(pathText, w - visibleWidth(prefix));
					pathCropped = preview !== pathText;
					const suffix = semantic?.summary ? `  ${sanitizeDisplay(semantic.summary)}` : "";
					if (!pathCropped && visibleWidth(prefix + preview + suffix) <= w)
						emittedSummary = sanitizeDisplay(semantic?.summary ?? "");
					rows.push(
						`${styledPrefix(prefix, "", spans)}${preview}${emittedSummary ? `  ${emittedSummary}` : ""}${RESET}`,
					);
				}
			} else if (!this.expanded && !title.includes("\n") && visibleWidth(prefix) < w && body.length) {
				// Header is chrome; only the summary's wrapped rows consume the budget.
				const start = rows.length;
				emit(body[0] ?? "", false, prefix, spans);
				// Continuation indentation is established by emit, not another header.
				inline = rows.length > start;
			} else add(header, "", "", spans);
		} else if (block.title)
			add(
				this.expanded &&
					block.name === "bash" &&
					block.titleExitEvidence &&
					block.title === block.titleExitEvidence.title &&
					evidenceVisible(block.titleExitEvidence.raw, block.titleExitEvidence.sources)
					? "failed"
					: block.title,
				resultPrefix(),
				/^(?:failed|exit -?\d+|partial|limited)$/.test(block.title) ? RED : "",
			);
		if (block.callPath && !pathFirst && !(this.expanded && pathCovered))
			add(`Path: ${block.callPath.display}`, indent, DIM);
		for (const meta of block.metadata.filter((meta) => {
			if (
				this.expanded &&
				block.name === "bash" &&
				block.promotedEvidence &&
				meta === sanitizeDisplay(block.promotedEvidence.raw) &&
				evidenceVisible(block.promotedEvidence.raw, block.promotedEvidence.sources)
			)
				return false;
			if (call && block.callPath && meta.startsWith("Path: ")) return false;
			if (!call && block.representedLines) return meta === sanitizeDisplay(block.promotedDiagnostic ?? "");
			return true;
		}))
			add(
				meta,
				call ? indent : resultPrefix(),
				meta === sanitizeDisplay(block.promotedDiagnostic ?? "") ? "" : DIM,
			);
		if (this.expanded && block.sections?.length) {
			for (const row of reached) {
				const prefix = !call && marker && row.prefix === indent ? resultPrefix() : row.prefix;
				rows.push(`${styledPrefix(prefix, row.style)}${row.text}${RESET}`);
			}
			count = plannedRows;
			for (const section of selectedSections) {
				const omitted = sectionOmissions.get(section) ?? 0;
				if (omitted) notices.push(`${section.caption}: ${omitted} wrapped rows omitted from this view`);
				if (section.discarded)
					notices.push(`${section.caption}: ${section.discarded} source lines omitted from this view`);
			}
			for (const row of detailPlan) add(row, indent);
			if (detailRows > detailCapacity)
				notices.push(`${detailRows - detailCapacity} semantic detail rows omitted from this view`);
		} else {
			for (const line of pathFirst ? [] : body.slice(inline ? 1 : 0))
				emit(line, block.kind === "diff" && !semantic, call ? indent : resultPrefix());

			for (const section of block.sections ?? [])
				if (section.discarded)
					notices.push(`${section.caption}: ${section.discarded} source lines omitted from this view`);
			if (!block.sections?.length && block.discarded)
				notices.push(`${block.discarded} source lines omitted from this view`);
			let additional = false;
			if (structured) {
				let summaryAvailable = true;
				additional = (block.argumentCoverage ?? []).some((field, index) => {
					if (field.path) return pathFirst && pathCropped; // Expanded host chrome guarantees accessibility.
					if (
						pathFirst &&
						block.summaryOwnership?.some(
							(owner) =>
								owner.fieldIndex === field.fieldIndex &&
								owner.value === field.value &&
								emittedSummary.slice(owner.start, owner.end) === owner.fragment,
						)
					)
						return false;
					if (block.commandExcerpt && field.fieldIndex === 0) {
						const covered = block.commandExcerpt.spans.filter((span) =>
							Array.from({ length: span.end - span.start }, (_, i) => span.start + i).every((at) =>
								summaryVisible.some((r) => r.start <= at && r.end > at),
							),
						);
						let line = field.readableValues?.[0]?.line ?? 0;
						let column = field.readableValues?.[0]?.start ?? 0;
						let rawColumn = (field.rawValues?.[0]?.start ?? 0) + 1;
						let offset = 0;
						for (const point of field.value) {
							const end = offset + point.length;
							const selectedLine = this.raw ? field.rawValues?.[0]?.line : line;
							const source = argumentSection?.lines[selectedLine ?? -1] ?? "";
							const startColumn = this.raw ? rawColumn : column;
							const endColumn =
								startColumn +
								(this.raw ? JSON.stringify(point).length - 2 : point === "\n" ? 0 : point.length);
							const start = sanitizeDisplay(source.slice(0, startColumn)).length;
							const stop = sanitizeDisplay(source.slice(0, endColumn)).length;
							const visible =
								(stop > start || (!this.raw && point === "\n")) &&
								plan.some(
									(r) =>
										r.section === argumentSection &&
										r.line === selectedLine &&
										(stop === start
											? r.lossless && r.start <= start && r.end >= stop
											: r.retained.some((s) => s.end > start && s.start < stop)),
								);
							if (visible && !covered.some((s) => s.sourceStart <= offset && s.sourceEnd >= end)) return true;
							rawColumn += JSON.stringify(point).length - 2;
							if (point === "\n") {
								line++;
								column = 0;
							} else column += point.length;
							offset = end;
						}
						return false;
					}
					const definition = semantic?.argumentFields?.[field.fieldIndex ?? index];
					const label = definition
						? `${definition.label}${definition.default ? " (default)" : ""}: ${field.value}`
						: undefined;
					const exact = block.builtinName
						? block.builtinName === "bash" && field.fieldIndex === 0 && semantic?.summary === field.value
						: semantic?.summary === label || (semantic?.summary === field.value && field.value !== "");
					const summaryRows = [...wrappedRows(sanitizeDisplay(semantic?.summary ?? ""), w - indent.length)]
						.length;
					if (summaryAvailable && exact && summaryRows <= limit && count <= limit) {
						summaryAvailable = false;
						return false;
					}
					return valueReached(field);
				});
			} else if (call) {
				additional =
					count > limit && reached.some((r) => r.line >= 0 && r.text.trim().replace(/[{}[\],"]/g, "") !== "");
			} else if (!semantic && block.collapsedIndices) {
				// Occurrence identity, not visible spelling: repeated and blank payload are evidence.
				let budget = limit;
				const covered = new Map<number, number>();
				for (const index of block.collapsedIndices) {
					const text =
						block.sections?.find((section) => section.caption === block.collapsedSection)?.lines[index] ?? "";
					const size = [...wrappedRows(text, w - indent.length)].length;
					covered.set(index, Math.max(0, Math.min(budget, size)));
					budget -= size;
				}
				additional = reached.some((r) => {
					if (r.line < 0) return false;
					const raw = r.section.originalLines?.[r.line];
					if (raw !== undefined && block.representedLines?.includes(raw)) return false;
					if (r.section.caption === block.collapsedSection) {
						if (!block.collapsedIndices?.includes(r.line)) return false;
						return r.part >= (covered.get(r.line) ?? 0);
					}
					return true;
				});
			} else if (semantic) {
				const available = new Map<string, number>();
				let budget = limit;
				for (const line of body) {
					const parts = [...wrappedRows(sanitizeDisplay(line), w - indent.length)];
					if (parts.length <= budget) available.set(line, (available.get(line) ?? 0) + 1);
					budget -= parts.length;
				}
				// Detail is additive semantic context: duplicate visible rows are not new evidence.
				const visibleSemanticRows = new Set(
					body.flatMap((line) => [...wrappedRows(sanitizeDisplay(line), w - indent.length)]).slice(0, limit),
				);
				for (const row of reached) if (row.line >= 0) visibleSemanticRows.add(row.text);
				const novelDetail = detailPlan.some((row) => !visibleSemanticRows.has(row));
				const checked = new Set<string>();
				additional =
					novelDetail ||
					reached.some((r) => {
						if (r.line < 0) return false;
						const identity = `${r.section.caption}:${r.line}`;
						if (checked.has(identity)) return false;
						checked.add(identity);
						const raw = r.section.originalLines?.[r.line] ?? r.section.lines[r.line]!;
						if (block.representedLines?.includes(raw)) return false;
						const n = available.get(raw) ?? 0;
						if (n > 0) {
							available.set(raw, n - 1);
							return false;
						}
						return true;
					});
			} else {
				// Diff layout includes number prefixes; consume ordered raw occurrences only.
				let remaining = limit;
				additional = reached.some((r) => r.line >= 0 && --remaining < 0);
			}

			if (!this.expanded && additional) notices.push("… more · Ctrl+O");
			else if (count > limit) notices.push(`${count - limit} wrapped rows omitted from this view`);
		}

		for (const notice of block.hostNotices ?? []) {
			const suppressed =
				this.expanded &&
				(((notice.kind === "truncation" || notice.kind === "artifact") && notice.text !== notice.raw) ||
					(block.name === "bash" && (notice.kind === "exit" || notice.kind === "diagnostic"))) &&
				evidenceVisible(notice.raw, notice.sources) &&
				(notice.dependencies ?? []).every((d) => evidenceVisible(d.raw, d.sources));
			if (!suppressed) add(notice.text, call ? indent : resultPrefix(), DIM);
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
