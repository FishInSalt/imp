import type { AgentEvent } from "./core/loop.js";
import { contentText, type ToolResult } from "./core/messages.js";
import type { ThinkingSection, ThinkingSink } from "./thinking-sink.js";

/** M13 §8: the display note for an image attachment — base64 length back to
 *  bytes (4/3), human units. Empty for text-only results. */
export function imageSuffix(result: ToolResult, ansi: boolean): string {
	if (typeof result.content === "string") return "";
	let suffix = "";
	for (const block of result.content) {
		if (block.type !== "image") continue;
		const bytes = (block.data.length * 3) / 4;
		const kb = bytes / 1024;
		const size =
			bytes < 1024
				? `${Math.round(bytes)} B`
				: kb >= 1024
					? `${(kb / 1024).toFixed(1)} MB`
					: `${kb.toFixed(1)} KB`;
		suffix += ` ${dim(`▪ image [${block.mimeType}, ${size}]`, ansi)}`;
	}
	return suffix;
}

import {
	bold,
	dim,
	firstLine,
	green,
	red,
	renderMarkdownLite,
	summarizeArgs,
	summarizeResult,
} from "./format.js";

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
	/** TUI mode: user prompts render as full-width background blocks in
	 *  the transcript (pi parity) — the sink-side entry point replaces the
	 *  byte-stream echo. Absent (print/legacy) keeps the `> ` echo bytes. */
	userSink?: (text: string) => void;
	/** Pi-style dim status lines ("Model: x", "Thinking level: x") with
	 *  merge-on-consecutive semantics; absent → note() fallback. */
	statusSink?: (text: string) => void;
	/** pi's hideThinkingBlock at startup (ctrl+t flips the live field). */
	hideThinking?: boolean;
	/** Retained TUI thinking sections; absent preserves the byte-only path. */
	thinkingSink?: ThinkingSink;
	/** TUI mode: successful tool results fold instead of writing the `⎿`
	 *  summary — the fold title (same preview text) replaces it and Ctrl+O
	 *  expands the full content. Print keeps the `⎿` line; bytes unchanged. */
	foldedResults?: boolean;
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

export const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
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
	/** Streamed reasoning trace (#thinking-levels). Deltas stream through the
	 *  same paragraph rule as the answer text (#thinking-stream: pi renders
	 *  thinking incrementally — block by block, never whole-run-buffered).
	 *  Completed blocks (blank line / closed fence) render immediately; the
	 *  incomplete tail stays here until flushThinking. */
	private thinkingBuffer = "";
	/** pi's hideThinkingBlock (ctrl+t): hidden traces render one dim static
	 *  label per section ("Thinking...") instead of the full text. */
	private thinkingHidden = false;
	private semanticThinking: ThinkingSection | undefined;

	get hideThinking(): boolean {
		return this.thinkingHidden;
	}

	set hideThinking(hidden: boolean) {
		this.thinkingHidden = hidden;
		this.options.thinkingSink?.setHidden(hidden);
	}
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
		this.hideThinking = options.hideThinking ?? false;
	}

	event(event: AgentEvent): void {
		switch (event.type) {
			case "message_end":
				this.closeSemanticThinking();
				// The next model call may follow (tool results posted) — start the
				// thinking spinner; endRun/note/tool events cancel it if none comes.
				this.think("Thinking…");
				break;
			case "text_delta":
				this.flushThinking(); // the answer begins — the trace section closes
				this.raw(event.text);
				break;
			case "thinking_delta":
				this.stopSpinner();
				this.streamThinking(event.text);
				break;
			case "tool_start":
				this.flushThinking(); // tool rows follow the trace section
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
		this.closeSemanticThinking();
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		this.write(`${dim(text, this.options.ansi)}\n`);
	}

	/** A pi-style status line (pi showStatus). The TUI's transcript merges
	 *  consecutive statuses into one line; without a sink (print/legacy)
	 *  it degrades to a note — those modes never switch mid-stream. */
	status(text: string): void {
		this.closeSemanticThinking();
		if (this.options.statusSink === undefined) {
			this.note(text);
			return;
		}
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		this.options.statusSink(text);
	}

	/** Submitted user prompt echo (`> …`, one `> ` per physical line).
	 *  Only the TUI calls this: its editor clears the line on submit, so the
	 *  transcript must gain it — print mode relies on the terminal's own
	 *  readline echo and its byte contract stays frozen. */
	user(text: string): void {
		this.closeSemanticThinking();
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		if (this.options.userSink !== undefined) {
			this.options.userSink(text); // TUI: pi-style background block
			return;
		}
		for (const line of text.split("\n")) this.write(`> ${line}\n`);
	}

	/** Red error line. Starts on a fresh line when streaming left one open. */
	error(text: string): void {
		this.closeSemanticThinking();
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		this.write(`${red(text, this.options.ansi)}\n`);
	}

	/** Plain line (help text, model info). */
	writeLine(text: string): void {
		this.closeSemanticThinking();
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		this.write(`${text}\n`);
	}

	/** Dim `text` per this renderer's ANSI setting (e.g. /help [source] tags). */
	dim(text: string): string {
		return dim(text, this.options.ansi);
	}

	/** Whether this renderer emits ANSI (the welcome logo's gradient gate). */
	get ansiEnabled(): boolean {
		return this.options.ansi;
	}

	/** Ends a run's output. `always` reproduces print mode's unconditional "\n". */
	endRun(always = false): void {
		this.stopSpinner();
		this.flushThinking(); // a trace-only turn still renders its section
		// Run boundary: TUI pendings that never completed (aborted tools)
		// belong to this run only — drop them so they cannot leak into the
		// next one's bookkeeping.
		if (!this.options.liveTools) this.pendingTools = [];
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

	/** Replay boundary: settle output without starting a spinner or clearing tools. */
	completeAssistantMessage(): void {
		this.closeSemanticThinking();
		this.flushMarkdown();
		this.ensureNewline();
	}

	private closeSemanticThinking(): void {
		const section = this.semanticThinking;
		this.semanticThinking = undefined;
		section?.end();
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
				dim(
					`${this.frame()} ${this.spinnerLabel} ${formatElapsed(this.clock() - this.spinnerStartedAt)}`,
					this.options.ansi,
				),
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
			// TUI: no live line exists (the activity region owns pending
			// state) and the pendings ARE the completion bookkeeping (base
			// label + duration). A mid-run note (e.g. /status, allowedDuringRun
			// since M11) must not eat them (review P1) — endRun clears at the
			// run boundary instead.
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

	/** A settled reasoning trace (replay path): one dim section, no streaming. */
	thinking(text: string): void {
		if (this.options.thinkingSink !== undefined) {
			this.closeSemanticThinking();
			this.stopSpinner();
			this.streamThinking(text);
			this.closeSemanticThinking();
			return;
		}
		this.thinkingBuffer += text;
		this.flushThinking();
	}

	/** Feed a thinking delta: completed paragraphs render immediately (pi
	 *  parity — the trace grows as it streams, like the answer text). The
	 *  hidden mode buffers whole (pi's hidden label is static). */
	private streamThinking(delta: string): void {
		if (this.options.thinkingSink !== undefined) {
			if (this.semanticThinking === undefined) {
				this.flushMarkdown();
				this.ensureNewline();
				this.semanticThinking = this.options.thinkingSink.begin();
			}
			this.semanticThinking.append(delta);
			return;
		}
		this.thinkingBuffer += delta;
		if (this.hideThinking) return;
		for (;;) {
			const flushpoint = this.findFlushPoint(this.thinkingBuffer);
			if (flushpoint === null) break;
			const chunk = this.thinkingBuffer.slice(0, flushpoint);
			this.thinkingBuffer = this.thinkingBuffer.slice(flushpoint);
			this.writeThinkingBlock(chunk);
		}
	}

	/** Flush the remaining (incomplete) reasoning paragraph — the run's
	 *  answer is beginning, a tool follows, or the stream ended. */
	private flushThinking(): void {
		this.closeSemanticThinking();
		if (this.thinkingBuffer === "") return;
		const text = this.thinkingBuffer.trim();
		this.thinkingBuffer = "";
		if (text === "") return;
		this.stopSpinner();
		// Interleaved case (reasoning after text): the buffered answer
		// paragraphs print FIRST — order follows the stream (review P2).
		this.flushMarkdown();
		this.ensureNewline();
		if (this.hideThinking) {
			// pi's hidden mode: one static label per run of thinking blocks
			// (interactive-mode.ts:351 defaultHiddenThinkingLabel "Thinking...")
			this.write(`${dim("Thinking...", this.options.ansi)}\n\n`);
			return;
		}
		this.writeStyledThinking(text);
		this.write("\n\n");
	}

	/** One completed thinking paragraph. Whitespace-only chunks (leading
	 *  blank lines of the trace) drop out — byte-identical to the old
	 *  whole-trace trim. Order note: pending answer paragraphs flush FIRST
	 *  (the stream sent them before this reasoning run — review P2). */
	private writeThinkingBlock(chunk: string): void {
		const text = chunk.trim();
		if (text === "") return;
		this.stopSpinner();
		this.flushMarkdown();
		this.ensureNewline();
		this.writeStyledThinking(text);
		this.write("\n\n");
		this.needsNewline = false;
	}

	/** The trace bypasses the markdown pipeline (pi styles it as markdown;
	 *  imp's answer stream owns that pipeline — the trace stays plain
	 *  prose), dim + italic per pi's thinkingText theme.
	 *
	 *  Accepted deviation (review P2, #thinking-stream): streaming wraps
	 *  EACH block in its own dim/italic span, so a multi-paragraph trace
	 *  with ansi on differs in escape-pair structure from the replay path's
	 *  single span (visually equivalent; no golden covers it). */
	private writeStyledThinking(text: string): void {
		let styled = dim(text, this.options.ansi);
		if (this.options.ansi) {
			// italic completes the pi look; like dim(), NEVER in piped output
			styled = styled
				.split("\n")
				.map((l) => `\x1b[3m${l}\x1b[23m`)
				.join("\n");
		}
		this.write(styled);
	}

	/** Streaming text (event or direct). Spinner-aware; markdown-buffered when enabled. */
	raw(text: string): void {
		this.closeSemanticThinking();
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
		this.closeSemanticThinking();
		if (this.options.toolStyle === "two-line") {
			const shown = result.display ?? contentText(result.content);
			const line = result.isError
				? red(`  ✗ ${firstLine(shown)}${imageSuffix(result, this.options.ansi)}`, this.options.ansi)
				: dim(`  → ${summarizeResult(result.toolName, shown)}`, this.options.ansi) +
					imageSuffix(result, this.options.ansi);
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
		const base = pending
			? pending.base
			: `${dim("● ", this.options.ansi)}${bold(result.toolName, this.options.ansi)}`;
		let line: string;
		if (result.isError) {
			line = `${base} ${red("✗", this.options.ansi)} ${red(firstLine(contentText(result.content), 120), this.options.ansi)}`;
		} else {
			const seconds = pending ? (this.clock() - pending.startedAt) / 1000 : 0;
			const duration = seconds >= 1 ? ` ${dim(`${seconds.toFixed(1)}s`, this.options.ansi)}` : "";
			line = `${base} ${green("✓", this.options.ansi)}${duration}`;
		}
		this.write(`${line}\n`);
		// Result summary — Claude-Code-style `⎿` under the call. Display only;
		// the model still receives the full content through the session. TUI
		// mode (foldedResults) folds EVERY result instead — errors included
		// (debt clearance: a timed-out bash error's "Partial output" ran to
		// hundreds of lines with no way in). The fold's title carries the same
		// preview, errors with a red arrow; Ctrl+O expands. The `● tool ✗`
		// line above keeps the failure salient either way.
		if (this.options.foldedResults !== true) {
			this.write(`${this.resultSummary(result)}\n`);
		}
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
		const text =
			`  ⎿  ${summarizeResult(result.toolName, result.display ?? contentText(result.content))}` +
			imageSuffix(result, this.options.ansi);
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
