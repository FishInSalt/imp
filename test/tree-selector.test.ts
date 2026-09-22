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
	entry: { id: string; type: "message" | "branchSummary"; message?: AgentMessage; summary?: string },
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

	it("multi-root: orphans render as additional top-level rows", () => {
		const { roots, ids } = posterTree();
		const orphan = node({ id: "orphan", type: "message", message: user("orphan") });
		const rows = buildTreeRows([...roots, orphan], ids.a3 ?? null, { filter: "default" });
		expect(rows[0]?.prefix).toBe("");
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
	function harness(leafId: string | null) {
		const { roots, ids } = posterTree();
		const picked: string[] = [];
		const cancelled = false;
		const state = { cancelled: false }; // live holder — a bare boolean would destructure by value
		const selector = new TreeSelectorComponent(
			roots,
			leafId,
			10,
			(id) => picked.push(id),
			() => {
				state.cancelled = true;
			},
		);
		return { selector, picked, state, ids };
	}

	it("arrows move; enter selects; escape cancels", () => {
		const { selector, picked, state } = harness("a3");
		selector.handleInput("\x1b[B"); // down
		selector.handleInput("\x1b[A"); // up — back to row 0
		selector.handleInput("\r"); // enter on row 0
		expect(picked).toEqual(["q1"]);
		selector.handleInput("\x1b"); // no search open — Esc cancels directly
		expect(state.cancelled).toBe(true);
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

	it("tab cycles default → no-tools → user-only; f folds", () => {
		const { selector } = harness("a3");
		// default: 6 rows; no-tools (no toolResults here): 6; user-only: 3
		selector.handleInput("\t");
		expect(selector.rows()).toHaveLength(6); // no-tools — same count, no toolResults to hide
		selector.handleInput("\t");
		// a3 is an assistant but the CURRENT LEAF — absolute visibility (§3.3)
		expect(selector.rows().map((r) => r.entryId)).toEqual(["q1", "q2new", "a3", "q2old"]);
		selector.handleInput("\t");
		expect(selector.rows()).toHaveLength(6); // back to default
		// fold the root (selected=0)
		selector.handleInput("f");
		expect(selector.rows()).toHaveLength(1);
		selector.handleInput("f");
		expect(selector.rows()).toHaveLength(6);
	});
});
