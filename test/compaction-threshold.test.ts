import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact, summarizerMaxTokens } from "../src/core/compaction.js";
import { loadCatalogCache, resetCatalogForTest } from "../src/provider/catalog.js";
import { compactionSettingsFor } from "../src/provider/compaction-settings.js";
import { registerDiscoveredContextWindows, resetDiscoveredWindowsForTest } from "../src/provider/discover.js";
import { contextWindowFor, contextWindowInfoFor } from "../src/provider/models.js";
import { mkTempDir } from "./helpers/mktemp.js";

beforeEach(() => {
	vi.stubEnv("INK_CONTEXT_WINDOW", undefined);
	vi.stubEnv("INK_CATALOG_PATH", join(mkTempDir("ink-threshold-"), "catalog.json"));
	resetCatalogForTest();
	resetDiscoveredWindowsForTest();
});
afterEach(() => {
	resetCatalogForTest();
	resetDiscoveredWindowsForTest();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function installCatalog(models: Record<string, { id: string; contextWindow: number }>): void {
	writeFileSync(
		process.env.INK_CATALOG_PATH as string,
		JSON.stringify({ version: 1, providers: { zai: { models, checkedAt: Date.now() } } }),
	);
	loadCatalogCache();
}

describe("context window provenance", () => {
	it("preserves environment > catalog > discovery > static > fallback precedence", () => {
		expect(contextWindowInfoFor("unknown-model")).toEqual({ contextWindow: 131072, source: "fallback" });
		expect(contextWindowInfoFor("zai/glm-5.3")).toEqual({ contextWindow: 1000000, source: "static" });
		registerDiscoveredContextWindows({ "glm-5.3": 200000 });
		expect(contextWindowInfoFor("zai/glm-5.3")).toEqual({ contextWindow: 200000, source: "discovery" });
		installCatalog({ "glm-5.3": { id: "glm-5.3", contextWindow: 512000 } });
		expect(contextWindowInfoFor("zai/glm-5.3")).toEqual({ contextWindow: 512000, source: "catalog" });
		vi.stubEnv("INK_CONTEXT_WINDOW", "65536");
		expect(contextWindowInfoFor("zai/glm-5.3")).toEqual({ contextWindow: 65536, source: "env" });
		expect(contextWindowFor("zai/glm-5.3")).toBe(65536);
	});

	it.each(["", "0", "-1", "NaN", "Infinity"])("ignores invalid override %j", (value) => {
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.stubEnv("INK_CONTEXT_WINDOW", value);
		expect(contextWindowInfoFor("unknown-model").source).toBe("fallback");
		expect(contextWindowInfoFor("glm-5.3").source).toBe("static");
	});

	it("distinguishes catalog and discovery 131072 windows from the same numeric fallback", () => {
		installCatalog({ known: { id: "known", contextWindow: 131072 } });
		registerDiscoveredContextWindows({ discovered: 131072 });
		expect(contextWindowInfoFor("zai/known").source).toBe("catalog");
		expect(contextWindowInfoFor("zai/discovered").source).toBe("discovery");
		expect(contextWindowInfoFor("unknown-model").source).toBe("fallback");
		// #compaction-thinking-retry: with reserve 32,768 > 0.15 × 131,072 the
		// min() branch and the fallback branch COINCIDE numerically — provenance
		// is asserted via source above; both thresholds now read 98,304.
		for (const reference of ["zai/known", "zai/discovered"]) {
			expect(contextWindowFor(reference)).toBe(131072);
			expect(compactionSettingsFor(reference).triggerTokens).toBe(98304);
		}
		expect(compactionSettingsFor("unknown-model").triggerTokens).toBe(98304);
	});
});

describe("automatic compaction thresholds", () => {
	// #compaction-thinking-retry: reserve 16,384 → 32,768; every row reflects
	// min(floor(0.85 × W), W − 32,768) — or the ratio branch when W ≤ reserve.
	// Rows with W > 218,453 are unchanged; smaller windows keep the full reserve.
	it.each([
		[1000000, 850000],
		[272000, 231200],
		[200000, 167232],
		[131072, 98304],
		[65536, 32768],
		[32768, 27852],
		[16385, 13927],
		[16384, 13926],
		[8192, 6963],
		[1, 1],
	])("known window %i has strict threshold %i", (window, threshold) => {
		vi.stubEnv("INK_CONTEXT_WINDOW", String(window));
		const settings = compactionSettingsFor("unknown-model");
		expect(contextWindowInfoFor("unknown-model").source).toBe("env");
		expect(settings.contextWindow).toBe(window);
		expect(settings.triggerTokens).toBe(threshold);
		expect(shouldCompact(threshold - 1, settings)).toBe(false);
		expect(shouldCompact(threshold, settings)).toBe(false);
		expect(shouldCompact(threshold + 1, settings)).toBe(true);
		expect(settings.reserveTokens).toBe(32768);
		expect(settings.keepRecentTokens).toBe(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
		expect(summarizerMaxTokens(settings.reserveTokens)).toBe(26214);
		expect(summarizerMaxTokens(settings.reserveTokens, 4096)).toBe(4096);
	});

	it("uses static known windows and legacy unknown thresholds", () => {
		expect(compactionSettingsFor("zai/glm-5.3").triggerTokens).toBe(850000);
		const settings = compactionSettingsFor("unknown-model");
		expect(settings.contextWindow).toBe(131072);
		expect(shouldCompact(98304, settings)).toBe(false);
		expect(shouldCompact(98305, settings)).toBe(true);
	});

	it("preserves explicit legacy settings and honors an explicit zero trigger", () => {
		const settings = { contextWindow: 100, reserveTokens: 20, keepRecentTokens: 10 };
		expect(shouldCompact(80, settings)).toBe(false);
		expect(shouldCompact(81, settings)).toBe(true);
		expect(shouldCompact(0, { ...settings, triggerTokens: 0 })).toBe(false);
		expect(shouldCompact(1, { ...settings, triggerTokens: 0 })).toBe(true);
		expect(DEFAULT_COMPACTION_SETTINGS.triggerTokens).toBeUndefined();
	});
});
