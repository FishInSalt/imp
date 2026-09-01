import type { AgentEvent } from "../core/loop.js";
import type { ToolResult } from "../core/messages.js";
import { dim, firstLine, red, summarizeArgs } from "../format.js";

export type ToolStyle = "two-line" | "one-line";

export interface RendererOptions {
	write: (text: string) => void;
	/** Emit ANSI escapes. Default callers pass `stdout.isTTY === true`. */
	ansi: boolean;
	/** In-place pending tool line (`● … …` rewritten on completion). Interactive only. */
	liveTools: boolean;
	/** "two-line" reproduces print mode byte-for-byte; "one-line" is the REPL style. */
	toolStyle: ToolStyle;
	/** Injected clock for deterministic tool durations in tests. */
	clock?: () => number;
}

interface PendingTool {
	id: string;
	text: string;
	startedAt: number;
}

/**
 * Owns ALL conversation output. Tracks one bit — whether the cursor sits
 * mid-line — so status lines (`▪`) never start in the middle of streamed
 * text, and maps agent events to tool lines in either print or REPL style.
 */
export class Renderer {
	private readonly options: RendererOptions;
	private readonly clock: () => number;
	private needsNewline = false;
	private pendingTool: PendingTool | null = null;

	constructor(options: RendererOptions) {
		this.options = options;
		this.clock = options.clock ?? Date.now;
	}

	event(event: AgentEvent): void {
		switch (event.type) {
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
		this.ensureNewline();
		this.write(`${dim(text, this.options.ansi)}\n`);
	}

	/** Red error line. Starts on a fresh line when streaming left one open. */
	error(text: string): void {
		this.ensureNewline();
		this.write(`${red(text, this.options.ansi)}\n`);
	}

	/** Plain line (help text, model info). */
	writeLine(text: string): void {
		this.ensureNewline();
		this.write(`${text}\n`);
	}

	/** Dim `text` per this renderer's ANSI setting (e.g. /help [source] tags). */
	dim(text: string): string {
		return dim(text, this.options.ansi);
	}

	/** Streaming text. Updates the newline state. */
	raw(text: string): void {
		this.write(text);
		this.needsNewline = !text.endsWith("\n");
	}

	ensureNewline(): void {
		if (this.needsNewline) {
			this.write("\n");
			this.needsNewline = false;
		}
	}

	/** Ends a run's output. `always` reproduces print mode's unconditional "\n". */
	endRun(always = false): void {
		if (always) {
			this.write("\n");
			this.needsNewline = false;
		} else {
			this.ensureNewline();
		}
	}

	private write(text: string): void {
		this.options.write(text);
	}

	private toolStart(id: string, name: string, args: unknown): void {
		const text = `● ${name} ${summarizeArgs(name, args)}`;
		if (this.options.toolStyle === "two-line") {
			// Print mode: byte-identical to the original renderEvent.
			this.write(`\n${dim(text, this.options.ansi)}\n`);
			this.needsNewline = false;
			return;
		}
		this.ensureNewline();
		this.pendingTool = { id, text, startedAt: this.clock() };
		if (this.options.liveTools) {
			// Pending line without trailing newline; rewritten in place on tool_end.
			this.write(`\r\x1b[2K${dim(`${text} …`, this.options.ansi)}`);
			this.needsNewline = true;
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
		const pending = this.pendingTool;
		this.pendingTool = null;
		const base = pending ? pending.text : `● ${result.toolName}`;
		if (this.options.liveTools) this.write("\r\x1b[2K");
		let line: string;
		if (result.isError) {
			line = dim(`${base} ✗ `, this.options.ansi) + red(firstLine(result.content, 120), this.options.ansi);
		} else {
			const seconds = pending ? (this.clock() - pending.startedAt) / 1000 : 0;
			const duration = seconds >= 1 ? ` ${seconds.toFixed(1)}s` : "";
			line = dim(`${base} ✓`, this.options.ansi) + duration;
		}
		this.write(`${line}\n`);
		this.needsNewline = false;
	}
}
