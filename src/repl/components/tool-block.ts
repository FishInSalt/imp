import { formatToolElapsed } from "../../format.js";
import { type Component, truncateToWidth, visibleWidth } from "../../tui.js";
import { type ToolColor, toolColorSgr } from "../tool-colors.js";
import { type RawSection, sanitizeDisplay, type ToolBlock } from "../tool-presentation.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
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

/** The host's alert color for extension-declared spans, without a leading reset
 *  (`styled` closes each span itself). */
const WARN = "\x1b[1;31m";

/** Clip, drop and sort extension-declared offsets; overlaps merge — the host
 *  never trusts extension math (the same stance `applyWarnSpans` takes). */
function alertRanges(spans: unknown, length: number): Array<[number, number]> {
	if (!Array.isArray(spans)) return [];
	const cleaned: Array<[number, number]> = [];
	for (const candidate of spans) {
		if (!Array.isArray(candidate) || candidate.length < 2) continue;
		const [rawStart, rawEnd] = candidate as [unknown, unknown];
		if (typeof rawStart !== "number" || typeof rawEnd !== "number") continue;
		if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
		const start = Math.max(0, Math.floor(rawStart));
		const end = Math.min(length, Math.floor(rawEnd));
		if (start < end) cleaned.push([start, end]);
	}
	cleaned.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of cleaned) {
		const last = merged[merged.length - 1];
		if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/** Split a preview into its sanitized header name and body, or undefined when it
 *  is unusable (wrong kind, non-string or empty fields) — malformed previews
 *  render nothing. */
function splitPreview(preview: unknown): { name: string; body: string; spans: unknown } | undefined {
	if (typeof preview !== "object" || preview === null) return undefined;
	const fields = preview as { kind?: unknown; tool?: unknown; text?: unknown; warnSpans?: unknown };
	if (fields.kind !== "command") return undefined;
	if (typeof fields.tool !== "string" || typeof fields.text !== "string") return undefined;
	// A tool name never spans lines (the transcript header does the same).
	const name = sanitizeDisplay(fields.tool).replace(/[\n\r\u2028\u2029]/gu, " ");
	const body = sanitizeDisplay(fields.text);
	if (name === "" || body === "") return undefined;
	return { name, body, spans: fields.warnSpans };
}

/** #confirm-prompt (Phase 2 D7): the plain one-line form of a command preview
 *  (`● tool  text`, no ANSI) — the note surface's carrier on hosts without a
 *  picker. Returns "" for anything unusable. */
export function commandPreviewText(preview: unknown): string {
	const parts = splitPreview(preview);
	return parts === undefined ? "" : `● ${parts.name}  ${parts.body}`;
}

/** #confirm-prompt (Phase 2 D7): render a command preview in the transcript's
 *  call-header idiom — dim `●`, bold tool name, two spaces, then the command.
 *  Both fields are sanitized (pi-tui's `Text` preserves control bytes), the warn
 *  spans are styled with the host's own alert color and closed with a reset, and
 *  no completion suffix is added: the call has not run. Wrapping is left to the
 *  `Text` block that carries the result (the same mechanism the detail block
 *  uses), so a long command wraps without repeating the header. Returns "" for
 *  anything unusable. */
export function renderCommandHeader(
	preview: unknown,
	/** #tool-name-colors: the host's resolver — same contract and defaults as
	 *  the fold's `nameColor` (undefined / `"none"` stay legacy). */
	colorFor?: (name: string) => ToolColor | undefined,
): string {
	const parts = splitPreview(preview);
	if (parts === undefined) return "";
	const decoration = "● ";
	const head = `${decoration}${parts.name}  `;
	const token = colorFor?.(parts.name);
	const nameStyle = token === undefined || token === "none" ? BOLD : `${BOLD}${toolColorSgr(token)}`;
	const spans: StyleSpan[] = [
		{ start: 0, end: 1, style: DIM },
		{ start: decoration.length, end: decoration.length + parts.name.length, style: nameStyle },
	];
	for (const [start, end] of alertRanges(parts.spans, parts.body.length)) {
		spans.push({ start: head.length + start, end: head.length + end, style: WARN });
	}
	return styled(`${head}${parts.body}`, spans);
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
	/** #task-inline-live-rows (B1): the running task's overview, painted under
	 *  the call header. Transient — set while the task is in flight and cleared
	 *  when it ends; never part of the block or the session. */
	private liveRows: readonly string[] | null = null;
	private liveRevision = 0;
	/** #call-closing-status (design D3): the running timer text for a non-task
	 *  call, rendered in the same closing slot the completion suffix will close
	 *  with. Transient — set while the call is in flight, cleared when it ends;
	 *  never part of the block or the session. */
	private runSuffix: string | null = null;
	private suffixRevision = 0;
	private cache?: {
		width: number;
		expanded: boolean;
		raw: boolean;
		live: number;
		suffix: number;
		rows: string[];
	};
	constructor(
		public block: ToolBlock,
		/** #tool-name-colors: the resolved token for the call's name span;
		 *  undefined / `"none"` keep the legacy bold-only bytes. */
		private readonly nameColor: ToolColor | undefined = undefined,
	) {}
	/** The name-span style: BOLD, plus the token's SGR when one applies. */
	private nameStyle(): string {
		const token = this.nameColor;
		return token === undefined || token === "none" ? BOLD : `${BOLD}${toolColorSgr(token)}`;
	}
	updateBlock(block: ToolBlock): void {
		this.block = block;
		this.invalidate();
	}
	/** The live-row channel (B1). Returns whether anything changed (so callers
	 *  can skip a repaint); a no-op on non-input folds, so a result fold can
	 *  never carry live rows. */
	setLiveRows(rows: readonly string[] | null): boolean {
		if (this.block.kind !== "input") return false;
		const next = rows === null || rows.length === 0 ? null : rows;
		const same =
			this.liveRows === null
				? next === null
				: next !== null &&
					this.liveRows.length === next.length &&
					this.liveRows.every((row, index) => row === next[index]);
		if (same) return false;
		this.liveRows = next;
		this.liveRevision++;
		this.invalidate();
		return true;
	}
	/** #call-closing-status (design D3): the running timer channel; returns
	 *  whether anything changed. A no-op on non-input folds, like setLiveRows. */
	setRunningSuffix(text: string | null): boolean {
		if (this.block.kind !== "input") return false;
		const next = text === null || text === "" ? null : text;
		if (this.runSuffix === next) return false;
		this.runSuffix = next;
		this.suffixRevision++;
		this.invalidate();
		return true;
	}
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
		if (
			this.cache?.width === w &&
			this.cache.expanded === this.expanded &&
			this.cache.raw === this.raw &&
			this.cache.live === this.liveRevision &&
			this.cache.suffix === this.suffixRevision
		)
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
		const emit = (
			line: string,
			diff = false,
			prefix = indent,
			spans: StyleSpan[] = [],
			firstSuffix = "",
		): void => {
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
			// #tui-tool-elapsed (I3/N-B): the suffix's width is reserved from the
			// FIRST row's wrap budget and from its consumed scan feeding
			// summaryVisible, so occurrence accounting stays in sync; continuation
			// rows keep the full budget. `firstSuffix` is pre-styled by the caller
			// (Amendment 1: green ✓ + dim time) — never wrap it in DIM.
			const suffixW = firstSuffix === "" ? 0 : visibleWidth(firstSuffix);
			let first = true;
			let remaining = sanitizeDisplay(line);
			do {
				const current = first ? prefix : call ? indent : " ".repeat(visibleWidth(prefix));
				const budget = w - visibleWidth(current) - (first ? suffixW : 0);
				const row = wrappedRows(remaining, budget).next().value ?? "";
				if (count < limit)
					rows.push(
						`${styledPrefix(current, style, first ? spans : [])}${row}${first && suffixW > 0 ? firstSuffix : ""}${RESET}`,
					);
				count++;
				// Oversize defensive clipping may not retain the original glyph spelling.
				let consumed = 0;
				let columns = 0;
				for (const { segment } of segmenter.segment(remaining)) {
					if (segment === "\n") break;
					const size = Math.min(budget, visibleWidth(segment));
					if (columns + size > budget) break;
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
		let pathCropped = false;
		let emittedSummary = "";
		/** #call-closing-status (design D8): the planned continuation rows of a
		 *  call's inline info, pushed by the tail loop in place of `emit`. */
		let plannedTail: string[] | undefined;
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
				spans.push({
					start: decoration.length,
					end: decoration.length + name.length,
					style: this.nameStyle(),
				});
				if (title !== name)
					spans.push({ start: decoration.length + name.length, end: header.length, style: RED });
			}
			const prefix = `${header}  `;
			// #tui-tool-elapsed (design I1-I6; amendments 1-3) + #call-closing-status
			// (design D1/D5): the call's closing slot carries the completion suffix —
			// a marker, green ✓ or red ✗ when the result failed, unconditional for
			// measured calls, plus a dim time when the call took ≥1s — or, while the
			// call still runs, the shell's `Ns` timer text (Amendment 1). The completion
			// wins over the timer; an interrupted block carries neither. The slot
			// closes the call info's last visible non-empty row (D2/D8); `slotWidth`
			// measures the plain form and is reserved from that row's budget before
			// layout; below an 8-column floor the slot is omitted entirely. Header
			// fallback rows keep the legacy first-row placement (E1) and carry the
			// slot only when the header fits with it (I4).
			const elapsedMs = block.elapsedMs;
			const measured = elapsedMs !== undefined;
			const elapsedText = measured && elapsedMs >= 1000 ? formatToolElapsed(elapsedMs) : "";
			const failed = block.failed === true;
			const glyph = failed ? "✗" : "✓";
			const marker = failed ? `${RED}✗` : `${GREEN}✓`;
			const durPlain = !measured ? "" : elapsedText === "" ? ` ${glyph}` : ` ${glyph} ${elapsedText}`;
			const dur = !measured
				? ""
				: elapsedText === ""
					? ` ${marker}`
					: ` ${marker}${RESET} ${DIM}${elapsedText}`;
			const running =
				!block.error && !measured && this.runSuffix !== null ? sanitizeDisplay(this.runSuffix) : null;
			const slotPlain = block.error ? "" : measured ? durPlain : running !== null ? ` ${running}` : "";
			const slotWidth = visibleWidth(slotPlain);
			const slotStyled = block.error ? "" : measured ? dur : running !== null ? ` ${DIM}${running}` : "";
			// Content rows reserve against their own budget with an 8-column floor
			// (I3, retargeted by #call-closing-status to the closing row); header
			// fallback rows measure the bare `header` against the full width (I4).
			const reserve = slotWidth > 0 && w - visibleWidth(prefix) - slotWidth >= 8 ? slotWidth : 0;
			const addHeader = (): void => {
				if (slotWidth > 0 && visibleWidth(header) + slotWidth <= w) {
					rows.push(`${styledPrefix(header, "", spans)}${slotStyled}${RESET}`);
					return;
				}
				add(header, "", "", spans);
			};
			if (pathFirst) {
				const showPath = !this.expanded || !this.raw || !pathCovered;
				if (!showPath) addHeader();
				else if (this.expanded || visibleWidth(prefix) >= w) {
					if (visibleWidth(prefix) < w) {
						const first = wrappedRows(pathText, w - visibleWidth(prefix) - reserve).next().value ?? "";
						rows.push(`${styledPrefix(prefix, "", spans)}${first}${reserve > 0 ? slotStyled : ""}${RESET}`);
						if (first.length < pathText.length) add(pathText.slice(first.length), indent);
					} else {
						addHeader();
						add(pathText, indent);
					}
				} else {
					const preview = ellipsize(pathText, w - visibleWidth(prefix) - reserve);
					pathCropped = preview !== pathText;
					const suffix = semantic?.summary ? `  ${sanitizeDisplay(semantic.summary)}` : "";
					if (!pathCropped && visibleWidth(prefix + preview + suffix + (reserve > 0 ? slotPlain : "")) <= w)
						emittedSummary = sanitizeDisplay(semantic?.summary ?? "");
					rows.push(
						`${styledPrefix(prefix, "", spans)}${preview}${emittedSummary ? `  ${emittedSummary}` : ""}${reserve > 0 ? slotStyled : ""}${RESET}`,
					);
				}
			} else if (!this.expanded && !title.includes("\n") && visibleWidth(prefix) < w && body.length) {
				// #call-closing-status (design D2/D8): plan the whole inline info,
				// pick the last visible non-empty row among the first `limit` rows,
				// and re-lay that row at its slot-reduced budget; the slot closes
				// the last of its chunks that remains visible.
				type InfoChunk = {
					text: string;
					prefix: string;
					spans: StyleSpan[];
					budget: number;
					consumed: number;
					match: boolean;
					line: number;
				};
				const layoutInfoLine = (
					line: string,
					firstPrefix: string,
					firstSpans: StyleSpan[],
					reserved: number,
				): InfoChunk[] => {
					const out: InfoChunk[] = [];
					let remaining = sanitizeDisplay(line);
					let first = true;
					do {
						const current = first ? firstPrefix : indent;
						const budget = Math.max(1, w - visibleWidth(current) - reserved);
						const text = wrappedRows(remaining, budget).next().value ?? "";
						let consumed = 0;
						let columns = 0;
						for (const { segment } of segmenter.segment(remaining)) {
							if (segment === "\n") break;
							const size = Math.min(budget, visibleWidth(segment));
							if (columns + size > budget) break;
							columns += size;
							consumed += segment.length;
						}
						out.push({
							text,
							prefix: current,
							spans: first ? firstSpans : [],
							budget,
							consumed,
							match: text === remaining.slice(0, consumed),
							line: -1,
						});
						remaining = remaining.slice(Math.max(1, consumed));
						first = false;
					} while (remaining.length);
					return out;
				};
				const infoPlan: InfoChunk[] = [];
				for (const [index, line] of body.entries()) {
					const chunks = layoutInfoLine(line, index === 0 ? prefix : indent, index === 0 ? spans : [], 0);
					for (const chunk of chunks) {
						chunk.line = index;
						infoPlan.push(chunk);
					}
				}
				const visibleEnd = Math.min(infoPlan.length, limit);
				let targetIndex = visibleEnd - 1;
				for (let index = 0; index < visibleEnd; index++)
					if (infoPlan[index]!.text !== "") targetIndex = index;
				const target = infoPlan[targetIndex]!;
				let finalPlan = infoPlan;
				let slotIndex = -1;
				if (slotWidth > 0 && target.budget - slotWidth >= 8) {
					const relaid = layoutInfoLine(target.text, target.prefix, target.spans, slotWidth);
					for (const chunk of relaid) chunk.line = target.line;
					finalPlan = [...infoPlan.slice(0, targetIndex), ...relaid, ...infoPlan.slice(targetIndex + 1)];
					slotIndex = Math.min(targetIndex + relaid.length - 1, limit - 1);
				}
				// Occurrence accounting for the argument-coverage checks mirrors
				// `emit` over the final plan; the reduced budget applies to every
				// re-laid chunk (design D8 step 4).
				count = 0;
				let previousLine = -1;
				for (const chunk of finalPlan) {
					if (chunk.line !== previousLine) {
						if (previousLine >= 0) {
							if (count < limit) summaryVisible.push({ start: summaryOffset, end: summaryOffset + 1 });
							summaryOffset++;
						}
						previousLine = chunk.line;
					}
					count++;
					if (count <= limit && block.commandExcerpt && chunk.match)
						summaryVisible.push({ start: summaryOffset, end: summaryOffset + chunk.consumed });
					summaryOffset += chunk.consumed;
				}
				if (previousLine >= 0) {
					if (count < limit) summaryVisible.push({ start: summaryOffset, end: summaryOffset + 1 });
					summaryOffset++;
				}
				plannedTail = [];
				for (const [index, chunk] of finalPlan.entries()) {
					if (index >= limit) break;
					const row = `${styledPrefix(chunk.prefix, "", chunk.spans)}${chunk.text}${index === slotIndex ? slotStyled : ""}${RESET}`;
					if (chunk.line === 0) rows.push(row);
					else plannedTail.push(row);
				}
			} else addHeader();
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
		// #task-inline-live-rows (B1): anchor the live overview at the end of the
		// header chain, so every header-emitting branch (addHeader, the pathFirst
		// rows, and the collapsed body-first row) is covered; body/path/metadata
		// rows follow it.
		const headerEnd = rows.length;
		if (block.callPath && !pathFirst && !(this.expanded && pathCovered))
			add(`Path: ${block.callPath.display}`, indent, DIM);
		for (const meta of block.metadata.filter((meta) => {
			if (
				this.expanded &&
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
			if (plannedTail !== undefined) {
				for (const row of plannedTail) rows.push(row);
			} else {
				for (const line of pathFirst ? [] : body)
					emit(line, block.kind === "diff" && !semantic, call ? indent : resultPrefix());
			}

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
		if (this.liveRows !== null) {
			// One row group per observer source; the shell bounds each group to the
			// activity-region shape (three rows). Rendering all groups matches the
			// old region, which stacked one component per source.
			const live = this.liveRows.map((row) => `${DIM}${ellipsize(activityText(row), w)}${RESET}`);
			rows.splice(headerEnd, 0, ...live);
		}
		this.cache = {
			width: w,
			expanded: this.expanded,
			raw: this.raw,
			live: this.liveRevision,
			suffix: this.suffixRevision,
			rows,
		};
		return rows;
	}
}

/** Strict three-row total. Status/elapsed goes first, omission replaces row 3. */
export class ToolActivity implements Component {
	private taskRows?: string[];
	setTaskRows(rows: string[]): void {
		this.taskRows = rows;
	}
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
		if (this.taskRows)
			return this.taskRows.slice(0, 3).map((row) => `${DIM}${ellipsize(activityText(row), w)}${RESET}`);
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

/** Bound untrusted fields before sanitizer and layout, without cutting surrogate pairs. */
export function activityText(text: string): string {
	const cap = (value: string, size: number): string => {
		const end = value.length > size && /[\uD800-\uDBFF]/u.test(value[size - 1]!) ? size - 1 : size;
		return value.slice(0, end);
	};
	return cap(sanitizeDisplay(cap(text, 2048)).replace(/[\n\r\u2028\u2029]/gu, " "), 4096);
}
export function activityCount(value: number): string {
	return !Number.isFinite(value) || value < 0 ? "0" : value > 9999 ? "9999+" : String(Math.floor(value));
}
