import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMRequest } from "../src/provider/types.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

/**
 * SA-05 round 2 (owner acceptance repro A, end to end): runner -> persistence
 * -> reopen -> pricing. Two providers publish the SAME model id at different
 * rates ($1 anthropic vs $7 openai); an OpenAI runner must persist the fully
 * qualified producer reference and price every call at $7.
 *
 * The compaction settings and the catalog overlay are module-load state, so
 * the src modules are dynamically imported after the env stubs + resetModules
 * (the compaction-wiring.test.ts pattern).
 */

let base: string;

beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "imp-pricing-e2e-"));
	vi.stubEnv("IMP_LOG", "0");
	vi.stubEnv("IMP_AUTOCOMPACT", "0"); // compact manually — exactly one summarizer call
	vi.stubEnv("IMP_CONTEXT_WINDOW", "200000");
	vi.stubEnv("IMP_KEEP_RECENT", "1");
	vi.stubEnv("IMP_CATALOG_PATH", path.join(base, "catalog.json"));
	writeFileSync(
		path.join(base, "catalog.json"),
		JSON.stringify({
			version: 1,
			providers: {
				anthropic: {
					checkedAt: Date.now(),
					models: {
						"review-shared-model": {
							id: "review-shared-model",
							contextWindow: 200000,
							cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					},
				},
				openai: {
					checkedAt: Date.now(),
					models: {
						"review-shared-model": {
							id: "review-shared-model",
							contextWindow: 200000,
							cost: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					},
				},
			},
		}),
	);
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("SA-05 round 2: runner -> persistence -> reopen -> pricing", () => {
	it("prices every producer at its own provider's rates (shared model id)", async () => {
		const { createRunner } = await import("../src/runner.js");
		const { SessionStore } = await import("../src/core/session/store.js");
		const { usageTotalsTracker, priceUsageTotals } = await import("../src/core/usage-totals.js");
		const { loadCatalogCache } = await import("../src/provider/catalog.js");
		const { costFor } = await import("../src/provider/models.js");
		loadCatalogCache(path.join(base, "catalog.json"));

		const { renderer } = makeRenderer();
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				assistant([{ type: "text", text: "first" }], "end_turn", { inputTokens: 1_000_000, outputTokens: 0 }),
				assistant([{ type: "text", text: "second" }], "end_turn", {
					inputTokens: 1_000_000,
					outputTokens: 0,
				}),
				assistant([{ type: "text", text: "## Goal\nsummary" }], "end_turn", {
					inputTokens: 1_000_000,
					outputTokens: 0,
				}),
			],
			requests,
		);
		const cwd = path.join(base, "proj");
		const runner = await createRunner({
			cwd,
			argv: [],
			settingsPath: path.join(base, "settings.json"),
			model: "openai/review-shared-model",
			maxTokens: 1024,
			maxTurns: 4,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: base,
			renderer,
			provider,
		});
		await runner.runTurn({ userMessage: "one" });
		await runner.runTurn({ userMessage: "two" });
		expect(await runner.compactNow()).toBe("compacted");

		// Reopen the file from disk: identity and money survive.
		const filePath = runner.session?.filePath ?? "";
		const reopened = SessionStore.open(filePath);
		const priced = priceUsageTotals(usageTotalsTracker(reopened.getEntries()).view(), costFor);
		// Three producer calls (2 parent + 1 summarizer), 1M input each at $7.
		// On 763cfbc this is $3 (bare stamps resolve to the anthropic entry).
		expect(priced.usd).toBeCloseTo(21, 10);
		expect(priced.unpriced.inputTokens).toBe(0);

		// And the persisted identity is the fully qualified producer reference.
		const entries = reopened.getEntries();
		const assistants = entries.filter(
			(e): e is Extract<typeof e, { type: "message" }> =>
				e.type === "message" && e.message.role === "assistant",
		);
		expect(assistants).toHaveLength(2);
		for (const entry of assistants) {
			expect((entry.message as { modelReference?: string }).modelReference).toBe(
				"openai/review-shared-model",
			);
		}
		const compaction = entries.find((e) => e.type === "compaction");
		expect((compaction as { model?: string } | undefined)?.model).toBe("openai/review-shared-model");
	});

	it("a mid-run family switch does not fabricate the stamp (delta review F1)", async () => {
		vi.stubEnv("IMP_AUTOCOMPACT", "1"); // the in-run compaction seam must fire
		vi.stubEnv("IMP_CONTEXT_WINDOW", "4000"); // ...small window, 1M-token turns
		const { createRunner } = await import("../src/runner.js");
		const { SessionStore } = await import("../src/core/session/store.js");
		const { usageTotalsTracker, priceUsageTotals } = await import("../src/core/usage-totals.js");
		const { loadCatalogCache } = await import("../src/provider/catalog.js");
		const { costFor } = await import("../src/provider/models.js");
		loadCatalogCache(path.join(base, "catalog.json"));

		let runnerRef: { setModel(reference: string): void } | null = null;
		let calls = 0;
		const { renderer } = makeRenderer();
		const provider = {
			name: "fake",
			async *stream(request: LLMRequest) {
				calls += 1;
				const isSummary = request.tools.length === 0;
				if (isSummary) {
					yield { type: "text_delta" as const, text: "## Goal\nsummary" };
					yield {
						type: "message_end" as const,
						message: {
							role: "assistant" as const,
							blocks: [{ type: "text" as const, text: "## Goal\nsummary" }],
							usage: { inputTokens: 1_000_000, outputTokens: 0 },
							stopReason: "end_turn" as const,
						},
					};
					return;
				}
				if (calls === 1) {
					// the live family switch lands MID-TURN (allowedDuringRun);
					// the next loop turn's compaction still runs on the snapshot
					runnerRef?.setModel("openai/review-shared-model");
					yield { type: "tool_call_start" as const, id: "t1", name: "bash" };
					yield {
						type: "message_end" as const,
						message: {
							role: "assistant" as const,
							blocks: [{ type: "toolCall" as const, id: "t1", name: "bash", arguments: { command: "true" } }],
							usage: { inputTokens: 1_000_000, outputTokens: 0 },
							stopReason: "tool_use" as const,
						},
					};
					return;
				}
				yield { type: "text_delta" as const, text: "done" };
				yield {
					type: "message_end" as const,
					message: {
						role: "assistant" as const,
						blocks: [{ type: "text" as const, text: "done" }],
						usage: { inputTokens: 1_000_000, outputTokens: 0 },
						stopReason: "end_turn" as const,
					},
				};
			},
		};
		const runner = await createRunner({
			cwd: path.join(base, "proj2"),
			argv: [],
			settingsPath: path.join(base, "settings2.json"),
			model: "anthropic/review-shared-model", // the run snapshot's family
			maxTokens: 1024,
			maxTurns: 4,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: base,
			renderer,
			provider,
		});
		runnerRef = runner;
		await runner.runTurn({ userMessage: "one" }); // tool round -> turn 2 compacts AFTER the switch

		const reopened = SessionStore.open(runner.session?.filePath ?? "");
		const entries = reopened.getEntries();
		// Every producer call ran on the SNAPSHOT pair (anthropic, $1) — the
		// compaction must NOT be stamped openai/... just because providerName
		// moved mid-run.
		const compaction = entries.find((e) => e.type === "compaction");
		expect(compaction).toBeDefined();
		expect((compaction as { model?: string } | undefined)?.model).toBe("anthropic/review-shared-model");
		const priced = priceUsageTotals(usageTotalsTracker(entries).view(), costFor);
		expect(priced.usd).toBeCloseTo(3, 10); // 3 calls x 1M @ $1 — not $9
		expect(priced.unpriced.inputTokens).toBe(0);
	});
});
