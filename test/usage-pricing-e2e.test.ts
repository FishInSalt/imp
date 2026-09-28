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
});
