import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { createRunner } from "../src/runner.js";
import { assistant, gate, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

const user = (content: string): AgentMessage => ({ role: "user", content });

/** Seed a session through the REAL store ops: q1→a1→q2-old→a2-old, then a
 *  fork before q2-old. The runner resumes it; history = the forked (empty)
 *  position — call write() to add the new branch's turns. */
async function navEnv(extra: { provider?: LLMProvider } = {}) {
	const base = await mkdtemp(path.join(tmpdir(), "imp-tree-"));
	const cwd = path.join(base, "proj");
	const requests: LLMRequest[] = [];
	const { renderer } = makeRenderer();
	const runner = await createRunner({
		cwd,
		argv: [],
		settingsPath: path.join(base, "settings.json"),
		model: "claude-sonnet-4-5",
		maxTokens: 1024,
		maxTurns: 4,
		noContextFiles: true,
		noSession: false,
		renderer,
		provider:
			extra.provider ??
			scriptedProvider(
				[
					assistant([{ type: "text", text: "SUMMARY: the abandoned branch" }]),
					assistant([{ type: "text", text: "ok" }]),
				],
				requests,
			),
	});
	const store = runner.session;
	if (store === null) throw new Error("session disabled");
	store.appendMessage(user("q1"));
	const a1 = store.appendMessage(assistant([{ type: "text", text: "a1" }]));
	const q2old = store.appendMessage(user("q2-old"));
	store.appendMessage(assistant([{ type: "text", text: "a2-old" }]));
	store.forkBefore(q2old);
	// current position: leaf = a1, history reloaded from the fork
	const ids = { a1, q2old };
	return { runner, store, ids, requests, base };
}

describe("runner.navigateTree (#tree)", () => {
	it("target === current leaf → noop", async () => {
		const { runner, store } = await navEnv();
		const result = await runner.navigateTree(store.getLeafId() ?? "");
		expect(result).toEqual({ noop: true });
	});

	it("user-message target (real): parent leaf + editorText (pi :3264)", async () => {
		const { runner, store, ids } = await navEnv();
		// q2-old is a user message whose parent is a1 (the current leaf).
		// Navigating to it moves the leaf to a1's id... which IS the current
		// leaf — a no-op. Use q1 instead: parent = null (before everything).
		const q1 = store.getTree()[0]?.entry.id;
		expect(q1).toBeDefined();
		const result = await runner.navigateTree(q1 ?? "", { summarize: false });
		expect("noop" in result ? "noop" : "editorText" in result ? "editorText" : "plain").toBe("editorText");
		if (!("editorText" in result)) throw new Error("unreachable");
		expect(result.editorText).toBe("q1");
		expect(store.getLeafId()).toBeNull(); // resetLeaf semantics (review P1-2)
		expect(result.summary).toBe("disabled"); // summarize not requested
		// history rebuilt: empty branch
		expect(runner.history).toHaveLength(0);
		void ids;
	});

	it("non-user target → leaf lands ON the target; history = its path", async () => {
		const { runner, store, ids } = await navEnv();
		// write the abandoned tip's id by walking the tree
		const a2old = store
			.getTree()[0]
			?.children.find((n) => n.children.length > 0)
			?.children.find((n) => !n.children.some((c) => c.entry.id === ids.q2old))?.children[0]?.entry.id;
		// simpler: the abandoned leg is q2-old → a2-old under a1
		const abandonedTip = store.getTree()[0]?.children[0]?.children.find((n) => n.entry.id === ids.q2old)
			?.children[0]?.entry.id;
		expect(abandonedTip).toBeDefined();
		expect(abandonedTip).toBe(a2old);
		const result = await runner.navigateTree(abandonedTip ?? "", { summarize: false });
		if ("noop" in result || "aborted" in result) throw new Error("expected a plain result");
		expect(result.editorText).toBeUndefined();
		expect(store.getLeafId()).toBe(abandonedTip);
		const texts = runner.history
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""));
		expect(texts).toEqual(["q1", "q2-old"]);
	});

	it("summarize: the abandoned segment is summarized INTO the new position", async () => {
		// current = forked empty branch; write on it first so there IS a left branch
		const { runner, store, ids, requests } = await navEnv();
		store.appendMessage(user("q3-new"));
		store.appendMessage(assistant([{ type: "text", text: "a3-new" }]));
		const a2old = store.getTree()[0]?.children[0]?.children.find((n) => n.entry.id === ids.q2old)?.children[0]
			?.entry.id;
		const result = await runner.navigateTree(a2old ?? "", { summarize: true });
		if ("noop" in result || "aborted" in result) throw new Error("expected a plain result");
		expect(result.summary).toBe("written");
		// exactly one summarizer call, carrying the LEFT branch's content
		expect(requests).toHaveLength(1);
		const first = requests[0]?.messages[0];
		expect(first && "content" in first ? String(first.content) : "").toContain("q3-new");
		// the framed summary heads the new position's context
		const framed = runner.history.find(
			(m): m is AgentMessage & { role: "user" } =>
				m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Branch summary —"),
		);
		expect(framed?.content).toContain("the abandoned branch");
		// the abandoned set excludes the SHARED TRUNK (q1/a1) — review P1-1
		expect(first && "content" in first ? String(first.content) : "").not.toContain("q1");
	});

	it("empty abandoned set → 'empty', no LLM call", async () => {
		const { runner, store, ids, requests } = await navEnv();
		const a2old = store.getTree()[0]?.children[0]?.children.find((n) => n.entry.id === ids.q2old)?.children[0]
			?.entry.id;
		const result = await runner.navigateTree(a2old ?? "", { summarize: true });
		if ("noop" in result || "aborted" in result) throw new Error("expected a plain result");
		expect(result.summary).toBe("empty");
		expect(requests).toHaveLength(0);
	});

	it("IMP_BRANCH_SUMMARY=0 → disabled even when asked", async () => {
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		try {
			const { runner, store, ids, requests } = await navEnv();
			store.appendMessage(user("q3-new"));
			const a2old = store.getTree()[0]?.children[0]?.children.find((n) => n.entry.id === ids.q2old)
				?.children[0]?.entry.id;
			const result = await runner.navigateTree(a2old ?? "", { summarize: true });
			if ("noop" in result || "aborted" in result) throw new Error("expected a plain result");
			expect(result.summary).toBe("disabled");
			expect(requests).toHaveLength(0);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("abort mid-summary → aborted: NOTHING moves (review P1-3)", async () => {
		// a provider whose summarizer call observes the aborted signal and throws
		const gated: LLMProvider = {
			name: "aborting",
			// biome-ignore lint/correctness/useYield: the throw IS the script — abort surfaces as an error before any delta
			async *stream() {
				throw new Error("branch summary: summarizer aborted — incomplete, rejected");
			},
		};
		const { runner, store, ids } = await navEnv({ provider: gated });
		store.appendMessage(user("q3-new"));
		store.appendMessage(assistant([{ type: "text", text: "a3-new" }]));
		const a2old = store.getTree()[0]?.children[0]?.children.find((n) => n.entry.id === ids.q2old)?.children[0]
			?.entry.id;
		const controller = new AbortController();
		controller.abort(); // aborted before the call even starts
		const leafBefore = store.getLeafId();
		const historyBefore = runner.history.length;
		const result = await runner.navigateTree(a2old ?? "", { summarize: true, signal: controller.signal });
		expect(result).toEqual({ aborted: true });
		expect(store.getLeafId()).toBe(leafBefore); // nothing moved
		expect(runner.history).toHaveLength(historyBefore);
		expect(store.getBranch().some((e) => e.type === "branchSummary")).toBe(false);
	});

	it("summarizer FAILURE (not abort) still switches — best-effort by contract", async () => {
		const empty: LLMProvider = {
			name: "empty-summary",
			async *stream() {
				yield { type: "text_delta", text: " " }; // blank summary → rejected by the quality gate
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						blocks: [{ type: "text", text: " " }],
						usage: { inputTokens: 1, outputTokens: 1 },
						stopReason: "end_turn",
					},
				};
			},
		};
		const { runner, store, ids } = await navEnv({ provider: empty });
		store.appendMessage(user("q3-new"));
		const a2old = store.getTree()[0]?.children[0]?.children.find((n) => n.entry.id === ids.q2old)?.children[0]
			?.entry.id;
		const result = await runner.navigateTree(a2old ?? "", { summarize: true });
		if ("noop" in result || "aborted" in result) throw new Error("expected a plain result");
		expect(result.summary).toBe("failed");
		expect(store.getLeafId()).toBe(a2old); // switched anyway
	});
});

describe("navigateTree review-round pins (#tree)", () => {
	it("identity guard: a session swap mid-summarize appends NOTHING to the old store", async () => {
		const hold = gate();
		const requests: LLMRequest[] = [];
		const provider: LLMProvider = {
			name: "gated",
			async *stream(request) {
				requests.push({ ...request, messages: [...request.messages] });
				await hold.promise;
				yield { type: "text_delta", text: "LATE SUMMARY" };
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						blocks: [{ type: "text", text: "LATE SUMMARY" }],
						usage: { inputTokens: 1, outputTokens: 1 },
						stopReason: "end_turn",
					},
				};
			},
		};
		const { runner, store, ids } = await navEnv({ provider });
		store.appendMessage(user("q3-new"));
		const a2old = store.getTree()[0]?.children[0]?.children.find((n) => n.entry.id === ids.q2old)?.children[0]
			?.entry.id;
		const pending = runner.navigateTree(a2old ?? "", { summarize: true });
		runner.newSession(); // the swap happens while the summarizer hangs
		hold.resolve();
		const leafBefore = store.getLeafId();
		const result = await pending;
		if ("noop" in result || "aborted" in result) throw new Error("expected failed");
		expect(result.summary).toBe("failed");
		// the OLD store gained no summary and did not move
		expect(store.getBranch().some((e) => e.type === "branchSummary")).toBe(false);
		expect(store.getLeafId()).toBe(leafBefore);
	});

	it("a compaction entry on the newly selected path is honored by the rebuild", async () => {
		const { runner, store, ids } = await navEnv();
		// put a compaction at the head of the abandoned branch: q2-old's child
		// position on the abandoned branch and compact there: q2-old → compaction
		store.branchTo(ids.q2old);
		const compId = store.appendCompaction("COMPACTED TRUNK", [user("kept-1")], 1000);
		store.appendMessage(user("after-compaction"));
		const tipId = store.appendMessage(assistant([{ type: "text", text: "done" }]));
		// move AWAY (to the other fork), then navigate to the post-compaction tip
		store.branchTo(ids.a1);
		expect(store.getLeafId()).toBe(ids.a1);
		const result = await runner.navigateTree(tipId, { summarize: false });
		void compId;
		if ("noop" in result || "aborted" in result) throw new Error("expected plain");
		// buildContext: compaction summary + retainedTail + after-entries
		const texts = runner.history
			.filter(
				(m): m is AgentMessage & { role: "user"; content: string } =>
					m.role === "user" && typeof m.content === "string" && !m.content.startsWith("["),
			)
			.map((m) => m.content);
		expect(texts).toEqual(["kept-1", "after-compaction"]); // q2-old collapsed into the summary
		const summaryMsg = runner.history.find(
			(m): m is AgentMessage & { role: "user" } =>
				m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Conversation summary"),
		);
		expect(summaryMsg?.content).toContain("COMPACTED TRUNK");
	});
});

describe("batch B: forkSessionAt rides navigateTree (#tree-b)", () => {
	it("forkSessionAt ≡ navigateTree(user target, no summary): same position, same history", async () => {
		const a = await navEnv();
		const b = await navEnv();
		// a fork target must be ON the current branch (forkSessionAt's own
		// defense): extend it, then fork before the newest user message
		const targetA = a.store.appendMessage(user("q3"));
		a.store.appendMessage(assistant([{ type: "text", text: "a3" }]));
		const targetB = b.store.appendMessage(user("q3"));
		b.store.appendMessage(assistant([{ type: "text", text: "a3" }]));
		const viaFork = await a.runner.forkSessionAt(targetA);
		const viaNav = await b.runner.navigateTree(targetB, { summarize: false });
		if ("noop" in viaNav || "aborted" in viaNav) throw new Error("expected plain result");
		expect("noop" in viaFork).toBe(false);
		expect("aborted" in viaFork).toBe(false);
		if ("noop" in viaFork || "aborted" in viaFork) throw new Error("unreachable");
		// positions land on each store's own fork point (ids differ across stores)
		expect(a.store.getLeafId()).toBe(a.ids.a1);
		expect(b.store.getLeafId()).toBe(b.ids.a1);
		expect(a.runner.history.map((m) => (m.role === "user" ? m.content : ""))).toEqual(
			b.runner.history.map((m) => (m.role === "user" ? m.content : "")),
		);
		expect(viaFork.editorText).toBe("q3");
		expect(viaFork.preview).toBe("q3");
		expect(viaFork.messages).toBe(viaNav.messages);
	});

	it("forking the UNANSWERED leaf message moves off it and returns the text (P1)", async () => {
		const { runner, store } = await navEnv();
		const draft = store.appendMessage(user("q3-drafted")); // unanswered leaf
		expect(store.getLeafId()).toBe(draft);
		const result = await runner.forkSessionAt(draft);
		if ("noop" in result || "aborted" in result) throw new Error("expected plain result");
		expect(store.getLeafId()).toBe(store.getBranch().at(-1)?.id); // a1 — the parent
		const leftBehind = store
			.getBranch()
			.some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "q3-drafted");
		expect(leftBehind).toBe(false);
		expect(result.editorText).toBe("q3-drafted");
	});

	it("a NON-user leaf target still noops (assistant tip)", async () => {
		const { runner, store } = await navEnv();
		const result = await runner.navigateTree(store.getLeafId() ?? "");
		expect(result).toEqual({ noop: true });
	});

	it("forkSessionAt keeps its own validation (off-path / non-user rejected)", async () => {
		const { runner, store, ids } = await navEnv();
		store.appendMessage(assistant([{ type: "text", text: "tail" }]));
		await expect(runner.forkSessionAt("no-such-id")).rejects.toThrow("not found");
		const tip = store.getLeafId();
		await expect(runner.forkSessionAt(tip ?? "")).rejects.toThrow("not found"); // assistant ≠ fork point
		void ids;
	});
});
