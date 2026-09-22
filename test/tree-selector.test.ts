import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { TreeNode } from "../src/core/session/store.js";
import {
	buildTreeRows,
	describeEntryForTree,
	TreeSelectorComponent,
} from "../src/repl/components/tree-selector.js";

const user = (content: string): AgentMessage => ({ role: "user", content });
const assistantText = (text: string): AgentMessage => ({
	role: "assistant",
	blocks: [{ type: "text", text }],
	usage: { inputTokens: 1, outputTokens: 1 },
	stopReason: "end_turn",
});
const assistantToolOnly = (name: string): AgentMessage => ({
	role: "assistant",
	blocks: [{ type: "toolCall", id: "tc1", name, arguments: {} }],
	usage: { inputTokens: 1, outputTokens: 1 },
	stopReason: "tool_use",
});
const toolResult = (): AgentMessage => ({
	role: "toolResult",
	results: [{ toolCallId: "tc1", toolName: "bash", content: "done", isError: false }],
});

/** Hand-build a tree in memory (the component only needs the shape). */
function node(
	entry: {
		id: string;
		type: "message" | "branchSummary" | "thinkingLevelChange";
		message?: AgentMessage;
		summary?: string;
		thinkingLevel?: string;
	},
	children: TreeNode[] = [],
	label?: string,
): TreeNode {
	return {
		entry: {
			type: entry.type,
			id: entry.id,
			parentId: null,
			timestamp: new Date().toISOString(),
			...(entry.message !== undefined ? { message: entry.message } : {}),
			...(entry.summary !== undefined ? { summary: entry.summary } : {}),
			...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
		} as TreeNode["entry"],
		children,
		...(label === undefined ? {} : { label }),
	};
}

/** q1 → a1 → (q2-old → a2-old | q2-new → a3) — the /tree poster child. */
function posterTree(): { roots: TreeNode[]; ids: Record<string, string> } {
	const ids = {
		q1: "q1",
		a1: "a1",
		q2old: "q2old",
		a2old: "a2old",
		q2new: "q2new",
		a3: "a3",
	};
	const roots = [
		node({ id: ids.q1, type: "message", message: user("first question") }, [
			node({ id: ids.a1, type: "message", message: assistantText("an answer") }, [
				node({ id: ids.q2old, type: "message", message: user("old direction") }, [
					node({ id: ids.a2old, type: "message", message: assistantText("old result") }),
				]),
				node({ id: ids.q2new, type: "message", message: user("new direction") }, [
					node({ id: ids.a3, type: "message", message: assistantText("new result") }),
				]),
			]),
		]),
	];
	return { roots, ids };
}

describe("buildTreeRows (#tree)", () => {
	it("renders connectors, active path, and the current-leaf marker", () => {
		const { roots, ids } = posterTree();
		const rows = buildTreeRows(roots, ids.a3 ?? null, { filter: "default" });
		// single-child chains stay FLAT (q1→a1 read as a list); the fork at a1
		// grows connectors; the ACTIVE branch sorts FIRST; the │ gutter marks
		// the fork column that still has siblings below it
		expect(rows.map((r) => `${r.prefix}${r.text}`)).toEqual([
			"user: first question",
			"assistant: an answer",
			"├─ user: new direction",
			"│     assistant: new result",
			"└─ user: old direction",
			"      assistant: old result",
		]);
		// active path: q1, a1, q2new, a3 — NOT the abandoned leg
		expect(rows.map((r) => r.onActivePath)).toEqual([true, true, true, true, false, false]);
		expect(rows[3]?.isCurrentLeaf).toBe(true);
		// the abandoned leg as the target leads instead
		const rows2 = buildTreeRows(roots, ids.a2old ?? null, { filter: "default" });
		expect(rows2.map((r) => `${r.prefix}${r.text}`)).toEqual([
			"user: first question",
			"assistant: an answer",
			"├─ user: old direction",
			"│     assistant: old result",
			"└─ user: new direction",
			"      assistant: new result",
		]);
	});

	it("default filter hides tool-only assistants and metadata; the current leaf always survives", () => {
		const toolTurn = node({ id: "t1", type: "message", message: assistantToolOnly("bash") }, [
			node({ id: "r1", type: "message", message: toolResult() }),
			node({ id: "after", type: "message", message: user("after the tools") }),
		]);
		const roots = [node({ id: "q1", type: "message", message: user("q") }, [toolTurn])];
		// tool-only assistant hidden; toolResult visible in default
		let rows = buildTreeRows(roots, "after", { filter: "default" });
		// ordering is structural (pi): the active child leads among siblings
		expect(rows.map((r) => r.entryId)).toEqual(["q1", "after", "r1"]);
		// no-tools hides the toolResult too
		rows = buildTreeRows(roots, "after", { filter: "no-tools" });
		expect(rows.map((r) => r.entryId)).toEqual(["q1", "after"]);
		// user-only keeps only user rows
		rows = buildTreeRows(roots, "after", { filter: "user-only" });
		expect(rows.map((r) => r.entryId)).toEqual(["q1", "after"]);
		// the CURRENT LEAF survives every filter — even a toolResult leaf
		rows = buildTreeRows(roots, "r1", { filter: "no-tools" });
		expect(rows.map((r) => r.entryId)).toEqual(["q1", "r1", "after"]);
		// ...and a tool-only assistant leaf
		rows = buildTreeRows(roots, "t1", { filter: "user-only" });
		expect(rows.map((r) => r.entryId)).toContain("t1");
	});

	it("an abnormal-stop tool-only assistant stays visible (navigate back to fix it)", () => {
		const aborted = { ...assistantToolOnly("bash"), stopReason: "max_tokens" } as AgentMessage;
		const roots = [node({ id: "t1", type: "message", message: aborted })];
		const rows = buildTreeRows(roots, "elsewhere", { filter: "default" });
		expect(rows.map((r) => r.entryId)).toEqual(["t1"]);
	});

	it("fold hides the subtree and marks the row ⊞", () => {
		const { roots, ids } = posterTree();
		const rows = buildTreeRows(roots, ids.a3 ?? null, { filter: "default", folded: new Set([ids.a1 ?? ""]) });
		expect(rows.map((r) => `${r.prefix}${r.text}`)).toEqual([
			"user: first question",
			"⊞ assistant: an answer",
		]);
		expect(rows[1]?.folded).toBe(true);
		// folding the root itself
		const rootOnly = buildTreeRows(roots, ids.a3 ?? null, {
			filter: "default",
			folded: new Set([ids.q1 ?? ""]),
		});
		expect(rootOnly.map((r) => `${r.prefix}${r.text}`)).toEqual(["⊞ user: first question"]);
	});

	it("search filters by substring over text and label; the current leaf survives", () => {
		const { roots, ids } = posterTree();
		const labeled = [
			{
				...roots[0]!,
				children: [{ ...roots[0]!.children[0]!, label: "the-pivot" }],
			},
		];
		// by text
		let rows = buildTreeRows(labeled, ids.a3 ?? null, { filter: "default", query: "old direction" });
		expect(rows.map((r) => r.entryId)).toEqual(["a3", "q2old"]); // row order kept, leaf survives
		// by label
		rows = buildTreeRows(labeled, ids.a3 ?? null, { filter: "default", query: "pivot" });
		expect(rows.map((r) => r.entryId)).toEqual(["a1", "a3"]);
		// the current leaf always survives
		rows = buildTreeRows(labeled, ids.a3 ?? null, { filter: "default", query: "zzz-no-match" });
		expect(rows.map((r) => r.entryId)).toEqual([ids.a3]);
	});

	it("multi-root: pi's virtual root — roots de-indent under connectors (review P2)", () => {
		const { roots, ids } = posterTree();
		const orphan = node({ id: "orphan", type: "message", message: user("orphan") });
		const rows = buildTreeRows([...roots, orphan], ids.a3 ?? null, { filter: "default" });
		// the active root leads with a connector; the orphan is the LAST root
		expect(rows[0]?.prefix).toBe("├─ ");
		expect(rows[6]?.prefix).toBe("└─ ");
		expect(rows[6]?.text).toBe("user: orphan");
	});

	it("describeEntryForTree: one line per entry type", () => {
		expect(describeEntryForTree(node({ id: "x", type: "message", message: user("hi\nthere") }).entry)).toBe(
			"user: hi there",
		);
		expect(describeEntryForTree(node({ id: "x", type: "message", message: toolResult() }).entry)).toBe(
			"⎿ bash",
		);
		expect(
			describeEntryForTree(node({ id: "x", type: "message", message: assistantToolOnly("grep") }).entry),
		).toBe("assistant: [grep]");
		expect(describeEntryForTree(node({ id: "x", type: "branchSummary", summary: "s\num" }).entry)).toBe(
			"branch summary: s um", // newline flattens to a space, not deleted
		);
	});
});

describe("TreeSelectorComponent keymap (#tree)", () => {
	function harness(
		leafId: string | null,
		opts?: {
			initialFilterMode?: import("../src/repl/components/tree-selector.js").TreeFilterMode;
			onLabelChange?: (entryId: string, label: string | undefined) => void;
		},
	) {
		const { roots, ids } = posterTree();
		const picked: string[] = [];
		const state = { cancelled: false }; // live holder — a bare boolean would destructure by value
		const selector = new TreeSelectorComponent(
			roots,
			leafId,
			10,
			(id) => picked.push(id),
			() => {
				state.cancelled = true;
			},
			opts,
		);
		return { selector, picked, state, ids, roots };
	}

	it("opens ON the current leaf; arrows move; enter selects; escape cancels (batch C D2)", () => {
		const { selector, picked, state } = harness("a3");
		// batch C: the selector opens with the cursor on the current leaf,
		// not row 0 (pi's initialSelectedId ?? currentLeafId).
		selector.handleInput("\r"); // enter immediately — picks the leaf row
		expect(picked).toEqual(["a3"]);
		selector.handleInput("\x1b[B"); // down off the leaf
		selector.handleInput("\x1b[A"); // up — back on the leaf
		selector.handleInput("\r");
		expect(picked).toEqual(["a3", "a3"]);
		selector.handleInput("\x1b"); // no search open — Esc cancels directly
		expect(state.cancelled).toBe(true);
	});

	it("'f' types into the search — fold only fires without a query (review P1)", () => {
		const { selector, picked, state } = harness("a3");
		selector.handleInput("fold"); // contains TWO f's — must reach the query
		// rows: nothing matches "fold" among texts except the surviving leaf a3
		expect(selector.rows().map((r) => r.entryId)).toEqual(["a3"]);
		for (let i = 0; i < 4; i++) selector.handleInput("\x7f"); // one char each — terminals deliver per-key
		// back to empty query
		expect(selector.rows()).toHaveLength(6);
		selector.handleInput("f"); // NOW it folds (selected row 0 = the root)
		expect(selector.rows()).toHaveLength(1);
		selector.handleInput("f"); // unfold
		expect(selector.rows()).toHaveLength(6);
		expect(picked).toEqual([]);
		expect(state.cancelled).toBe(false);
	});

	it("typing searches; Esc clears the search first; backspace edits", () => {
		const { selector, picked, state } = harness("a3");
		selector.handleInput("old direction");
		selector.handleInput("x");
		selector.handleInput("\x1b[C"); // right arrow — NOT search input
		selector.handleInput("\x7f"); // backspace drops the x → query "old direction"
		// rows: a3 (current leaf survives) + q2old + a2old ("old result" matches)
		selector.handleInput("\x1b[B"); // down to the first match after the leaf
		selector.handleInput("\x1b[B"); // q2old
		selector.handleInput("\r");
		expect(picked).toEqual(["q2old"]);
		selector.handleInput("\x1b"); // clears the search (still open)
		expect(state.cancelled).toBe(false);
		selector.handleInput("\x1b"); // now cancels
		expect(state.cancelled).toBe(true);
	});

	it("tab cycles the five modes (batch B); mode switches clear folds", () => {
		const { selector } = harness("a3");
		// default: 6 rows; no-tools (no toolResults here): 6; user-only: 3
		selector.handleInput("\t");
		expect(selector.rows()).toHaveLength(6); // no-tools — same count, no toolResults to hide
		selector.handleInput("\t");
		// a3 is an assistant but the CURRENT LEAF — absolute visibility (§3.3)
		expect(selector.rows().map((r) => r.entryId)).toEqual(["q1", "q2new", "a3", "q2old"]);
		selector.handleInput("\t");
		expect(selector.rows().map((r) => r.entryId)).toEqual(["a3"]); // labeled-only — nothing pinned; the leaf survives (absolute)
		selector.handleInput("\t");
		expect(selector.rows()).toHaveLength(6); // all — same fixture has no bookkeeping entries
		selector.handleInput("\t");
		expect(selector.rows()).toHaveLength(6); // back to default
		// fold, then a mode switch must clear it
		selector.handleInput("f");
		expect(selector.rows()).toHaveLength(1);
		selector.handleInput("\t"); // no-tools (fold cleared)
		expect(selector.rows()).toHaveLength(6);
	});
});

function harnessB(
	leafId: string | null,
	opts?: {
		initialFilterMode?: import("../src/repl/components/tree-selector.js").TreeFilterMode;
		onLabelChange?: (entryId: string, label: string | undefined) => void;
		initialSelectedId?: string;
		onCopy?: (text: string | undefined) => void;
		visibleLines?: number;
	},
) {
	const { roots } = posterTree();
	const state = { cancelled: false };
	const { visibleLines, ...componentOpts } = opts ?? {};
	const selector = new TreeSelectorComponent(
		roots,
		leafId,
		visibleLines ?? 10,
		() => {},
		() => {
			state.cancelled = true;
		},
		componentOpts,
	);
	return { selector, state, roots };
}

describe("label bookmarks + filter settings (#tree batch B)", () => {
	it("L opens the inline input even with an active search; lowercase stays searchable", () => {
		const { selector, roots } = harnessB("a3");
		selector.handleInput("ans"); // search active
		// batch C: opening selects the leaf (a3, row 1 under this query);
		// step UP to a1 so the label lands on the intended entry.
		selector.handleInput("\x1b[A");
		selector.handleInput("L"); // opens the editor DESPITE the query (pi structure)
		selector.handleInput("mark");
		selector.handleInput("\r"); // commit
		const labeled = roots[0]?.children[0]; // a1 was selected (row 0 after filter)
		expect(labeled?.label).toBe("mark");
		// the tree row reflects it immediately, and search finds it
		expect(selector.rows().some((r) => r.entryId === labeled?.entry.id && r.label === "mark")).toBe(true);
		selector.handleInput("\x1b"); // clear "ans" first (the leaf survives)
		selector.handleInput("mark");
		expect(selector.rows().some((r) => r.label === "mark")).toBe(true);
	});

	it("label-edit swallows every other key; Enter commits trimmed; empty removes; Esc cancels", () => {
		const { selector } = harnessB("a3");
		selector.handleInput("L");
		selector.handleInput("\t"); // swallowed by the nested input
		selector.handleInput("\x1b[A"); // up — swallowed
		selector.handleInput("f"); // printable → buffer
		selector.handleInput("L"); // ALSO printable mid-edit (pi's LabelInput types it)
		selector.handleInput("\x7f"); // backspace deletes the L ("f" remains)
		selector.handleInput("\x7f"); // …and the f — buffer empty again
		selector.handleInput("  spaced  ");
		selector.handleInput("\r");
		expect(selector.rows().some((r) => r.label === "spaced")).toBe(true); // trimmed
		// remove: L again, Enter on the prefilled buffer's spaces-only edit
		selector.handleInput("L");
		selector.handleInput("\r"); // prefilled "spaced" — need to clear first
		selector.handleInput("L");
		for (let i = 0; i < 7; i++) selector.handleInput("\x7f"); // delete "spaced"
		selector.handleInput("\r");
		expect(selector.rows().some((r) => r.label !== undefined)).toBe(false); // removed
		// cancel path
		selector.handleInput("L");
		selector.handleInput("x");
		selector.handleInput("\x1b");
		expect(selector.rows().some((r) => r.label === "x")).toBe(false);
	});

	it("onLabelChange fires only on commit (label undefined = remove)", () => {
		const calls: [string, string | undefined][] = [];
		const { selector } = harnessB("a3", { onLabelChange: (id, l) => calls.push([id, l]) });
		selector.handleInput("L");
		selector.handleInput("x");
		selector.handleInput("\x1b"); // cancel — no call
		expect(calls).toEqual([]);
		selector.handleInput("L");
		selector.handleInput("\r"); // empty buffer → REMOVE
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]).toBeUndefined();
	});

	it("initialFilterMode opens there; search typing, backspace, and Esc-clear clear folds (discriminating)", () => {
		const { selector } = harnessB("a3", { initialFilterMode: "user-only" });
		expect(selector.rows().map((r) => r.entryId)).toEqual(["q1", "q2new", "a3", "q2old"]); // a3: the leaf is absolute
		// Get to all mode, fold q1 (the root): ONLY q1's row remains.
		selector.handleInput("\t"); // → labeled-only (mode switch clears folds too)
		selector.handleInput("\t"); // → all
		expect(selector.rows().map((r) => r.entryId)).toEqual(["q1", "a1", "q2new", "a3", "q2old", "a2old"]);
		selector.handleInput("f");
		expect(selector.rows()).toHaveLength(1); // folded: descendants hidden
		// TYPING clears the fold: "an" matches a1's text ("an answer"), a
		// DESCENDANT of the folded node — visible only if folds were cleared.
		selector.handleInput("an");
		expect(selector.rows().map((r) => r.entryId)).toContain("a1");
		// BACKSPACE also clears: query "a" now matches old direction/new
		// direction/old result/… — more rows than the folded single, and
		// critically the DESCENDANTS are visible (folds were cleared)
		selector.handleInput("\x7f");
		const backspaced = selector.rows().map((r) => r.entryId);
		expect(backspaced).toContain("a1");
		expect(backspaced).toContain("a2old"); // a GREAT-grandchild of the folded root
		expect(backspaced.length).toBeGreaterThan(2);
		// re-fold, then ESC-with-query clears folds AND the query
		selector.handleInput("f");
		expect(selector.rows()).toHaveLength(1);
		selector.handleInput("\x1b");
		expect(selector.rows()).toHaveLength(6);
	});

	it("all mode surfaces bookkeeping entries; every other mode hides them (impl-review P2-3)", () => {
		const { roots } = posterTree();
		const a1 = roots[0]?.children[0];
		a1?.children.push(node({ id: "think1", type: "thinkingLevelChange", thinkingLevel: "high" }));
		for (const mode of ["default", "no-tools", "user-only", "labeled-only"] as const) {
			const rows = buildTreeRows(roots, "a3", { filter: mode });
			expect(rows.some((r) => r.entryId === "think1")).toBe(false); // hidden
		}
		const allRows = buildTreeRows(roots, "a3", { filter: "all" });
		expect(allRows.some((r) => r.entryId === "think1")).toBe(true); // surfaced
		expect(allRows.some((r) => r.text.includes("thinking: high"))).toBe(true);
	});

	it("labeled-only shows exactly the pinned rows (leaf absolute); all shows bookkeeping", () => {
		const { selector } = harnessB("a3", { onLabelChange: () => {} });
		// pin two labels
		selector.handleInput("\x1b[B"); // down → row 1
		selector.handleInput("L");
		selector.handleInput("alpha");
		selector.handleInput("\r"); // commit (a separate chunk — a mixed chunk is rejected wholesale)
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("L");
		selector.handleInput("beta");
		selector.handleInput("\r");
		selector.handleInput("\t"); // default→no-tools
		selector.handleInput("\t"); // →user-only
		selector.handleInput("\t"); // →labeled-only
		const rows = selector.rows();
		expect(rows.filter((r) => r.label !== undefined)).toHaveLength(2);
		expect(rows.every((r) => r.label !== undefined || r.isCurrentLeaf)).toBe(true);
		// status line: pi literal tag
		expect(selector.render(80).some((l) => l.includes("[labeled]"))).toBe(true);
		// all mode: the status tag AND the actual bookkeeping rows
		selector.handleInput("\t"); // →all
		expect(selector.render(80).some((l) => l.includes("[all]"))).toBe(true);
	});
});

describe("#tree batch C — polish pool", () => {
	/** q1 ─ a1(tool-only, hidden in default) ─ t1(toolResult)
	 *   └─ q2 ─ a2 (visible sibling branch; a2 = leaf).
	 * Default rows: [q1, t1, q2, a2] — t1 ADOPTS under q1 (review P1-1). */
	function toolTurnRoots(): TreeNode[] {
		const toolCall: AgentMessage = {
			role: "assistant",
			blocks: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
			stopReason: "tool_use",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
		const toolRes: AgentMessage = {
			role: "toolResult",
			results: [{ toolCallId: "c1", toolName: "bash", content: "file-a file-b", isError: false }],
		};
		const msg = (
			id: string,
			parentId: string | null,
			message: AgentMessage,
			children: TreeNode[] = [],
		): TreeNode => ({
			entry: {
				type: "message",
				id,
				parentId,
				timestamp: "2026-01-01T00:00:00Z",
				message,
			} as TreeNode["entry"],
			children,
		});
		return [
			msg("q1", null, user("start question"), [
				msg("a1", "q1", toolCall, [msg("t1", "a1", toolRes)]),
				msg("q2", "q1", user("second question"), [msg("a2", "q2", assistantText("second answer"))]),
			]),
		];
	}

	type ComponentOpts = NonNullable<ConstructorParameters<typeof TreeSelectorComponent>[5]>;
	function makeSelector(
		roots: TreeNode[],
		opts: {
			leafId?: string | null;
			onPick?: (id: string) => void;
			visibleLines?: number;
		} & ComponentOpts = {},
	) {
		const { leafId, onPick, visibleLines, ...componentOpts } = opts;
		return new TreeSelectorComponent(
			roots,
			leafId ?? null,
			visibleLines ?? 10,
			(id) => onPick?.(id),
			() => {},
			componentOpts,
		);
	}

	it("opens ON the leaf; hidden/unknown initialSelectedId walks up or falls back (D2)", () => {
		const { roots } = posterTree();
		// open defaults to the current leaf row
		const picked: string[] = [];
		makeSelector(roots, { leafId: "a3", onPick: (id) => picked.push(id) }).handleInput("\r");
		expect(picked).toEqual(["a3"]);
		// explicit initialSelectedId
		makeSelector(roots, {
			leafId: "a3",
			initialSelectedId: "a2old",
			onPick: (id) => picked.push(id),
		}).handleInput("\r");
		expect(picked).toEqual(["a3", "a2old"]);
		// hidden target under user-only: a1 (assistant) → nearest visible ancestor q1
		makeSelector(roots, {
			leafId: "a3",
			initialFilterMode: "user-only",
			initialSelectedId: "a1",
			onPick: (id) => picked.push(id),
		}).handleInput("\r");
		expect(picked).toEqual(["a3", "a2old", "q1"]);
		// unknown target → fallback LAST visible row
		makeSelector(roots, {
			leafId: "a3",
			initialSelectedId: "no-such",
			onPick: (id) => picked.push(id),
		}).handleInput("\r");
		expect(picked).toEqual(["a3", "a2old", "q1", "a2old"]);
	});

	it("the window re-centers on the selection (D2): mid-list open, window shifts on move", () => {
		// default rows: [q1, a1, q2new, a3, q2old, a2old] (6); vis=4
		const { selector } = harnessB("a3", { initialSelectedId: "a3", visibleLines: 4 });
		// selected idx 3 → window [max(0, 3-2) .. +4) = [1,5): a1..q2old
		const first = selector.render(120).join("\n");
		expect(first).toContain("an answer"); // idx 1
		expect(first).toContain("old direction"); // idx 4
		expect(first).not.toContain("first question"); // idx 0 OUT (old model: [0,4) → IN — the discriminator)
		expect(first).not.toContain("old result"); // idx 5 out
		// one ↓ (selected 4) → window [2,6): the tail row enters
		selector.handleInput("\x1b[B");
		const after = selector.render(120).join("\n");
		expect(after).toContain("old result"); // idx 5 now in — window shifted by one
		expect(after).not.toContain("first question");
	});

	it("←/→/PgUp/PgDn page, clamped at both ends, and never touch the query (D3)", () => {
		const { selector } = harnessB("a3", { visibleLines: 2 });
		expect(selector.rows()).toHaveLength(6);
		// page down from the leaf (idx 3): min(5, 3+2) = 5 → status shows (6/6)
		selector.handleInput("\x1b[C"); // right
		expect(selector.render(100).join("")).toContain("(6/6)");
		selector.handleInput("\x1b[6~"); // PgDn — clamped, stays
		expect(selector.render(100).join("")).toContain("(6/6)");
		// page up: max(0, 5-2) = 3
		selector.handleInput("\x1b[D"); // left (vis floors at 3): 5-3=2 → (3/6)
		expect(selector.render(100).join("")).toContain("(3/6)");
		// the query survives paging: type, page, query still shown and rows not refiltered
		selector.handleInput("question");
		const q = selector.rows().length;
		selector.handleInput("\x1b[5~"); // PgUp mid-query — not a query char
		const status = selector.render(100).join("");
		expect(status).toContain("search: question");
		expect(selector.rows().length).toBe(q);
		// fewer rows than a page: PgUp stays put (no wrap, no negative)
		const small = harnessB("a3", { visibleLines: 40, initialSelectedId: "q1" }); // idx 0
		const before = small.selector.render(100).join("");
		small.selector.handleInput("\x1b[5~");
		expect(small.selector.render(100).join("")).toBe(before);
	});

	it("alt+← folds at branch points only; alt+→ unfolds; folded rows jump instead (D4)", () => {
		// rows: [q1, a1, q2new, a3, q2old, a2old]. Foldable: q1 (root),
		// q2new & q2old (branch children of a1). NOT a1 (single child of q1).
		const { selector } = harnessB("a3", { initialSelectedId: "q2new" });
		expect(selector.rows()).toHaveLength(6);
		selector.handleInput("\x1b[1;3D"); // alt+left on q2new (foldable) → FOLD (a3 hidden)
		expect(selector.rows().map((r) => r.entryId)).toEqual(["q1", "a1", "q2new", "q2old", "a2old"]);
		expect(selector.render(100).join("")).toContain("(3/5)"); // still on q2new
		// alt+left AGAIN on the folded q2new → JUMP to segment start (not unfold)
		// up-walk: q2new's group under a1 is [q2new, q2old] but q2new is AT the
		// segment start (3 < 3 false) → continue; q1 root → land on q1 (idx 0)
		selector.handleInput("\x1b[1;3D");
		expect(selector.render(100).join("")).toContain("(1/5)");
		expect(selector.rows()).toHaveLength(5); // still folded
		// alt+right on folded q2new? We're on q1 now — q1 is foldable (root)!
		// Instead verify unfold: select q2new (row 2) explicitly then alt+right.
		const reopen = harnessB("a3", { initialSelectedId: "q2new" });
		reopen.selector.handleInput("\x1b[1;3D"); // fold
		expect(reopen.selector.rows()).toHaveLength(5);
		reopen.selector.handleInput("\x1b[1;3C"); // alt+right → UNFOLD
		expect(reopen.selector.rows()).toHaveLength(6);
		// mid-chain NON-foldable row (a1: has children, but its parent q1's
		// visible group is [a1] — single): alt+left JUMPS, never folds (P1-2 pin)
		const mid = harnessB("a3", { initialSelectedId: "a1" });
		mid.selector.handleInput("\x1b[1;3D");
		expect(mid.selector.rows()).toHaveLength(6); // nothing folded
		// a1 walks up to root q1 and lands there (its own segment start is itself)
		expect(mid.selector.render(100).join("")).toContain("(1/6)");
		// ctrl+left (dual binding) behaves the same
		const dual = harnessB("a3", { initialSelectedId: "a1" });
		dual.selector.handleInput("\x1b[1;5D");
		expect(dual.selector.render(100).join("")).toContain("(1/6)");
	});

	it("hidden intermediates adopt to the visible ancestor (D4, review P1-1)", () => {
		const roots = toolTurnRoots();
		const picked: string[] = [];
		const selector = makeSelector(roots, {
			leafId: "a2",
			initialSelectedId: "q1",
			onPick: (id) => picked.push(id),
		});
		expect(selector.rows().map((r) => r.entryId)).toEqual(["q1", "q2", "a2", "t1"]); // a1 hidden; active-first puts q2 first, t1 adopts position after
		// alt+right from q1: ADOPTED children = [q2, t1] (row order,
		// active-first) — >1, so it jumps to the first child q2
		selector.handleInput("\x1b[1;3C");
		selector.handleInput("\r");
		expect(picked).toEqual(["q2"]);
		// alt+left from a2 (idx 2): q2's adopted group under q1 is [q2, t1]
		// (>1) and idx(q2)=1 < 2 → jump to q2 — the ADOPTED chain, though a1
		// itself has no row
		const fresh = makeSelector(roots, {
			leafId: "a2",
			initialSelectedId: "a2",
			onPick: (id) => picked.push(id),
		});
		fresh.handleInput("\x1b[1;3D");
		fresh.handleInput("\r");
		expect(picked).toEqual(["q2", "q2"]);
	});

	it("ctrl+x copies the selected entry's full text (D7)", () => {
		const copies: (string | undefined)[] = [];
		const { roots } = posterTree();
		const selector = makeSelector(roots, {
			leafId: "a3",
			initialSelectedId: "q1",
			onCopy: (t) => copies.push(t),
		});
		selector.handleInput("\x18");
		expect(copies).toEqual(["first question"]); // raw content, no "user: " prefix
		selector.handleInput("\x1b[B"); // a1
		selector.handleInput("\x18");
		expect(copies).toEqual(["first question", "an answer"]);
		// toolResult content, and tool-only assistant → undefined (via "all")
		const toolSel = makeSelector(toolTurnRoots(), {
			leafId: "a2",
			initialFilterMode: "all",
			initialSelectedId: "t1",
			onCopy: (t) => copies.push(t),
		});
		toolSel.handleInput("\x18"); // t1: toolResult → its content
		expect(copies).toEqual(["first question", "an answer", "file-a file-b"]);
		toolSel.handleInput("\x1b[A"); // a1 (visible in "all"): text blocks empty → undefined
		toolSel.handleInput("\x18");
		expect(copies).toEqual(["first question", "an answer", "file-a file-b", undefined]);
	});

	it("deep rows auto-pan: the selected anchor's content stays visible (D5)", () => {
		// A deep active chain: every level branches, indents stack up.
		const { roots } = posterTree();
		const { selector } = harnessB("a3", { initialSelectedId: "q2old" });
		// posterTree alone is too shallow to pan — hang a deep chain off q2old
		// via a long label instead? No: pan is INDENT-driven. Build depth by
		// nesting: reuse toolTurn + a chained fixture.
		const deepChain = (depth: number): TreeNode => {
			const mk = (level: number, parentId: string | null): TreeNode =>
				msgNode(level, parentId, level === depth ? "deep target text" : `lvl ${level}`);
			const msgNode = (level: number, parentId: string | null, text: string): TreeNode => {
				const id = `n${level}`;
				const children: TreeNode[] = [];
				const node: TreeNode = {
					entry: {
						type: "message",
						id,
						parentId,
						timestamp: "2026-01-01T00:00:00Z",
						message: level === depth ? user(text) : user(`lvl ${level}`),
					} as TreeNode["entry"],
					children,
				};
				if (level < depth) {
					// two children: the chain continues in the FIRST (branch → indent grows)
					children.push(mk(level + 1, id), mkSib(level + 1, id));
				}
				return node;
			};
			const mkSib = (level: number, parentId: string): TreeNode => ({
				entry: {
					type: "message",
					id: `s${level}`,
					parentId,
					timestamp: "2026-01-01T00:00:00Z",
					message: user(`sibling ${level}`),
				} as TreeNode["entry"],
				children: [],
			});
			return msgNode(0, null, "root");
		};
		const deepRoots = [deepChain(4)]; // indents 0..4 — the deepest active row prefixes ~14 cols
		const selectorD = makeSelector(deepRoots, { leafId: "n4", initialSelectedId: "n4" });
		const narrow = selectorD.render(20); // viewport 18; anchor ≈14 > 18-6 → pans
		const selectedLine = narrow.find((l) => l.includes("\x1b[7m"));
		expect(selectedLine).toBeDefined();
		expect(selectedLine).toContain("deep"); // anchor CONTENT visible — the whole point
		const wide = selectorD.render(120).join("\n");
		expect(wide).toContain("deep target text"); // wide: no pan, full row
		void roots;
		void selector;
	});
});
