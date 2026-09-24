import type { ThinkingSection, ThinkingSink } from "../thinking-sink.js";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../tui.js";

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

	clear(): void {
		this.generation++;
		this.entries = [];
		this.sections.clear();
		this.current = undefined;
		this.carry = "";
		this.width = -1;
		this.onUpdate?.();
	}

	appendChild(component: Component): void {
		this.settleBoundary();
		this.entries.push({ type: "component", component });
		this.onUpdate?.();
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
