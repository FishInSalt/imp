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

export type TreeFilterMode = "default" | "no-tools" | "user-only";

export const TREE_FILTER_MODES: TreeFilterMode[] = ["default", "no-tools", "user-only"];

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
function passesFilter(entry: SessionEntry, mode: TreeFilterMode, isCurrentLeaf: boolean): boolean {
	if (isCurrentLeaf) return true;
	// Tree metadata never shows in any mode (pi's settings-entry rule).
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
		if (passesFilter(node.entry, opts.filter, isCurrentLeaf)) {
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
	for (let i = 0; i < orderedRoots.length; i++) {
		const root = orderedRoots[i];
		if (root === undefined) continue;
		flatten(root, 0, false, false, i === orderedRoots.length - 1, []);
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
	private mode: TreeFilterMode = "default";
	private query = "";
	private folded = new Set<string>();
	private selected = 0;
	private scrollOffset = 0;
	private visibleLines: number;
	private readonly roots: TreeNode[];
	private readonly leafId: string | null;
	private readonly onSelectEntry: (entryId: string) => void;
	private readonly onCancel: () => void;

	constructor(
		roots: TreeNode[],
		leafId: string | null,
		maxLines: number,
		onSelectEntry: (entryId: string) => void,
		onCancel: () => void,
	) {
		this.roots = roots;
		this.leafId = leafId;
		this.visibleLines = Math.max(3, maxLines);
		this.onSelectEntry = onSelectEntry;
		this.onCancel = onCancel;
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
				this.selected = 0;
			} else {
				this.onCancel();
			}
		} else if (matchesKey(data, "tab")) {
			const i = TREE_FILTER_MODES.indexOf(this.mode);
			this.mode = TREE_FILTER_MODES[(i + 1) % TREE_FILTER_MODES.length] as TreeFilterMode;
			this.clampSelection();
		} else if (data === "f") {
			const row = this.rows()[this.selected];
			if (row !== undefined) {
				if (this.folded.has(row.entryId)) this.folded.delete(row.entryId);
				else this.folded.add(row.entryId);
				this.clampSelection();
			}
		} else if (matchesKey(data, "backspace")) {
			if (this.query !== "") {
				this.query = this.query.slice(0, -1);
				this.clampSelection();
			}
		} else if (!data.startsWith("\x1b") && data !== "" && ![...data].some((ch) => ch < " ")) {
			// Printable input (ASCII + committed IME) builds the query.
			this.query += data;
			this.clampSelection();
		}
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
		const modeTag = this.mode === "default" ? "" : ` [${this.mode}]`;
		const searchTag = this.query !== "" ? `  search: ${this.query}` : "";
		const status = `  (${rows.length === 0 ? 0 : this.selected + 1}/${rows.length})${modeTag}${searchTag}  ·  enter=go tab=filter f=fold`;
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
