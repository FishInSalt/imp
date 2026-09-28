import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage } from "../src/core/messages.js";
import type { SessionEntry } from "../src/core/session/store.js";
import { buildTaskRecord } from "../src/core/task-record.js";
import { priceUsageTotals, usageTotalsTracker } from "../src/core/usage-totals.js";
import { resetCatalogForTest } from "../src/provider/catalog.js";
import { costFor } from "../src/provider/models.js";
import { assistant, scriptedProvider } from "./helpers/fakes.js";

/**
 * SA-05 round 2 (owner acceptance P2): pricing identity is the fully qualified
 * producer reference, and the static rate table is provider-scoped — a
 * reference never picks up another provider's rates, and a bare legacy id is
 * never inferred. See docs/sa-05-usage-totals-design.md §11.
 */

beforeEach(() => {
	// Guarantee the static floor: no catalog overlay, no home-dir cache.
	vi.stubEnv("IMP_CATALOG_PATH", join(mkdtempSync(join(tmpdir(), "imp-cost-")), "missing.json"));
	resetCatalogForTest();
});

describe("SA-05 round 2: costFor is provider-scoped and fully-qualified only", () => {
	it("prices canonical references within their own provider", () => {
		expect(costFor("anthropic/claude-sonnet-4-5")).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		});
		expect(costFor("zai/glm-5.3")).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			subscription: true,
		});
		expect(costFor("openai-codex/gpt-5.4")).toEqual({
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			cacheWrite: 0,
			subscription: true,
		});
	});

	it("a foreign model id under a known provider is NOT priced with another provider's rates", () => {
		// owner repro B: was $3.000 (Anthropic static rates) and subscription-mislabeled
		expect(costFor("openai/claude-sonnet-4-6")).toBeUndefined();
		expect(costFor("openai/gpt-5.4")).toBeUndefined(); // was: openai-codex rates + (sub)
		expect(costFor("anthropic/glm-5.3")).toBeUndefined(); // was: zai $0 subscription
		expect(costFor("zai/claude-sonnet-4-5")).toBeUndefined();
	});

	it("bare ids are legacy without a provider — never inferred", () => {
		expect(costFor("claude-sonnet-4-5")).toBeUndefined();
		expect(costFor("glm-5.3")).toBeUndefined();
		expect(costFor("gpt-5.4")).toBeUndefined();
		expect(costFor("review-shared-model")).toBeUndefined();
	});
});

describe("SA-05 round 2: the aggregate prices qualified stamps only", () => {
	it("a declared modelReference is the ONLY pricing source (slashed wire ids, pre-fix entries)", () => {
		const legacyAssistant: SessionEntry = {
			type: "message",
			id: "a-legacy",
			parentId: null,
			timestamp: "2026-09-27T00:00:00.000Z",
			message: {
				role: "assistant",
				blocks: [{ type: "text", text: "legacy" }],
				usage: { inputTokens: 1_000_000, outputTokens: 0 },
				stopReason: "end_turn",
				// 763cfbc-format wire id that HAPPENS to look like a reference
				model: "anthropic/claude-sonnet-4-5",
			} as AssistantMessage,
		};
		const preFixEntry: SessionEntry = {
			type: "compaction",
			id: "c-prefix",
			parentId: "a-legacy",
			timestamp: "2026-09-27T00:00:01.000Z",
			summary: "s",
			retainedTail: [],
			tokensBefore: 1,
			usage: { inputTokens: 1_000_000, outputTokens: 0 },
			model: "zai/glm-5.3", // 5669ba3-format: identity in `model`, no modelReference
		};
		const declared: SessionEntry = {
			type: "compaction",
			id: "c-declared",
			parentId: "c-prefix",
			timestamp: "2026-09-27T00:00:02.000Z",
			summary: "s",
			retainedTail: [],
			tokensBefore: 1,
			usage: { inputTokens: 1_000_000, outputTokens: 0 },
			model: "test-wire-id", // wire id — never a pricing identity
			modelReference: "anthropic/claude-sonnet-4-5",
		};
		const priced = priceUsageTotals(
			usageTotalsTracker([legacyAssistant, preFixEntry, declared]).view(),
			costFor,
		);
		expect(priced.usd).toBeCloseTo(3, 10); // the DECLARED entry only
		expect(priced.unpriced.inputTokens).toBe(2_000_000); // the slashed legacy wire id + the pre-fix entry
	});

	it("a direct runAgentLoop call without modelReference stamps nothing and prices as unpriced", async () => {
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider: scriptedProvider([
				assistant([{ type: "text", text: "hi" }], "end_turn", { inputTokens: 1_000_000, outputTokens: 0 }),
			]),
			model: "anthropic/claude-sonnet-4-5", // a wire id that LOOKS like a reference
			system: "",
			tools: [],
			history,
			userMessage: "go",
		});
		const message = history.find((m) => m.role === "assistant") as AssistantMessage;
		expect(message.modelReference).toBeUndefined();
		const entry: SessionEntry = {
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-09-27T00:00:00.000Z",
			message,
		};
		const priced = priceUsageTotals(usageTotalsTracker([entry]).view(), costFor);
		expect(priced.usd).toBe(0);
		expect(priced.unpriced.inputTokens).toBe(1_000_000);
	});

	function legacyAssistant(inputTokens: number): SessionEntry {
		return {
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-09-27T00:00:00.000Z",
			message: {
				role: "assistant",
				blocks: [{ type: "text", text: "legacy" }],
				usage: { inputTokens, outputTokens: 0 },
				stopReason: "end_turn",
				model: "claude-sonnet-4-5", // pre-fix wire stamp: bare, no provider
			} as AssistantMessage,
		};
	}

	function qualifiedChild(inputTokens: number): SessionEntry {
		return {
			type: "message",
			id: "t1",
			parentId: "a1",
			timestamp: "2026-09-27T00:00:01.000Z",
			message: {
				role: "toolResult",
				results: [
					{
						toolCallId: "c1",
						toolName: "task",
						content: "",
						isError: false,
						taskRecord: buildTaskRecord({
							attemptId: "att-pricing",
							sourceId: "src-pricing",
							launched: true,
							cwd: "/tmp",
							status: "completed",
							turns: 1,
							textPresent: true,
							usage: { inputTokens, outputTokens: 0 },
							binding: {
								providerName: "anthropic",
								wireModelId: "claude-sonnet-4-5",
								reference: "anthropic/claude-sonnet-4-5",
							},
						}),
					},
				],
			},
		};
	}

	it("a legacy bare stamp is unpriced; the qualified child record still prices", () => {
		const entries: SessionEntry[] = [legacyAssistant(1_000_000), qualifiedChild(1_000_000)];
		const priced = priceUsageTotals(usageTotalsTracker(entries).view(), costFor);
		expect(priced.usd).toBeCloseTo(3, 10); // the child only: 1M input @ $3
		expect(priced.unpriced.inputTokens).toBe(1_000_000); // the legacy parent, marked unknown
	});
});
