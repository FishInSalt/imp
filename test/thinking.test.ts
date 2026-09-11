import { describe, expect, it } from "vitest";
import {
	adaptiveEffortFor,
	anthropicThinkingBudget,
	clampThinkingLevel,
	effortFor,
	supportedThinkingLevels,
	thinkingMetaFor,
	thinkingStyleFor,
} from "../src/provider/thinking.js";

describe("thinking model metadata (#thinking-levels, pi catalog parity)", () => {
	it("routes by provider + prefix, longest prefix wins", () => {
		expect(thinkingStyleFor("anthropic", "claude-sonnet-4-5")).toBe("anthropic-budget");
		expect(thinkingStyleFor("anthropic", "claude-sonnet-5")).toBe("anthropic-adaptive");
		expect(thinkingStyleFor("anthropic", "glm-5.3")).toBe("glm-anthropic");
		expect(thinkingStyleFor("openai", "gpt-5.4")).toBe("openai-effort");
		expect(thinkingStyleFor("openai", "o3-mini")).toBe("openai-effort");
		expect(thinkingStyleFor("openai", "glm-4.6")).toBe("glm-openai");
		expect(thinkingStyleFor("openai", "deepseek-reasoner")).toBe("auto");
		expect(thinkingStyleFor("openai-codex", "gpt-5.5")).toBe("codex-effort");
		expect(thinkingStyleFor("openai", "llama-3")).toBeNull(); // no knob
		expect(thinkingStyleFor("anthropic", "mistral-7b")).toBeNull();
	});

	it("family defaults: budget/effort styles off..high; binary styles off/high", () => {
		expect(supportedThinkingLevels(thinkingMetaFor("anthropic", "claude-sonnet-4-5"))).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "gpt-future"))).toEqual([
			// unknown id → fallback rule
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
		expect(supportedThinkingLevels(thinkingMetaFor("anthropic", "glm-5.3"))).toEqual(["off", "high"]);
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "glm-4.6"))).toEqual(["off", "high"]);
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "deepseek-reasoner"))).toEqual(["off", "high"]);
		expect(supportedThinkingLevels(null)).toEqual(["off"]);
	});

	it("per-model maps (pi providers/data + pi.dev live): level availability follows the catalog", () => {
		// gpt-6-astra (pi.dev): off unavailable, minimal→low, xhigh+max native
		expect(supportedThinkingLevels(thinkingMetaFor("openai-codex", "gpt-6-astra"))).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		// gpt-5 (pi openai.json): off unavailable, minimal native, no xhigh
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "gpt-5"))).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
		]);
		// gpt-5.1+: off maps to "none", minimal unavailable
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "gpt-5.1"))).toEqual([
			"off",
			"low",
			"medium",
			"high",
		]);
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "gpt-5.2"))).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		// o3/o4: off AND minimal unavailable
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "o3"))).toEqual(["low", "medium", "high"]);
		// zai glm-5.2 (pi.dev live): off explicit "none"; minimal/low/medium out — off/high/max
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "glm-5.2"))).toEqual(["off", "high", "max"]);
		// glm-5.3 (pi.dev live): off NULL — thinking cannot be disabled; low/high/max
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "glm-5.3"))).toEqual(["low", "high", "max"]);
		// glm-5.2-highspeed gained the effort ladder in the live catalog
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "glm-5.2-highspeed[1m]"))).toEqual([
			"off",
			"high",
			"max",
		]);
		// Claude ≥4.6 adaptive: xhigh (4.7+) / max (4.6+)
		expect(supportedThinkingLevels(thinkingMetaFor("anthropic", "claude-sonnet-4-6"))).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"max",
		]);
		expect(supportedThinkingLevels(thinkingMetaFor("anthropic", "claude-opus-4-8"))).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		// codex pi.dev pattern: minimal→low, xhigh native
		expect(supportedThinkingLevels(thinkingMetaFor("openai-codex", "gpt-5.5"))).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		// openai 5.4/5.5 (pi openai.json): off "none", minimal out, xhigh native
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "gpt-5.4"))).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		// fable-5 (pi anthropic.json): thinking ALWAYS on — no off
		expect(supportedThinkingLevels(thinkingMetaFor("anthropic", "claude-fable-5"))).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		// o1 (pi openai.json): low start like o3
		expect(supportedThinkingLevels(thinkingMetaFor("openai", "o1"))).toEqual(["low", "medium", "high"]);
	});

	it("clamp: nearest level, upward first (pi's clampThinkingLevel)", () => {
		expect(clampThinkingLevel(thinkingMetaFor("anthropic", "glm-5.3"), "medium")).toBe("high"); // up to the only on-state
		expect(clampThinkingLevel(thinkingMetaFor("openai", "gpt-5.2"), "max")).toBe("xhigh"); // 5.2 has xhigh, not max
		expect(clampThinkingLevel(thinkingMetaFor("openai", "gpt-5.4"), "minimal")).toBe("low"); // minimal out on 5.4 → up
		expect(clampThinkingLevel(thinkingMetaFor("openai", "glm-5.3"), "off")).toBe("low"); // off impossible on 5.3
		expect(clampThinkingLevel(thinkingMetaFor("openai", "gpt-5-pro"), "medium")).toBe("high"); // high-only ladder
		expect(clampThinkingLevel(thinkingMetaFor("openai-codex", "gpt-5.5"), "max")).toBe("xhigh"); // up first: max → xhigh exists
		expect(clampThinkingLevel(thinkingMetaFor("anthropic", "claude-sonnet-4-5"), "xhigh")).toBe("high");
		expect(clampThinkingLevel(null, "high")).toBe("off"); // no knob
		// gpt-6-astra: off is UNAVAILABLE — pi clamps upward to minimal
		expect(clampThinkingLevel(thinkingMetaFor("openai-codex", "gpt-6-astra"), "off")).toBe("minimal");
		expect(clampThinkingLevel(thinkingMetaFor("openai", "o3"), "off")).toBe("low"); // minimal also out
		expect(clampThinkingLevel(thinkingMetaFor("openai", "gpt-5.1"), "minimal")).toBe("low");
	});

	it("pi's budget ladder + effort mappings", () => {
		expect(anthropicThinkingBudget("minimal")).toBe(1024);
		expect(anthropicThinkingBudget("low")).toBe(2048);
		expect(anthropicThinkingBudget("medium")).toBe(8192);
		expect(anthropicThinkingBudget("high")).toBe(16384);
		// effortFor = map[level] ?? level
		expect(effortFor(thinkingMetaFor("openai", "gpt-5.4"), "medium")).toBe("medium");
		expect(effortFor(thinkingMetaFor("openai-codex", "gpt-5.5"), "minimal")).toBe("low"); // pi.dev map
		expect(effortFor(thinkingMetaFor("openai", "glm-5.3"), "low")).toBe("low"); // pi.dev native
		expect(effortFor(thinkingMetaFor("openai", "glm-5.2"), "max")).toBe("max");
		expect(effortFor(thinkingMetaFor("openai", "gpt-6-astra"), "minimal")).toBe("low");
		// adaptive effort (pi mapThinkingLevelToEffort)
		expect(adaptiveEffortFor(thinkingMetaFor("anthropic", "claude-opus-4-8"), "minimal")).toBe("low");
		expect(adaptiveEffortFor(thinkingMetaFor("anthropic", "claude-opus-4-8"), "medium")).toBe("medium");
		expect(adaptiveEffortFor(thinkingMetaFor("anthropic", "claude-opus-4-8"), "high")).toBe("high");
		expect(adaptiveEffortFor(thinkingMetaFor("anthropic", "claude-opus-4-8"), "max")).toBe("max"); // mapped
	});

	it('off wire values come from the map (pi\'s off ?? "none")', () => {
		expect(thinkingMetaFor("openai", "gpt-5.1")?.levelMap?.off).toBe("none");
		expect(thinkingMetaFor("openai", "gpt-5")?.levelMap?.off).toBeNull(); // cannot disable
		expect(thinkingMetaFor("openai-codex", "gpt-5.5")?.levelMap?.off).toBeUndefined(); // → "none" default
	});
});
