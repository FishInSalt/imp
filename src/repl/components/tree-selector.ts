import { type AgentMessage, contentText } from "../../core/messages.js";
import type { SessionEntry, TreeNode } from "../../core/session/store.js";
import { dim } from "../../format.js";
import { type Component, matchesKey, Text, truncateToWidth } from "../../tui.js";

/**
 * #tree: the session-tree navigator — rendering, filtering, search, fold.
 *
 * Shared core: buildTreeRows() is a PURE function over the store's getTree()
 * output. The TUI component (below) and the legacy shell's numbered text
 * tree both render from it, so the two cannot drift (design §3.3/§3.4).
 *
 * Deliberate cuts vs pi's TreeSelectorComponent (design §3.3, review-backed):
 * three filter modes instead of five (labeled-only needs label EDITING,
 * which is batch B; "all" is debug-only), fold on the `f` key instead of
 * overloading the arrows with pi's fold-or-jump dual semantics, and no
 * horizontal viewport — rows truncate (typical sessions are <8 levels deep;
 * fold covers the rest). Batch B may revisit each.
 */

export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export const TREE_FILTER_MODES: TreeFilterMode[] = [
	"default",
	"no-tools",
	"user-only",
	"labeled-only",
	"all",
];

/** Status-line tag per mode (pi's getStatusLabels literals — "labeled", not
 *  "labeled-only"; "default" carries no tag). */
const MODE_TAGS: Partial<Record<TreeFilterMode, string>> = {
	"no-tools": "no-tools",
	"user-only": "user-only",
	"labeled-only": "labeled",
	all: "all",
};

/** One renderable row of the tree (pre-ANSI: plain text pieces). */
export interface TreeRow {
	entryId: string;
	/** Connector/gutter prefix (e.g. "│  └─ ") — plain, no ANSI. */
	prefix: string;
	/** True when the entry is on the active path (root→current leaf). */
	onActivePath: boolean;
	isCurrentLeaf: boolean;
	label?: string;
	/** The one-line description (user: …/assistant: …/tool name/…). */
	text: string;
	/** True when this row's node has folded (hidden) children. */
	folded: boolean;
}

/** Does the assistant message carry any text block? (pi's hasTextContent.) */
function hasTextContent(message: AgentMessage): boolean {
	return message.role === "assistant" && message.blocks.some((block) => block.type === "text");
}

/** Whether an entry is visible under the given filter. The CURRENT LEAF is
 *  ALWAYS visible — an absolute rule across all modes (design §3.3, review
 *  P2-3: stronger than pi, which only exempts the tool-only-assistant rule —
 *  after a switch the user must see where they landed, whatever it is). */
function passesFilter(
	entry: SessionEntry,
	mode: TreeFilterMode,
	isCurrentLeaf: boolean,
	label: string | undefined,
): boolean {
	if (isCurrentLeaf) return true;
	if (mode === "labeled-only") return label !== undefined;
	// Tree metadata never shows in any mode but "all" (pi's settings-entry rule).
	if (mode === "all") return true;
	if (entry.type === "thinkingLevelChange" || entry.type === "session_info") return false;
	if (entry.type === "message" && entry.message.role === "assistant") {
		// Tool-only assistant turns are noise (pi's default rule) — unless they
		// ended abnormally, which is exactly what you'd navigate back to fix.
		const endedAbnormally =
			entry.message.stopReason === "max_tokens" || entry.message.stopReason === "stop_sequence";
		if (!hasTextContent(entry.message) && !endedAbnormally) return false;
	}
	if (mode === "no-tools" && entry.type === "message" && entry.message.role === "toolResult") {
		return false;
	}
	if (mode === "user-only") {
		return entry.type === "message" && entry.message.role === "user";
	}
	return true;
}

/** The one-line tree description of an entry (design §3.3: component-side —
 *  the store stays pure data). Mirrors pi's getEntryDisplayText, slimmed. */
export function describeEntryForTree(entry: SessionEntry): string {
	const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			if (msg.role === "user") return `user: ${normalize(contentText(msg.content))}`;
			if (msg.role === "assistant") {
				const text = msg.blocks
					.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
					.map((b) => b.text)
					.join(" ");
				const first = normalize(text);
				if (first !== "") return `assistant: ${first}`;
				const call = msg.blocks.find(
					(b): b is Extract<typeof b, { type: "toolCall"; name: string }> => b.type === "toolCall",
				);
				return call !== undefined ? `assistant: [${call.name}]` : "assistant: …";
			}
			// toolResult — name the tools (usually one)
			const names = [...new Set(msg.results.map((r) => r.toolName))].join(", ");
			return `⎿ ${names}`;
		}
		case "branchSummary":
			return `branch summary: ${normalize(entry.summary)}`;
		case "compaction":
			return `summary (compaction): ${normalize(entry.summary)}`;
		case "thinkingLevelChange":
			return `thinking: ${entry.thinkingLevel}`;
		case "session_info":
			return entry.name.trim() === "" ? "title: (cleared)" : `title: ${entry.name}`;
		case "label":
			return `label: ${entry.label}`;
	}
}

/**
 * Flatten the tree into renderable rows (pure; shared by both shells).
 *
 * pi's indentation model (tree-selector.ts flattenTree), adopted:
 * - a single-child chain stays FLAT — a linear session reads as a list;
 *   indent grows only at a branch point (and one generation after one,
 *   for visual grouping);
 * - connectors (├─/└─) appear only when the parent branches;
 * - the ACTIVE branch sorts first among siblings and roots — the current
 *   conversation reads top-down without distraction;
 * - gutters (│) mark ancestor fork columns that still have siblings below.
 *
 * `folded` hides subtrees (⊞ markers); `query` filters by substring over
 * label + description (case-insensitive); the CURRENT LEAF survives every
 * filter (§3.3). Multiple roots (orphans) each render at indent 0,
 * active-first.
 */
export function buildTreeRows(
	roots: TreeNode[],
	leafId: string | null,
	opts: { filter: TreeFilterMode; folded?: Set<string>; query?: string },
): TreeRow[] {
	// Active path = ids from root to the current leaf (DFS with a trail).
	const activePath = new Set<string>();
	const findPath = (nodes: TreeNode[], trail: string[]): boolean => {
		for (const node of nodes) {
			const next = [...trail, node.entry.id];
			if (node.entry.id === leafId) {
				for (const id of next) activePath.add(id);
				return true;
			}
			if (findPath(node.children, next)) return true;
		}
		return false;
	};
	if (leafId !== null) findPath(roots, []);

	const rows: TreeRow[] = [];
	/** A fork column that still has siblings below it: │ continues there. */
	interface Gutter {
		position: number;
		show: boolean;
	}
	const flatten = (
		node: TreeNode,
		indent: number,
		justBranched: boolean,
		showConnector: boolean,
		isLast: boolean,
		gutters: Gutter[],
	): void => {
		const isCurrentLeaf = node.entry.id === leafId;
		const folded = opts.folded?.has(node.entry.id) === true && node.children.length > 0;
		if (passesFilter(node.entry, opts.filter, isCurrentLeaf, node.label)) {
			// Prefix char-by-char: gutter columns, then the connector column.
			const total = indent * 3;
			let prefix = "";
			for (let pos = 0; pos < total; pos++) {
				const level = Math.floor(pos / 3);
				const within = pos % 3;
				const gutter = gutters.find((g) => g.position === level);
				if (gutter !== undefined && within === 0) prefix += gutter.show ? "│" : " ";
				else if (gutter !== undefined) prefix += " ";
				else if (showConnector && level === indent - 1) {
					if (within === 0) prefix += isLast ? "└" : "├";
					else if (within === 1) prefix += folded ? "⊞" : "─";
					else prefix += " ";
				} else prefix += " ";
			}
			if (indent === 0 && folded && !showConnector) prefix = "⊞ ";
			rows.push({
				entryId: node.entry.id,
				prefix,
				onActivePath: activePath.has(node.entry.id),
				isCurrentLeaf,
				label: node.label,
				text: describeEntryForTree(node.entry),
				folded,
			});
		}
		if (folded) return; // the subtree stays hidden (⊞ row above)
		const children = node.children;
		const branched = children.length > 1;
		// Active-first ordering: the child containing the current leaf leads.
		const ordered = [
			...children.filter((c) => activePath.has(c.entry.id)),
			...children.filter((c) => !activePath.has(c.entry.id)),
		];
		const childIndent = branched
			? indent + 1
			: justBranched && indent > 0
				? indent + 1 // one generation after a branch groups visually (pi)
				: indent;
		const childGutters = showConnector ? [...gutters, { position: indent - 1, show: !isLast }] : gutters;
		for (let i = 0; i < ordered.length; i++) {
			const child = ordered[i];
			if (child === undefined) continue;
			flatten(child, childIndent, branched, branched, i === ordered.length - 1, childGutters);
		}
	};
	const orderedRoots = [
		...roots.filter((r) => activePath.has(r.entry.id)),
		...roots.filter((r) => !activePath.has(r.entry.id)),
	];
	if (orderedRoots.length === 1) {
		const root = orderedRoots[0];
		if (root !== undefined) flatten(root, 0, false, false, false, []);
	} else {
		// Multiple roots (orphans): pi's virtual root — the roots render one
		// level down with connectors, visually one tree (review P2).
		for (let i = 0; i < orderedRoots.length; i++) {
			const root = orderedRoots[i];
			if (root === undefined) continue;
			flatten(root, 1, true, true, i === orderedRoots.length - 1, []);
		}
	}

	if (opts.query !== undefined && opts.query !== "") {
		const q = opts.query.toLowerCase();
		return rows.filter(
			(row) =>
				row.isCurrentLeaf ||
				row.text.toLowerCase().includes(q) ||
				(row.label ?? "").toLowerCase().includes(q),
		);
	}
	return rows;
}

/** The interactive tree picker (TUI shell). Owns keys while open: arrows
 *  move, Enter selects, Tab cycles the filter, f folds, typing searches,
 *  backspace edits the query, Esc clears the search then exits. */
export class TreeSelectorComponent implements Component {
	private mode: TreeFilterMode;
	private query = "";
	private folded = new Set<string>();
	private selected = 0;
	private scrollOffset = 0;
	private visibleLines: number;
	private readonly roots: TreeNode[];
	private readonly leafId: string | null;
	private readonly onSelectEntry: (entryId: string) => void;
	private readonly onCancel: () => void;
	/** Label editing state (#tree batch B): non-null while the inline input
	 *  owns every key (pi's LabelInput). Empty string on save = REMOVE. */
	private labelEdit: { entryId: string; buffer: string } | null = null;
	private readonly onLabelChange?: (entryId: string, label: string | undefined) => void;

	constructor(
		roots: TreeNode[],
		leafId: string | null,
		maxLines: number,
		onSelectEntry: (entryId: string) => void,
		onCancel: () => void,
		opts?: {
			/** Opening filter (the treeFilterMode setting; pi's initialFilterMode). */
			initialFilterMode?: TreeFilterMode;
			/** Persist a committed label (empty = remove). In-place tree update
			 *  happens regardless — this is the disk side (pi's ordering:
			 *  mutate first, persist second). */
			onLabelChange?: (entryId: string, label: string | undefined) => void;
		},
	) {
		this.roots = roots;
		this.leafId = leafId;
		this.visibleLines = Math.max(3, maxLines);
		this.onSelectEntry = onSelectEntry;
		this.onCancel = onCancel;
		this.mode = opts?.initialFilterMode ?? "default";
		this.onLabelChange = opts?.onLabelChange;
	}

	/** pi's updateNodeLabel: set the in-memory label so rows reflect the edit
	 *  immediately (getTree() builds fresh trees per /tree call — no other
	 *  holder can observe this mutation). */
	private setNodeLabel(entryId: string, label: string | undefined): void {
		const stack = [...this.roots];
		while (stack.length > 0) {
			const node = stack.pop();
			if (node === undefined) continue;
			if (node.entry.id === entryId) {
				if (label === undefined) delete node.label;
				else node.label = label;
				return;
			}
			stack.push(...node.children);
		}
	}

	/** Current rows — also the seam the legacy text tree reuses (via
	 *  buildTreeRows directly). */
	rows(): TreeRow[] {
		return buildTreeRows(this.roots, this.leafId, {
			filter: this.mode,
			folded: this.folded,
			query: this.query,
		});
	}

	handleInput(data: string): void {
		if (this.labelEdit !== null) {
			this.handleLabelEditInput(data);
			return;
		}
		if (data === "L") {
			// Edit the selected entry's label. Uppercase only, BEFORE the
			// printable guard — an active search never receives "L" (pi's
			// shift+l structure; search is case-insensitive, so lowercase
			// finds the same rows).
			const row = this.rows()[this.selected];
			if (row !== undefined) {
				const current = this.findNodeLabel(row.entryId);
				this.labelEdit = { entryId: row.entryId, buffer: current ?? "" };
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, this.rows().length - 1), this.selected + 1);
		} else if (matchesKey(data, "enter")) {
			const row = this.rows()[this.selected];
			if (row !== undefined) this.onSelectEntry(row.entryId);
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.query !== "") {
				this.query = "";
				this.folded.clear(); // (pi clears folds here too)
				this.selected = 0;
			} else {
				this.onCancel();
			}
		} else if (matchesKey(data, "tab")) {
			const i = TREE_FILTER_MODES.indexOf(this.mode);
			this.mode = TREE_FILTER_MODES[(i + 1) % TREE_FILTER_MODES.length] as TreeFilterMode;
			this.folded.clear(); // a filter change must be able to illuminate folded subtrees
			this.clampSelection();
		} else if (data === "f" && this.query === "") {
			// review P1: searchable "f" beats the fold key
			const row = this.rows()[this.selected];
			if (row !== undefined) {
				if (this.folded.has(row.entryId)) this.folded.delete(row.entryId);
				else this.folded.add(row.entryId);
				this.clampSelection();
			}
		} else if (matchesKey(data, "backspace")) {
			if (this.query !== "") {
				this.query = this.query.slice(0, -1);
				this.folded.clear(); // search edits must see through folds (pi)
				this.clampSelection();
			}
		} else if (!data.startsWith("\x1b") && data !== "" && ![...data].some((ch) => ch < " ")) {
			// Printable input (ASCII + committed IME) builds the query.
			this.query += data;
			this.folded.clear(); // (pi clears folds on every search edit)
			this.clampSelection();
		}
	}

	/** The label-edit mini-input (pi's LabelInput): printables build the
	 *  buffer, backspace deletes, Enter commits (trim; empty = REMOVE),
	 *  Esc cancels. Every OTHER key is swallowed — the tree's keys stay
	 *  inert while the input owns focus. */
	private handleLabelEditInput(data: string): void {
		const edit = this.labelEdit;
		if (edit === null) return;
		if (matchesKey(data, "enter")) {
			this.labelEdit = null;
			const trimmed = edit.buffer.trim();
			const label = trimmed === "" ? undefined : trimmed;
			this.setNodeLabel(edit.entryId, label); // pi's ordering: mutate first
			this.onLabelChange?.(edit.entryId, label); // …then persist
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.labelEdit = null; // cancel — nothing moves
		} else if (matchesKey(data, "backspace")) {
			edit.buffer = edit.buffer.slice(0, -1);
		} else if (!data.startsWith("\x1b") && data !== "" && ![...data].some((ch) => ch < " ")) {
			edit.buffer += data;
		}
		// arrows / tab / f / L etc: swallowed by design (nested input)
	}

	private findNodeLabel(entryId: string): string | undefined {
		const stack = [...this.roots];
		while (stack.length > 0) {
			const node = stack.pop();
			if (node === undefined) continue;
			if (node.entry.id === entryId) return node.label;
			stack.push(...node.children);
		}
		return undefined;
	}

	private clampSelection(): void {
		const count = this.rows().length;
		if (count === 0) return;
		this.selected = Math.min(this.selected, count - 1);
	}

	invalidate(): void {} // no cached render state

	render(width: number): string[] {
		const rows = this.rows();
		const lines: string[] = [];
		if (rows.length === 0) {
			lines.push(dim("  no entries match", true));
		} else {
			if (this.selected < this.scrollOffset) this.scrollOffset = this.selected;
			if (this.selected >= this.scrollOffset + this.visibleLines) {
				this.scrollOffset = this.selected - this.visibleLines + 1;
			}
			const end = Math.min(rows.length, this.scrollOffset + this.visibleLines);
			for (let i = this.scrollOffset; i < end; i++) {
				const row = rows[i];
				if (row === undefined) continue;
				const selected = i === this.selected;
				const gutter = selected ? "› " : "  ";
				const label = row.label !== undefined ? `[${row.label}] ` : "";
				const marker = row.onActivePath ? "• " : "";
				const body = `${dim(row.prefix, true)}${marker}${label}${row.text}${
					row.isCurrentLeaf ? dim("  ◂", true) : ""
				}`;
				const line = `${gutter}${body}`;
				// Reverse video marks the selected row (SelectList's affordance).
				lines.push(selected ? `\x1b[7m${truncateToWidth(line, width)}\x1b[0m` : truncateToWidth(line, width));
			}
		}
		if (this.labelEdit !== null) {
			lines.push(truncateToWidth(`  Label (empty to remove): ${this.labelEdit.buffer}▏`, width));
			lines.push(dim(truncateToWidth("  enter=save  esc=cancel", width), true));
			return lines;
		}
		const modeTagRaw = MODE_TAGS[this.mode];
		const modeTag = modeTagRaw === undefined ? "" : ` [${modeTagRaw}]`;
		const searchTag = this.query !== "" ? `  search: ${this.query}` : "";
		const status = `  (${rows.length === 0 ? 0 : this.selected + 1}/${rows.length})${modeTag}${searchTag}  ·  enter=go tab=filter f=fold L=label`;
		lines.push(dim(truncateToWidth(status, width), true));
		return lines;
	}
}

/** Title + selector box for the overlay container. */
export class TreeSelectorBox implements Component {
	private readonly title: Text;
	constructor(
		private readonly selector: TreeSelectorComponent,
		titleText: string,
	) {
		this.title = new Text(titleText, 0, 0);
	}
	render(width: number): string[] {
		return [...this.title.render(width), ...this.selector.render(width)];
	}
	handleInput(data: string): void {
		this.selector.handleInput(data);
	}
	invalidate(): void {
		this.title.invalidate();
	}
}
