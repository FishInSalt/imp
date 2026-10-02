import type { ThinkingSection, ThinkingSink } from "../thinking-sink.js";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../tui.js";
import { ToolBlockFold } from "./components/tool-block.js";
import type { ToolColorName } from "./tool-colors.js";
import { createToolSink, type ToolBlock, type ToolPresentationSink } from "./tool-presentation.js";

const USER_BLOCK_BG = "\x1b[48;5;237m";
const RESET = "\x1b[0m";
const LINE_RESET = "\r\x1b[2K";
type LineKind = "plain" | "user" | "status";
type LineEntry = {
	type: "line";
	text: string;
	kind: LineKind;
	complete: boolean;
	cache?: { width: number; rows: string[] };
};
type ThinkingEntry = {
	type: "thinking";
	chunks: string[];
	revision: number;
	open: boolean;
	nonempty: boolean;
	cache?: { revision: number; width: number; open: boolean; rows: string[] };
	placeholder?: { width: number; open: boolean; rows: string[] };
};
type Entry = LineEntry | ThinkingEntry | { type: "component"; component: Component };

/** Ordered semantic transcript. Only feed() interprets ordinary terminal bytes;
 * structural boundaries settle its carry literally rather than losing bytes. */
export class TranscriptSink implements Component {
	private entries: Entry[] = [];
	private current: LineEntry | undefined;
	private carry = "";
	private width = -1;
	private generation = 0;
	private nextId = 0;
	private sections = new Map<number, ThinkingEntry>();
	private hidden = false;
	onUpdate: (() => void) | null = null;

	readonly thinkingSink: ThinkingSink = {
		begin: () => this.beginThinking(),
		setHidden: (hidden) => {
			if (hidden === this.hidden) return;
			this.hidden = hidden;
			this.onUpdate?.();
		},
	};

	private rawToolArguments = false;
	toggleRawToolArguments(): boolean {
		if (!this.toolFolds.some((f) => f.hasStructuredArguments())) return false;
		this.rawToolArguments = !this.rawToolArguments;
		for (const fold of this.toolFolds) fold.setRawArguments(this.rawToolArguments);
		this.onUpdate?.();
		return true;
	}
	readonly toolFolds: ToolBlockFold[] = [];
	private inputFolds = new WeakMap<ToolBlock, ToolBlockFold>();
	/** #task-inline-live-rows (B1) / #tool-inline-live-rows: the input fold for
	 *  a tool_call id, so the owning shell can address a running call's live
	 *  rows (task or tool). Cleared in clear(); "latest writer wins" is safe
	 *  because the shell only addresses currently running calls (tool_call ids
	 *  are not unique across assistant messages). */
	private inputFoldById = new Map<string, ToolBlockFold>();
	/** #tool-result-follows-call: the transcript entry holding a tool_call id's
	 *  input fold, so that call's result block can be spliced directly after it
	 *  instead of landing at the end of the transcript (concurrent `task` calls
	 *  emit every start before any end). Cleared in clear(): a stale anchor would
	 *  splice at position 0. */
	private inputEntryById = new Map<string, Entry>();
	/** #task-inline-live-rows (B1) / #tool-inline-live-rows: pulled by the
	 *  append callback when a call's fold is created after the shell already
	 *  published its rows (trackActivity precedes renderer.event). A PUBLIC
	 *  field mirroring `onUpdate`: the owning shell installs it in start() and
	 *  unbinds it behind an ownership guard in stopTerminal(), because the same
	 *  sink is handed from the one-shot trust-ask shell to the real REPL shell.
	 *  Must be a pure read — it runs inside the append closure. */
	callLiveRowsResolver: ((key: string) => readonly string[] | null) | null = null;
	/** #call-closing-status (design D3): the running timer text for a non-task
	 *  call, pulled at fold-creation time the same way as `callLiveRowsResolver`
	 *  (same public-field + ownership-guard pattern). */
	callSuffixResolver: ((key: string) => string | null) | null = null;
	/** #tool-name-colors (design D5): the resolved name-color token for each
	 *  call, pulled at fold-creation time like `callSuffixResolver` — but set
	 *  once by repl.ts (extension registrations only — A1 removed the shipped
	 *  defaults) and never
	 *  re-bound or cleared: registrations are load-gated, so the value is
	 *  final before any fold exists. */
	toolColorResolver: ((name: string) => ToolColorName | undefined) | null = null;
	/** #tui-tool-elapsed: the clock is injectable for deterministic duration
	 *  tests (production passes nothing — the sink defaults to Date.now). */
	readonly toolSink: ToolPresentationSink;

	constructor(options: { clock?: () => number } = {}) {
		this.toolSink = createToolSink(
			(block) => {
				const fold = new ToolBlockFold(
					block,
					block.kind === "input" ? this.toolColorResolver?.(block.name) : undefined,
				);
				fold.setRawArguments(this.rawToolArguments);
				this.inputFolds.set(block, fold);
				this.toolFolds.push(fold);
				if (block.kind !== "input") {
					// #tool-result-follows-call: a result belongs directly under its own
					// call. Concurrency-safe calls (only `task`) emit every tool_start
					// before any tool_end, so appending would strand all results below all
					// headers. Falls back to append when the call has no known entry
					// (orphan result) or the anchor was cleared.
					const anchor = this.inputEntryById.get(block.id);
					if (anchor !== undefined && this.insertEntryAfter(anchor, fold)) return;
					this.appendEntry(fold);
					return;
				}
				// A reused id lands here too: drop the superseded fold's live rows
				// before re-pointing the map (see `inputFoldById`).
				const displaced = this.inputFoldById.get(block.id);
				if (displaced !== undefined && displaced !== fold) {
					displaced.setLiveRows(null);
					displaced.setRunningSuffix(null);
				}
				this.inputFoldById.set(block.id, fold);
				// #task-inline-live-rows (B1) / #tool-inline-live-rows: pull the
				// rows the shell published before this fold existed, so the first
				// paint is complete.
				const rows = this.callLiveRowsResolver?.(block.id) ?? null;
				if (rows !== null) fold.setLiveRows(rows);
				// #call-closing-status (D3): same pull for the running timer text.
				const suffix = this.callSuffixResolver?.(block.id) ?? null;
				if (suffix !== null) fold.setRunningSuffix(suffix);
				this.inputEntryById.set(block.id, this.appendEntry(fold));
			},
			(previous, next) => {
				const fold = this.inputFolds.get(previous);
				if (!fold) return;
				fold.updateBlock(next);
				this.inputFolds.delete(previous);
				this.inputFolds.set(next, fold);
				this.onUpdate?.();
			},
			options.clock,
			(id) => this.onTerminalDuplicate(id),
		);
	}

	clear(): void {
		this.toolSink.clear();
		this.inputFolds = new WeakMap();
		this.inputFoldById.clear();
		this.inputEntryById.clear();
		this.rawToolArguments = false;
		this.toolFolds.length = 0;
		this.generation++;
		this.entries = [];
		this.sections.clear();
		this.current = undefined;
		this.carry = "";
		this.width = -1;
		this.onUpdate?.();
	}

	appendChild(component: Component): void {
		this.appendEntry(component);
	}

	/** #tool-result-follows-call: the append path's settle boundary, but returning
	 *  the pushed entry so a result fold can be positioned after its own call. */
	private appendEntry(component: Component): Entry {
		this.settleBoundary();
		const entry: Entry = { type: "component", component };
		this.entries.push(entry);
		this.onUpdate?.();
		return entry;
	}

	/** #tool-result-follows-call: place a result fold directly after its call's
	 *  input fold. Returns false when the anchor is no longer in the transcript
	 *  (cleared between the call and its result), so the caller appends instead. */
	private insertEntryAfter(anchor: Entry, component: Component): boolean {
		this.settleBoundary();
		const at = this.entries.indexOf(anchor);
		if (at === -1) return false;
		this.entries.splice(at + 1, 0, { type: "component", component });
		this.onUpdate?.();
		return true;
	}

	/** #task-inline-live-rows (B1) / #tool-inline-live-rows: publish a running
	 *  call's live rows to its input fold. A no-op when the fold is not yet
	 *  known — the shell's resolver covers that case at fold-creation time. */
	setCallLiveRows(key: string, rows: readonly string[] | null): void {
		const fold = this.inputFoldById.get(key);
		if (fold === undefined) return;
		if (fold.setLiveRows(rows)) this.onUpdate?.();
	}

	/** #call-closing-status (D3): publish a running non-task call's timer text
	 *  to its fold's closing slot. Same late-fold and no-op semantics as
	 *  {@link setCallLiveRows}. */
	setCallSuffix(key: string, text: string | null): void {
		const fold = this.inputFoldById.get(key);
		if (fold === undefined) return;
		if (fold.setRunningSuffix(text)) this.onUpdate?.();
	}

	/** #tool-inline-live-rows: a start for an id whose previous lifecycle is
	 *  still terminal is suppressed by the sink (no new fold, no result; the
	 *  provider-synthesized `call_${index}` reuse within one run). The shell may
	 *  already have pushed live rows for that id onto the superseded fold
	 *  (trackActivity precedes renderer.event); clear them and stop addressing
	 *  the fold. The mapping re-registers when a new fold for the id is created
	 *  after finalize()/clear(). */
	private onTerminalDuplicate(id: string): void {
		const fold = this.inputFoldById.get(id);
		if (fold === undefined) return;
		this.inputFoldById.delete(id);
		const clearedLive = fold.setLiveRows(null);
		const clearedSuffix = fold.setRunningSuffix(null);
		if (clearedLive || clearedSuffix) this.onUpdate?.();
	}

	feedUser(text: string): void {
		this.settleBoundary();
		this.pushLine("", "user");
		for (const line of text.split("\n")) this.pushLine(line, "user");
		this.pushLine("", "user");
		this.onUpdate?.();
	}

	/** Only immediately adjacent status entries may replace one another.
	 * Preserve the existing one-row replacement rule at the last render width. */
	feedStatus(text: string): void {
		this.settleBoundary();
		const dimmed = `\x1b[2m${text}\x1b[22m`;
		const last = this.entries.at(-1);
		if (last?.type === "line" && last.kind === "status") {
			const oldRows = this.width > 0 ? this.renderLine(last, this.width).length : 1;
			const newRows = this.width > 0 ? this.wrapLine(dimmed, this.width).length : 1;
			if (oldRows === 1 && newRows === 1) {
				last.text = dimmed;
				last.cache = undefined;
				this.onUpdate?.();
				return;
			}
		}
		this.pushLine(dimmed, "status");
		this.onUpdate?.();
	}

	/** Newlines complete ordinary lines; the only interpreted cursor sequence
	 * is CR + erase-line, including markers split at any chunk boundary. */
	feed = (chunk: string): void => {
		let buffer = this.carry + chunk;
		this.carry = "";
		let changed = false;
		while (buffer.length > 0) {
			if (buffer.startsWith(LINE_RESET)) {
				if (this.current) {
					this.current.text = "";
					this.current.cache = undefined;
				}
				buffer = buffer.slice(LINE_RESET.length);
				changed = true;
				continue;
			}
			if (LINE_RESET.startsWith(buffer)) {
				this.carry = buffer;
				break;
			}
			const newline = buffer.indexOf("\n");
			const reset = buffer.indexOf("\r");
			if (reset !== -1 && (newline === -1 || reset < newline)) {
				if (reset > 0) {
					this.appendText(buffer.slice(0, reset));
					buffer = buffer.slice(reset);
				} else {
					// Not a marker or its prefix: preserve the literal CR.
					this.appendText("\r");
					buffer = buffer.slice(1);
				}
				changed = true;
				continue;
			}
			if (newline === -1) {
				this.appendText(buffer);
				changed = true;
				break;
			}
			this.appendText(buffer.slice(0, newline));
			if (this.current) this.current.complete = true;
			else this.pushLine("", "plain");
			this.current = undefined;
			buffer = buffer.slice(newline + 1);
			changed = true;
		}
		if (changed) this.onUpdate?.();
	};

	render(width: number): string[] {
		const w = Math.max(1, width);
		this.width = w;
		const out: string[] = [];
		for (const entry of this.entries) {
			const rows =
				entry.type === "component"
					? entry.component.render(w)
					: entry.type === "thinking"
						? this.renderThinking(entry, w)
						: !entry.complete && entry.text === ""
							? []
							: this.renderLine(entry, w);
			// Avoid argument-count limits for long transcripts.
			for (const row of rows) out.push(row);
		}
		return out;
	}

	invalidate(): void {
		// Entry caches track their own content, width and presentation state.
	}

	/** Completed ordinary lines only; never exposes retained thinking. */
	completedLines(): readonly string[] {
		return this.entries.flatMap((entry) => (entry.type === "line" && entry.complete ? [entry.text] : []));
	}

	private appendText(text: string): void {
		if (text === "") return;
		if (!this.current) {
			this.current = { type: "line", kind: "plain", text: "", complete: false };
			this.entries.push(this.current);
		}
		this.current.text += text;
		this.current.cache = undefined;
	}

	private settleBoundary(): void {
		this.appendText(this.carry);
		this.carry = "";
		if (this.current) {
			if (this.current.text !== "") this.current.complete = true;
			else this.entries.splice(this.entries.indexOf(this.current), 1);
			this.current = undefined;
		}
	}

	private pushLine(text: string, kind: LineKind): void {
		this.entries.push({ type: "line", text, kind, complete: true });
	}

	private renderLine(entry: LineEntry, width: number): string[] {
		if (entry.cache?.width !== width) {
			entry.cache = {
				width,
				rows: entry.kind === "user" ? this.wrapUserLine(entry.text, width) : this.wrapLine(entry.text, width),
			};
		}
		return entry.cache.rows;
	}

	private beginThinking(): ThinkingSection {
		this.settleBoundary();
		const id = this.nextId++;
		const generation = this.generation;
		this.insertThinking(id);
		this.onUpdate?.();
		// These closures retain only the sink and scalar identity, not the entry.
		return {
			append: (delta) => this.appendThinking(generation, id, delta),
			end: () => this.endThinking(generation, id),
		};
	}

	private insertThinking(id: number): void {
		const entry: ThinkingEntry = { type: "thinking", chunks: [], revision: 0, open: true, nonempty: false };
		this.entries.push(entry);
		this.sections.set(id, entry);
	}

	private appendThinking(generation: number, id: number, delta: string): void {
		if (generation !== this.generation) return;
		const entry = this.sections.get(id);
		if (!entry?.open) return;
		const wasNonempty = entry.nonempty;
		entry.chunks.push(delta);
		entry.revision++;
		entry.nonempty ||= /\S/u.test(delta);
		if (!this.hidden || (!wasNonempty && entry.nonempty)) this.onUpdate?.();
	}

	private endThinking(generation: number, id: number): void {
		if (generation !== this.generation) return;
		const entry = this.sections.get(id);
		if (!entry?.open) return;
		entry.open = false;
		if (entry.nonempty) this.onUpdate?.();
	}

	private renderThinking(entry: ThinkingEntry, width: number): string[] {
		if (!entry.nonempty) return [];
		if (this.hidden) {
			if (entry.placeholder?.width !== width || entry.placeholder.open !== entry.open) {
				const rows = this.wrapLine("\x1b[2mThinking...\x1b[22m", width);
				if (!entry.open) rows.push("");
				entry.placeholder = { width, open: entry.open, rows };
			}
			return entry.placeholder.rows;
		}
		const cache = entry.cache;
		if (cache?.revision !== entry.revision || cache.width !== width || cache.open !== entry.open) {
			// Trimming is projection-only: raw chunks remain untouched. Streaming
			// tails are shown immediately, without waiting for paragraph boundaries.
			const body = entry.chunks.join("").trim();
			const rows: string[] = [];
			for (const line of body.split("\n")) {
				for (const row of this.wrapLine(`\x1b[3m\x1b[2m${line}\x1b[22m\x1b[23m`, width)) rows.push(row);
			}
			if (!entry.open) rows.push("");
			entry.cache = { revision: entry.revision, width, open: entry.open, rows };
			return rows;
		}
		return cache.rows;
	}

	private wrapUserLine(line: string, width: number): string[] {
		const inner = Math.max(1, width - 2);
		return this.wrapLine(line, inner).map((row) => this.fillUserRow(` ${row}`, width));
	}

	private fillUserRow(content: string, width: number): string {
		let body = content;
		if (visibleWidth(body) > width) body = truncateToWidth(body, width);
		const pad = " ".repeat(Math.max(0, width - visibleWidth(body)));
		return `${USER_BLOCK_BG}${body}${pad}${RESET}`;
	}

	private wrapLine(line: string, width: number): string[] {
		if (line === "") return [""];
		const wrapped = wrapTextWithAnsi(line, width);
		if (wrapped.length === 0) return [truncateToWidth(line, width)];
		return wrapped.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
	}
}
