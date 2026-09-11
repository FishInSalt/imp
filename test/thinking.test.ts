import { describe, expect, it } from "vitest";
import {
	anthropicThinkingBudget,
	clampThinkingLevel,
	effortFor,
	supportedThinkingLevels,
	thinkingStyleFor,
} from "../src/provider/thinking.js";

describe("thinking style table (#thinking-levels)", () => {
	it("routes by provider + prefix, longest prefix wins", () => {
		expect(thinkingStyleFor("anthropic", "claude-sonnet-4-5")).toBe("anthropic-budget");
		expect(thinkingStyleFor("anthropic", "glm-5.3")).toBe("glm-anthropic");
		expect(thinkingStyleFor("openai", "gpt-5.4")).toBe("openai-effort");
		expect(thinkingStyleFor("openai", "o3-mini")).toBe("openai-effort");
		expect(thinkingStyleFor("openai", "glm-4.6")).toBe("glm-openai");
		expect(thinkingStyleFor("openai", "deepseek-reasoner")).toBe("auto");
		expect(thinkingStyleFor("openai-codex", "gpt-5.5")).toBe("codex-effort");
		expect(thinkingStyleFor("openai", "llama-3")).toBeNull(); // no knob
		expect(thinkingStyleFor("anthropic", "mistral-7b")).toBeNull();
	});

	it("pi's level ladder: budget/effort styles cap at high; binary styles are on/off", () => {
		expect(supportedThinkingLevels("anthropic-budget")).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(supportedThinkingLevels("openai-effort")).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(supportedThinkingLevels("glm-anthropic")).toEqual(["off", "high"]);
		expect(supportedThinkingLevels("glm-openai")).toEqual(["off", "high"]);
		expect(supportedThinkingLevels("auto")).toEqual(["off", "high"]);
	});

	it("clamp: nearest level, upward first (pi's clampThinkingLevel)", () => {
		expect(clampThinkingLevel("glm-anthropic", "medium")).toBe("high"); // up to the only on-state
		expect(clampThinkingLevel("openai-effort", "max")).toBe("high"); // down from max
		expect(clampThinkingLevel("anthropic-budget", "xhigh")).toBe("high");
		expect(clampThinkingLevel(null, "high")).toBe("off"); // no knob
		expect(clampThinkingLevel("openai-effort", "medium")).toBe("medium"); // available — kept
	});

	it("pi's budget ladder + effort mapping", () => {
		expect(anthropicThinkingBudget("minimal")).toBe(1024);
		expect(anthropicThinkingBudget("low")).toBe(2048);
		expect(anthropicThinkingBudget("medium")).toBe(8192);
		expect(anthropicThinkingBudget("high")).toBe(16384);
		expect(effortFor("medium")).toBe("medium");
		expect(effortFor("xhigh")).toBe("high");
		expect(effortFor("max")).toBe("high");
	});
});
