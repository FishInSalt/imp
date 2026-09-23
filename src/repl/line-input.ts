/** One picker row: a label (shown) plus an optional dimmed description. */
export interface SelectItemOption {
	label: string;
	description?: string;
}

import type { TreeNode } from "../core/session/store.js";
import type { TreeFilterMode } from "./components/tree-selector.js";

/** #tree: what treeSelect renders — the session tree (store.getTree()'s
 * shape) plus the current position. */
export interface TreeSelectRequest {
	roots: TreeNode[];
	leafId: string | null;
	title?: string;
	/** Opening filter — the treeFilterMode setting (batch B; pi's
	 *  initialFilterMode). Default "default". */
	initialFilterMode?: TreeFilterMode;
	/** Persist a committed label edit (batch B; undefined label = remove).
	 *  The store write lives here so the component stays UI-only. */
	onLabelChange?: (entryId: string, label: string | undefined) => void;
	/** Open with this row selected (batch C D6's abort-reopen passes the
	 *  attempted target). Default: the current leaf. */
	initialSelectedId?: string;
	/** ctrl+x in the selector (batch C D7): undefined = entry has no text. */
	onCopy?: (text: string | undefined) => void;
}

/** Options for LineInput.select — an interactive item picker. */
export interface SelectOptions {
	/** Line rendered above the items (e.g. "pick a model"). */
	title?: string;
	items: SelectItemOption[];
	/** Type-to-filter while the picker is open (M11 #9): printable input
	 *  builds a case-insensitive substring query over the labels; arrows and
	 *  Enter keep working against the filtered rows. Pickers that pass a
	 *  handful of items (e.g. /model) leave it off. */
	filterable?: boolean;
}

/** One row of the TUI queue preview (LineInput.setQueue): the routing
 *  label plus a capped one-line preview. */
export interface QueueEntryView {
	/** How the entry will run: "steer" (injects into the running turn),
	 *  "follow-up" (waits for the run to end), "bash" ("! cmd"), "prompt"
	 *  (markdown-command content). */
	label: string;
	preview: string;
}

/** How a submitted line routes while a run is in flight. "steer" (Enter,
 *  the default) enters the running turn before the next model call;
 *  "followUp" (alt+enter) is consumed by the SAME run at its next
 *  would-stop boundary (M17) — one queued follow-up per answer. Idle, both
 *  submit immediately — the mode only matters behind a live run. */
export type SubmitMode = "steer" | "followUp";

/**
 * The input-side contract the REPL state machine (repl.ts) consumes.
 *
 * Two implementations, selected in runRepl:
 *  - ReplInput (input.ts) — the readline shell, the pre-M9 interactive
 *    path and the `IMP_REPL=legacy` escape hatch;
 *  - TuiShell (shell.ts) — the pi-tui shell (M9).
 *
 * The machine is presentation-agnostic: it routes by state and never
 * touches a terminal library, so both shells implement exactly this.
 */
export interface LineInput {
	/** Arm the input source and show the idle prompt. */
	start(): void;
	/** Flags a run/compaction in flight. The TUI hint row swaps to the
	 *  interrupt affordance while active; the readline shell ignores it. */
	setActive(active: boolean): void;
	/** Redraw the prompt line (after status notes, queue changes). */
	refresh(): void;
	/** Wipes typed-but-unsubmitted text. Returns true when text was discarded. */
	clearPending(): boolean;
	/** One-line [y/N] question (api.confirm's tty side). FIFO when concurrent;
	 *  empty/EOF/anything but y/yes resolves false. */
	ask(question: string): Promise<boolean>;
	/** One-line TEXT question (/login's api-key prompt, pi's LoginDialog
	 *  input). Enter returns the typed text (rendered unmasked — pi does not
	 *  mask either); Esc/Ctrl+C/EOF/empty resolve null. FIFO with ask(). */
	secret?(question: string): Promise<string | null>;
	/** History so far (newest first). Interactive only. */
	getHistory(): readonly string[];
	/** TUI shell only: persistent bottom status line (model · session ·
	 *  cumulative tokens). The legacy shell has no such line and ignores it. */
	setFooter?(text: string): void;
	/** Append a collapsed fold (expandable body) INTO the transcript
	 *  stream at its current end — inline, directly below the line that
	 *  just completed (pi parity); a TUI-shell-only affordance, the
	 *  readline shell has no folds. */
	addFold?(title: string, lines: string[], decorate?: boolean, error?: boolean): void;
	/** TUI shells: wipe transcript + folds (/new, /resume). Optional —
	 *  the readline shell has no persistent screen state to clear. */
	clearConversation?(): void;
	/** Item picker (M9 phase 2, TUI only — the readline shell has none, so
	 *  callers must fall back to a text flow when absent). Enter confirms,
	 *  Esc/Ctrl+C cancel; resolves to the chosen index or null. */
	select?(options: SelectOptions): Promise<number | null>;
	/** #tree: session-tree navigator (TUI only). Renders the full tree with
	 *  filter/search/fold (Tab/f/typing); Enter resolves the chosen ENTRY
	 *  ID, cancel resolves null. Follows select()'s lifecycle contract
	 *  (queued behind an open picker, torn down on close/SIGINT). */
	treeSelect?(options: TreeSelectRequest): Promise<string | null>;
	/** Queue visual (TUI only): one dim row per queued entry ("  steer: <preview>"
	 *  style) under a "N queued" head and a dequeue hint — the whole region
	 *  collapses to zero rows when empty. The readline shell has no such line
	 *  and keeps its "▪ queued:" notes instead. */
	setQueue?(entries: readonly QueueEntryView[]): void;
	/** Terminal window title (TUI only — OSC 2, written outside the frame
	 *  pipeline). The readline shell has no title and ignores it. */
	setTitle?(title: string): void;
	/** TUI only: live turn activity (M10 B). The machine pushes a fresh
	 *  snapshot on every event; idle clears the region. The shell owns the
	 *  spinner animation and elapsed-time rendering. */
	setActivity?(snapshot: ActivitySnapshot): void;
	/** TUI only: the editor's current draft — the queue restore (alt+up /
	 *  esc+p, and abort) preserves whatever the user is mid-typing. */
	getText?(): string;
	/** TUI only: replace the editor text — the queue restore lands the
	 *  joined queued input above the preserved draft. */
	setText?(text: string): void;
	/** Release the terminal (or readline interface). */
	close(): void;
}

/** One pending top-level tool call in the TUI activity region. */
export interface ActivityToolLine {
	/** tool_call id — tool_end removes the row (the ⎿ summary lands in the transcript). */
	id: string;
	name: string;
	/** Pre-summarized args label (summarizeArgs at event time). */
	label: string;
	startedAtMs: number;
}

/** One running subagent in the TUI activity region (the task tool's child). */
export interface ActivityAgentLine {
	/** Agent name — two parallel tasks on the same agent merge into one row (v1). */
	agent: string;
	task: string;
	/** The task tool_call id that spawned it — its tool_end removes the row. */
	taskToolId: string;
	cwd: string | null;
	/** Latest child tool_start, pre-summarized ("read src/foo.ts"). */
	lastTool: string | null;
	toolCount: number;
	startedAtMs: number;
}

/** Snapshot of live turn activity (M10 B: the activity region replaces the
 *  byte-stream spinner in TUI mode — print/legacy keep the Renderer's own
 *  spinner). Elapsed times are computed shell-side from the clock captured
 *  per entry, so the shell can animate without machine pushes. */
export interface ActivitySnapshot {
	/** #compaction-ux F2: "compacting" renders its own spinner row — driven by
	 *  the REPL state machine (state === "compacting" during /compact), so no
	 *  manual clear is needed; the runCommand finally restores idle. */
	phase: "idle" | "thinking" | "working" | "compacting";
	tools: ActivityToolLine[];
	agents: ActivityAgentLine[];
}

/** Event surface both shells wire into the machine. */
export interface LineInputEvents {
	onLine(line: string, mode?: SubmitMode): void;
	onInterrupt(): void;
	onEof(): void;
}
