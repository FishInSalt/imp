import type { AgentEvent } from "../core/loop.js";
import type { ToolResult } from "../core/messages.js";
import { bold, dim, firstLine, green, red, renderMarkdownLite, summarizeArgs } from "../format.js";

export type ToolStyle = "two-line" | "one-line";

export interface RendererOptions {
	write: (text: string) => void;
	/** Emit ANSI escapes. Default callers pass `stdout.isTTY === true`. */
	ansi: boolean;
	/** In-place pending tool line (`● … …` rewritten on completion). Interactive only. */
	liveTools: boolean;
	/** "two-line" reproduces print mode byte-for-byte; "one-line" is the REPL style. */
	toolStyle: ToolStyle;
	/** Render streamed assistant text as markdown-lite (paragraph-buffered). REPL only;
	 *  print mode stays byte-identical. */
	markdown?: boolean;
	/** Spinner redraw interval. 0 disables the timer (tests tick manually). Default 120. */
	spinnerIntervalMs?: number;
	/** Injected clock for deterministic tool durations in tests. */
	clock?: () => number;
}

interface PendingTool {
	id: string;
	base: string;
	startedAt: number;
	frame: number;
}

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const THINK_DELAY_MS = 250; // below this, model latency isn't worth a flicker

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Owns ALL conversation output. Tracks one bit — whether the cursor sits
 * mid-line — so status lines (`▪`) never start in the middle of streamed
 * text, and maps agent events to tool lines in either print or REPL style.
 *
 * REPL extras (liveTools/markdown, interactive only):
 *  - a live spinner (`⠏ Thinking… 12s` / `● url_read … ⠹ 37s`) rewritten
 *    in place every tick, so long calls are never silent;
 *  - a `⎿` result summary line under each finished tool call;
 *  - markdown-lite rendering of streamed text, buffered per paragraph.
 */
export class Renderer {
	private readonly options: RendererOptions;
	private readonly clock: () => number;
	private needsNewline = false;
	/** In-flight live tools in start (= call) order. Length 1 reproduces the
	 *  pre-M5b single-slot behavior byte-for-byte; >1 collapses to one
	 *  aggregate spinner line (M5b design §7). */
	private pendingTools: PendingTool[] = [];
	private spinnerTimer: ReturnType<typeof setInterval> | null = null;
	private thinkTimer: ReturnType<typeof setTimeout> | null = null;
	private spinnerLabel: string | null = null;
	private spinnerStartedAt = 0;
	private spinnerFrame = 0;
	private readonly markdown: boolean;
	private mdBuffer = "";

	constructor(options: RendererOptions) {
		this.options = options;
		this.clock = options.clock ?? Date.now;
		this.markdown = options.markdown === true && options.toolStyle === "one-line";
	}

	event(event: AgentEvent): void {
		switch (event.type) {
			case "message_end":
				// The next model call may follow (tool results posted) — start the
				// thinking spinner; endRun/note/tool events cancel it if none comes.
				this.think("Thinking…");
				break;
			case "text_delta":
				this.raw(event.text);
				break;
			case "tool_start":
				this.toolStart(event.toolCallId, event.name, event.args);
				break;
			case "tool_end":
				this.toolEnd(event.result);
				break;
			default:
				// tool_call deltas are folded into the assembled message; message_end
				// is not re-printed — its text was already streamed.
				break;
		}
	}

	/** Dim status line (`▪ …`). Starts on a fresh line when streaming left one open. */
	note(text: string): void {
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		this.write(`${dim(text, this.options.ansi)}\n`);
	}

	/** Red error line. Starts on a fresh line when streaming left one open. */
	error(text: string): void {
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		this.write(`${red(text, this.options.ansi)}\n`);
	}

	/** Plain line (help text, model info). */
	writeLine(text: string): void {
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		this.write(`${text}\n`);
	}

	/** Dim `text` per this renderer's ANSI setting (e.g. /help [source] tags). */
	dim(text: string): string {
		return dim(text, this.options.ansi);
	}

	/** Ends a run's output. `always` reproduces print mode's unconditional "\n". */
	endRun(always = false): void {
		this.stopSpinner();
		this.flushMarkdown();
		if (always) {
			this.write("\n");
			this.needsNewline = false;
		} else {
			this.ensureNewline();
		}
	}

	ensureNewline(): void {
		if (this.needsNewline) {
			this.write("\n");
			this.needsNewline = false;
		}
	}

	// ── spinner ─────────────────────────────────────────────────────────────

	/** A model call is starting (or the next one after a tool batch). Show a
	 *  thinking spinner after a short grace period — instant flicker on fast
	 *  responses is worse than nothing. */
	think(label = "Thinking…"): void {
		if (!this.options.liveTools) return;
		this.clearThinkTimer();
		this.thinkTimer = setTimeout(() => {
			this.thinkTimer = null;
			this.startSpinner(label);
		}, THINK_DELAY_MS);
		this.thinkTimer.unref?.();
	}

	/** Advance the spinner one frame and redraw its line. Exposed for tests. */
	tick(): void {
		if (this.pendingTools.length === 1) {
			const pending = this.pendingTools[0] as PendingTool;
			this.spinnerFrame = pending.frame = (pending.frame + 1) % SPINNER_FRAMES.length;
			this.redrawSpinner(
				`${pending.base}${dim(` ${this.frame()} ${formatElapsed(this.clock() - pending.startedAt)}`, this.options.ansi)}`,
			);
			return;
		}
		if (this.pendingTools.length > 1) {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.redrawSpinner(this.aggregateLine());
			return;
		}
		if (this.spinnerLabel !== null) {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.redrawSpinner(
				dim(`${this.frame()} ${this.spinnerLabel} ${formatElapsed(this.clock() - this.spinnerStartedAt)}`, this.options.ansi),
			);
		}
	}

	private frame(): string {
		return SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0] ?? "·";
	}

	private startSpinner(label: string): void {
		this.clearSpinnerTimer();
		this.spinnerLabel = label;
		this.spinnerStartedAt = this.clock();
		this.spinnerFrame = 0;
		this.pendingTools = [];
		this.write(`\r\x1b[2K${dim(`${this.frame()} ${label}`, this.options.ansi)}`);
		this.needsNewline = false;
		this.scheduleSpinnerTimer();
	}

	private scheduleSpinnerTimer(): void {
		const ms = this.options.spinnerIntervalMs ?? 120;
		if (ms <= 0) return;
		this.spinnerTimer = setInterval(() => this.tick(), ms);
		this.spinnerTimer.unref?.();
	}

	/** Erase the live line (spinner or pending tool) if one is displayed.
	 *  Non-live renderers never displayed one — emit nothing. */
	private stopSpinner(): void {
		this.clearThinkTimer();
		if (!this.options.liveTools) {
			this.pendingTools = [];
			return;
		}
		if (this.spinnerLabel === null && this.pendingTools.length === 0) return;
		this.clearSpinnerTimer();
		this.write("\r\x1b[2K");
		this.spinnerLabel = null;
		this.pendingTools = [];
		this.needsNewline = false;
	}

	private redrawSpinner(line: string): void {
		this.write(`\r\x1b[2K${line}`); // styling is composed by the caller
	}

	private clearThinkTimer(): void {
		if (this.thinkTimer === null) return;
		clearTimeout(this.thinkTimer);
		this.thinkTimer = null;
	}

	private clearSpinnerTimer(): void {
		if (this.spinnerTimer === null) return;
		clearInterval(this.spinnerTimer);
		this.spinnerTimer = null;
	}

	// ── streamed text ───────────────────────────────────────────────────────

	/** Streaming text (event or direct). Spinner-aware; markdown-buffered when enabled. */
	raw(text: string): void {
		this.stopSpinner();
		if (!this.markdown) {
			this.write(text);
			this.needsNewline = !text.endsWith("\n");
			return;
		}
		// Paragraph-buffered markdown-lite: hold streamed deltas until a blank
		// line (or a closed code fence) completes a block, then render it.
		// Append-only, so no width math — CJK-safe.
		this.mdBuffer += text;
		for (;;) {
			const flushpoint = this.findFlushPoint(this.mdBuffer);
			if (flushpoint === null) break;
			const chunk = this.mdBuffer.slice(0, flushpoint);
			this.mdBuffer = this.mdBuffer.slice(flushpoint);
			this.write(renderMarkdownLite(chunk, this.options.ansi));
			this.needsNewline = false;
		}
	}

	/** Byte offset where a complete block ends: blank line, closed fence, or
	 *  end of buffer when forced. Null = hold everything. */
	private findFlushPoint(buffer: string): number | null {
		const fenceEnd = findClosedFence(buffer);
		if (fenceEnd !== null) return fenceEnd;
		const blank = buffer.indexOf("\n\n");
		return blank === -1 ? null : blank + 2;
	}

	private flushMarkdown(): void {
		if (this.mdBuffer === "") return;
		const rest = this.mdBuffer;
		this.mdBuffer = "";
		this.write(renderMarkdownLite(rest, this.options.ansi));
		this.needsNewline = !rest.endsWith("\n");
	}

	// ── tool lines ──────────────────────────────────────────────────────────

	private toolBase(name: string, args: unknown): string {
		return `${dim("● ", this.options.ansi)}${bold(name, this.options.ansi)} ${dim(summarizeArgs(name, args), this.options.ansi)}`;
	}

	private toolStart(id: string, name: string, args: unknown): void {
		this.clearThinkTimer(); // a pending tool supersedes the thinking spinner
		this.flushMarkdown();
		if (this.options.toolStyle === "two-line") {
			// Print mode: byte-identical to the original renderEvent.
			this.write(`\n${dim(`● ${name} ${summarizeArgs(name, args)}`, this.options.ansi)}\n`);
			this.needsNewline = false;
			return;
		}
		this.ensureNewline();
		if (this.pendingTools.length === 0 && this.options.liveTools && this.spinnerLabel !== null) {
			// Replace the thinking spinner's live line.
			this.clearSpinnerTimer();
			this.write("\r\x1b[2K");
			this.spinnerLabel = null;
		}
		const pending: PendingTool = {
			id,
			base: this.toolBase(name, args),
			startedAt: this.clock(),
			frame: this.spinnerFrame,
		};
		this.pendingTools.push(pending);
		if (this.options.liveTools) {
			if (this.pendingTools.length === 1) {
				// Exactly the pre-M5b single-slot draw.
				this.write(`\r\x1b[2K${pending.base}${dim(` ${this.frame()}`, this.options.ansi)}`);
				this.needsNewline = true;
				if (this.spinnerTimer === null) this.scheduleSpinnerTimer();
			} else {
				this.redrawSpinner(this.aggregateLine());
				this.needsNewline = true;
			}
		}
	}

	/** The one live line while several tools run: `⠏ 2 tasks running 12s`.
	 *  Elapsed from the oldest pending. No padding or column math — CJK-safe. */
	private aggregateLine(): string {
		const oldest = Math.min(...this.pendingTools.map((p) => p.startedAt));
		return dim(
			`${this.frame()} ${this.pendingTools.length} tasks running ${formatElapsed(this.clock() - oldest)}`,
			this.options.ansi,
		);
	}

	/** Redraw the in-flight line: the single pending's own line, or the aggregate. */
	private redrawPending(): void {
		if (this.pendingTools.length === 1) {
			const pending = this.pendingTools[0] as PendingTool;
			// Re-sync with the global frame: aggregate-phase ticks advanced the
			// global spinner but not this pending's stored frame — without the
			// sync the animation would jump back on return to single-pending.
			pending.frame = this.spinnerFrame;
			this.redrawSpinner(`${pending.base}${dim(` ${this.frame()}`, this.options.ansi)}`);
		} else if (this.pendingTools.length > 1) {
			this.redrawSpinner(this.aggregateLine());
		}
	}

	private toolEnd(result: ToolResult): void {
		if (this.options.toolStyle === "two-line") {
			const line = result.isError
				? red(`  ✗ ${firstLine(result.content)}`, this.options.ansi)
				: dim(`  → ${firstLine(result.content)}`, this.options.ansi);
			this.write(`${line}\n`);
			this.needsNewline = false;
			return;
		}
		// Capture the matching pending (for base + duration) before removal.
		const pending = this.pendingTools.find((p) => p.id === result.toolCallId) ?? null;
		const others = this.pendingTools.filter((p) => p.id !== result.toolCallId);
		if (this.options.liveTools) {
			if (pending !== null || this.spinnerLabel !== null) {
				this.clearSpinnerTimer();
				this.write("\r\x1b[2K"); // erase the pending/aggregate/thinking line
				this.spinnerLabel = null;
			}
		} else {
			this.stopSpinner();
		}
		this.pendingTools = others;
		const base = pending ? pending.base : `${dim("● ", this.options.ansi)}${bold(result.toolName, this.options.ansi)}`;
		let line: string;
		if (result.isError) {
			line = `${base} ${red("✗", this.options.ansi)} ${red(firstLine(result.content, 120), this.options.ansi)}`;
		} else {
			const seconds = pending ? (this.clock() - pending.startedAt) / 1000 : 0;
			const duration = seconds >= 1 ? ` ${dim(seconds.toFixed(1) + "s", this.options.ansi)}` : "";
			line = `${base} ${green("✓", this.options.ansi)}${duration}`;
		}
		this.write(`${line}\n`);
		// Result summary — Claude-Code-style `⎿` under the call. Display only;
		// the model still receives the full content through the session.
		this.write(`${this.resultSummary(result)}\n`);
		if (others.length > 0 && this.options.liveTools) {
			this.redrawPending(); // the aggregate (or sole survivor's line) stays live
			this.needsNewline = true;
			if (this.spinnerTimer === null) this.scheduleSpinnerTimer();
		} else {
			this.needsNewline = false;
		}
	}

	private resultSummary(result: ToolResult): string {
		// Claude-Code-calibrated gutter: two spaces + ⎿ + two spaces, one style
		// wrap for the whole line (nested wraps reset each other mid-line).
		const lines = result.content.split("\n");
		const head = firstLine(result.content, 80);
		const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
		const body = head === "" ? `(no output)` : `${head}${more}`;
		const text = `  ⎿  ${body}`;
		return result.isError ? red(text, this.options.ansi) : dim(text, this.options.ansi);
	}

	private write(text: string): void {
		this.options.write(text);
	}
}

/** Offset just past a fully closed ``` fence pair at the buffer head, if any. */
function findClosedFence(buffer: string): number | null {
	if (!buffer.trimStart().startsWith("```")) return null;
	const open = buffer.indexOf("```");
	const close = buffer.indexOf("```", open + 3);
	if (close === -1) return null;
	const end = buffer.indexOf("\n", close);
	return end === -1 ? null : end + 1;
}
