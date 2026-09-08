import {
	Container,
	Editor,
	type EditorOptions,
	type EditorTheme,
	isKeyRelease,
	isYes,
	matchesKey,
	ProcessTerminal,
	type Terminal,
	Text,
	TUI,
} from "../tui.js";
import type { LineInput, LineInputEvents } from "./line-input.js";
import type { TranscriptSink } from "./transcript.js";

export interface TuiShellOptions extends LineInputEvents {
	/** Shared with the Renderer's write sink — the transcript IS the output. */
	transcript: TranscriptSink;
	/** Injected in tests; default binds the real process terminal. */
	terminal?: Terminal;
	editorOptions?: EditorOptions;
}

/** Identity functions throughout — the pre-M9 plain aesthetic. */
export function tuiEditorTheme(): EditorTheme {
	return {
		borderColor: (s) => s,
		selectList: {
			selectedPrefix: (s) => s,
			selectedText: (s) => s,
			description: (s) => s,
			scrollInfo: (s) => s,
			noMatch: (s) => s,
		},
	};
}

/**
 * The pi-tui REPL shell (M9). Layout follows pi's interactive mode:
 *
 *   TUI
 *   ├─ transcript (TranscriptSink — the Renderer's output, hosted)
 *   ├─ ask line   ([y/N] question while one is pending; hidden otherwise)
 *   ├─ marker     ("> " idle / "+ " active)
 *   └─ editor     (always last; focused)
 *
 * Semantics are the readline shell's, byte-for-byte where bytes are visible:
 * the ask FIFO (lines answer pending questions first; Ctrl+C declines;
 * EOF declines all), interrupt routing, and the "> "/"+ " markers. Known
 * deviations (parity ledger, to revisit as M9 polishes):
 *  - Ctrl+D with text in the editor goes to the editor (readline would
 *    delete-forward); Ctrl+D on an empty editor stays EOF — with or
 *    without a pending ask (a typed draft always wins over drain+EOF).
 *  - Ctrl+C always interrupts (the editor's selection-copy binding is
 *    unreachable while an ask is pending; plain interrupt otherwise).
 *    Kitty key-RELEASE events are filtered first — one press is one
 *    interrupt (M9 review P0: press+release double-fired).
 *  - Submissions are trim()-ed by the editor (readline delivered raw).
 *  - Multi-line editor submits arrive as ONE line event with embedded
 *    newlines (readline split them into separate events); a multi-line
 *    answer to an [y/N] ask is judged on the whole text, so "y\nfootnote"
 *    declines and loses the footnote.
 */
export class TuiShell implements LineInput {
	private readonly options: TuiShellOptions;
	private tui: TUI | null = null;
	private editor: Editor | null = null;
	private askContainer = new Container();
	private marker: Text | null = null;
	private history: string[] = [];
	private closed = false;
	/** Terminal restore ran (close's deferred stop or the process-exit hook). */
	private stopped = false;
	private detachInput: (() => void) | null = null;
	private onProcessSigint: (() => void) | null = null;
	private onStdinEnd: (() => void) | null = null;
	/** Same FIFO contract as ReplInput.pendingAsks. */
	private pendingAsks: Array<{ question: string; resolve: (approved: boolean) => void }> = [];

	constructor(options: TuiShellOptions) {
		this.options = options;
	}

	start(): void {
		if (this.tui !== null || this.closed) return;
		const terminal = this.options.terminal ?? new ProcessTerminal();
		const tui = new TUI(terminal, true); // hardware cursor: IME candidate positioning
		this.tui = tui;
		this.options.transcript.onUpdate = () => tui.requestRender();

		const marker = new Text("> ");
		this.marker = marker;
		const editorBox = new Container();
		const editor = new Editor(tui, tuiEditorTheme(), this.options.editorOptions);
		this.editor = editor;
		editor.onSubmit = (text) => this.submit(text);
		editorBox.addChild(editor);

		tui.addChild(this.options.transcript);
		tui.addChild(this.askContainer);
		tui.addChild(marker);
		tui.addChild(editorBox);
		tui.setFocus(editor);
		tui.start();

		// Pre-focus routing (runs before the editor sees the key): the
		// machine's interrupt/EOF semantics own Ctrl+C / Ctrl+D outright,
		// except Ctrl+D with text, which stays an editing key.
		this.detachInput = tui.addInputListener((data) => {
			// Kitty protocol reports key RELEASES as their own sequences; a
			// release must not count as a second press (M9 review P0).
			if (isKeyRelease(data)) return undefined;
			if (matchesKey(data, "ctrl+c")) {
				if (this.pendingAsks.length > 0) this.settleAsk(false);
				else this.options.onInterrupt();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+d")) {
				// A typed draft always wins: Ctrl+D stays an editing key while
				// there is text, even with a pending ask (readline parity).
				if (editor.getText() !== "") return undefined;
				if (this.pendingAsks.length > 0) this.drainAsks();
				this.options.onEof();
				return { consume: true };
			}
			return undefined;
		});

		// `kill -INT` and a closing stdin: same drains as the readline shell.
		this.onProcessSigint = () => {
			this.drainAsks();
			this.options.onInterrupt();
		};
		process.on("SIGINT", this.onProcessSigint);
		this.onStdinEnd = () => {
			this.drainAsks();
			this.options.onEof();
		};
		process.stdin.on("end", this.onStdinEnd);
		// Force-exit (process.exit) never runs close(): restore the terminal
		// from the exit hook instead of leaving raw mode + hidden cursor on
		// the user's shell (M9 review P2). Registered for the process
		// lifetime; stopTerminal() is idempotent.
		process.on("exit", () => this.stopTerminal());
	}

	private submit(text: string): void {
		if (this.closed) return; // a submit racing shutdown must not start a turn
		if (this.pendingAsks.length > 0) {
			this.settleAsk(isYes(text));
			return;
		}
		if (text !== "") {
			// Feed the editor's own history — up-arrow recall reads it (M9
			// review P1: recall was dead while getHistory() reported data).
			this.editor?.addToHistory(text);
			// Mirror readline/editor semantics for the interface view: skip
			// consecutive duplicates, cap at 100.
			if (this.history[0] !== text) this.history.unshift(text);
			if (this.history.length > 100) this.history.length = 100;
		}
		this.options.onLine(text);
	}

	setActive(active: boolean): void {
		this.marker?.setText(active ? "+ " : "> ");
		this.tui?.requestRender();
	}

	refresh(): void {
		this.tui?.requestRender();
	}

	/** Test seam: force one full repaint — differential renders may leave
	 *  unchanged lines out of the write log assertions depend on. */
	forceRender(): void {
		this.tui?.requestRender(true);
	}

	clearPending(): boolean {
		const editor = this.editor;
		if (editor === null) return false;
		const had = editor.getText() !== "";
		editor.setText("");
		this.tui?.requestRender();
		return had;
	}

	ask(question: string): Promise<boolean> {
		if (this.tui === null || this.closed) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const wasFirst = this.pendingAsks.length === 0;
			this.pendingAsks.push({ question, resolve });
			if (wasFirst) this.showAsk(question);
		});
	}

	getHistory(): readonly string[] {
		return this.history;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.detachInput?.();
		this.detachInput = null;
		if (this.onProcessSigint !== null) process.off("SIGINT", this.onProcessSigint);
		this.onProcessSigint = null;
		if (this.onStdinEnd !== null) process.stdin.off("end", this.onStdinEnd);
		this.onStdinEnd = null;
		this.drainAsks();
		const tui = this.tui;
		if (tui !== null) {
			// Graceful-exit notes ("session … saved") feed the sink on this very
			// tick; the pending render lands nextTick/setTimeout(≤16ms). Stopping
			// now would kill the final frame (M9 review P1) — 40ms clears
			// pi-tui's MIN_RENDER_INTERVAL_MS = 16.
			tui.requestRender();
			setTimeout(() => this.stopTerminal(), 40);
		}
	}

	/** Restore the terminal exactly once; idempotent. */
	private stopTerminal(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.options.transcript.onUpdate = null;
		this.tui?.stop();
		this.tui = null;
	}

	/** Resolve the oldest question, then show the next (if queued). */
	private settleAsk(approved: boolean): void {
		const oldest = this.pendingAsks.shift();
		if (oldest === undefined) return;
		oldest.resolve(approved);
		const next = this.pendingAsks[0];
		if (next !== undefined) {
			this.showAsk(next.question);
		} else {
			this.removeAskLine();
			this.tui?.requestRender();
		}
	}

	/** Decline every pending question without rendering (abort paths). */
	private drainAsks(): void {
		while (this.pendingAsks.length > 0) {
			const oldest = this.pendingAsks.shift();
			oldest?.resolve(false);
		}
		this.removeAskLine();
		this.tui?.requestRender();
	}

	private showAsk(question: string): void {
		this.removeAskLine();
		this.askContainer.addChild(new Text(question));
		this.tui?.requestRender();
	}

	private removeAskLine(): void {
		const first = this.askContainer.children[0];
		if (first !== undefined) this.askContainer.removeChild(first);
	}
}
