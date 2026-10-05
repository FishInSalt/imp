import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childModelMetadata } from "../src/core/subagent.js";
import { loadCatalogCache, resetCatalogForTest } from "../src/provider/catalog.js";

/** SA-02 D4 / acceptance item 6: compaction settings AND the summarizer
 *  output cap must come from the SAME canonical child reference — a bare
 *  wire id reparsed through the CLI defaults must not select another
 *  family (the pre-SA-02 `modelMaxTokensFor(options.model)` defect). */

let base: string;
let savedCatalogPath: string | undefined;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "imp-child-model-meta-"));
	savedCatalogPath = process.env.INK_CATALOG_PATH;
	process.env.INK_CATALOG_PATH = join(base, "catalog.json");
	writeFileSync(
		process.env.INK_CATALOG_PATH,
		JSON.stringify({
			version: 1,
			providers: {
				openai: {
					checkedAt: Date.now(),
					models: {
						"gpt-5.2": { id: "gpt-5.2", contextWindow: 400000, maxTokens: 128000 },
					},
				},
				zai: {
					checkedAt: Date.now(),
					models: {
						"glm-5.3": { id: "glm-5.3", contextWindow: 200000, maxTokens: 96000 },
					},
				},
			},
		}),
		"utf-8",
	);
	loadCatalogCache();
});
afterEach(() => {
	if (savedCatalogPath === undefined) delete process.env.INK_CATALOG_PATH;
	else process.env.INK_CATALOG_PATH = savedCatalogPath;
	resetCatalogForTest();
});

describe("childModelMetadata (SA-02 D4)", () => {
	it("a non-Anthropic inherited model consults its REAL family (wire id is not reparsed as anthropic)", () => {
		// RED before SA-02: modelMaxTokensFor("gpt-5.2") parsed as anthropic → undefined.
		const meta = childModelMetadata({ model: "gpt-5.2", modelReference: "openai/gpt-5.2" });
		expect(meta.reference).toBe("openai/gpt-5.2");
		expect(meta.settings.contextWindow).toBe(400000);
		expect(meta.modelMaxTokens).toBe(128000);
	});

	it("the zai glm-* case uses the zai family through its canonical reference", () => {
		const meta = childModelMetadata({ model: "glm-5.3", modelReference: "zai/glm-5.3" });
		expect(meta.settings.contextWindow).toBe(200000);
		expect(meta.modelMaxTokens).toBe(96000);
	});

	it("a bare glm-* under an anthropic parent resolves to the anthropic family (no zai default)", () => {
		const meta = childModelMetadata({ model: "glm-5.3", modelReference: "anthropic/glm-5.3" });
		expect(meta.reference).toBe("anthropic/glm-5.3");
		// No anthropic catalog entry — the lookups must MISS, not find zai's.
		expect(meta.modelMaxTokens).toBeUndefined();
	});

	it("without modelReference the wire id is the reference (older callers unchanged)", () => {
		const meta = childModelMetadata({ model: "glm-5.3" });
		expect(meta.reference).toBe("glm-5.3");
		expect(meta.modelMaxTokens).toBe(96000); // bare glm-* → zai, same as before
	});

	it("explicit settings stay authoritative over model metadata", () => {
		const settings = { contextWindow: 111, reserveTokens: 5, keepRecentTokens: 1 };
		const meta = childModelMetadata({ model: "gpt-5.2", modelReference: "openai/gpt-5.2", settings });
		expect(meta.settings).toBe(settings);
	});
});
