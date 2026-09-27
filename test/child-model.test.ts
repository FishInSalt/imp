import { describe, expect, it } from "vitest";
import { resolveChildModel } from "../src/core/child-model.js";
import { knownProvider, parseModelRef } from "../src/provider/resolve.js";

/** SA-02 acceptance: the resolver's classification matrix (design §4, T1). */
describe("resolveChildModel (SA-02)", () => {
	it("C1: no override inherits the parent's family and wire model", () => {
		expect(resolveChildModel({ parentReference: "zai/glm-5.3" })).toEqual({
			ok: true,
			binding: { providerName: "zai", wireModelId: "glm-5.3", reference: "zai/glm-5.3" },
		});
		// Bare anthropic parent reference (runner.modelReference() is bare for anthropic).
		expect(resolveChildModel({ parentReference: "claude-sonnet-4-5" })).toEqual({
			ok: true,
			binding: {
				providerName: "anthropic",
				wireModelId: "claude-sonnet-4-5",
				reference: "anthropic/claude-sonnet-4-5",
			},
		});
	});

	it("C2: a bare override selects on the parent's provider — no CLI default routing", () => {
		// glm-* would route to zai in the main CLI; as an agent-local
		// shorthand under an anthropic parent it stays literal (design §2).
		expect(resolveChildModel({ parentReference: "anthropic/claude-x", override: "glm-5.3" })).toEqual({
			ok: true,
			binding: { providerName: "anthropic", wireModelId: "glm-5.3", reference: "anthropic/glm-5.3" },
		});
		expect(resolveChildModel({ parentReference: "openai/gpt-5.2", override: "gpt-5.4" })).toEqual({
			ok: true,
			binding: { providerName: "openai", wireModelId: "gpt-5.4", reference: "openai/gpt-5.4" },
		});
	});

	it("C3: a same-provider prefix is stripped; model id keeps its case", () => {
		expect(resolveChildModel({ parentReference: "openai/gpt-5.2", override: "openai/gpt-5.4" })).toEqual({
			ok: true,
			binding: { providerName: "openai", wireModelId: "gpt-5.4", reference: "openai/gpt-5.4" },
		});
		expect(resolveChildModel({ parentReference: "zai/glm-5.3", override: "ZAI/GLM-4.6V" })).toEqual({
			ok: true,
			binding: { providerName: "zai", wireModelId: "GLM-4.6V", reference: "zai/GLM-4.6V" },
		});
		// Anthropic parent has a bare canonical reference; the explicit
		// anthropic prefix still classifies as same-provider.
		expect(
			resolveChildModel({ parentReference: "claude-x", override: "anthropic/claude-haiku-4-5" }),
		).toEqual({
			ok: true,
			binding: {
				providerName: "anthropic",
				wireModelId: "claude-haiku-4-5",
				reference: "anthropic/claude-haiku-4-5",
			},
		});
	});

	it("C4: a different-provider prefix is rejected with a useful diagnostic", () => {
		const result = resolveChildModel({
			parentReference: "anthropic/claude-x",
			override: "zai/glm-5.3",
			agentName: "scout",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('agent "scout"');
			expect(result.error).toContain('"zai/glm-5.3"');
			expect(result.error).toContain('"zai"');
			expect(result.error).toContain('"anthropic"');
			expect(result.error).toContain("Cross-provider subagents are not supported");
		}
	});

	it("C5: an unrecognized slash prefix is a legitimate wire id — not a provider delimiter", () => {
		expect(resolveChildModel({ parentReference: "anthropic/claude-x", override: "vendor/models/x" })).toEqual(
			{
				ok: true,
				binding: {
					providerName: "anthropic",
					wireModelId: "vendor/models/x",
					reference: "anthropic/vendor/models/x",
				},
			},
		);
		// A leading slash is the same class (prefix never matches a family).
		expect(resolveChildModel({ parentReference: "openai/gpt-5.2", override: "/x" })).toEqual({
			ok: true,
			binding: { providerName: "openai", wireModelId: "/x", reference: "openai//x" },
		});
	});

	it("C6: empty or blank overrides are rejected as malformed configuration", () => {
		for (const override of ["", "   "]) {
			const result = resolveChildModel({ parentReference: "zai/glm-5.3", override, agentName: "scout" });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('agent "scout"');
		}
	});

	it("C7: a known prefix with an empty model id is rejected", () => {
		for (const override of ["zai/", "anthropic/ ", "ZAI/"]) {
			const result = resolveChildModel({ parentReference: "zai/glm-5.3", override });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("malformed model reference");
		}
	});

	it("normalization: the prefix is trimmed and case-folded, the wire id is trimmed", () => {
		expect(resolveChildModel({ parentReference: "zai/glm-5.3", override: "  zai / glm-4.6  " })).toEqual({
			ok: true,
			binding: { providerName: "zai", wireModelId: "glm-4.6", reference: "zai/glm-4.6" },
		});
		expect(resolveChildModel({ parentReference: "zai/glm-5.3", override: "ZAI/glm-4.6" })).toEqual({
			ok: true,
			binding: { providerName: "zai", wireModelId: "glm-4.6", reference: "zai/glm-4.6" },
		});
	});

	it("an empty parent reference is an internal error, never a guess", () => {
		const result = resolveChildModel({ parentReference: "   " });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("internal error");
	});

	it("the fallback parent (getModel() string) follows the CLI bare-id rule — documented approximation", () => {
		// getModel() returning a bare wire id cannot recover the family; the
		// resolver derives it by parseModelRef (D1). Inherit: same family as
		// the pre-SA-02 metadata path.
		expect(resolveChildModel({ parentReference: "gpt-5.2" })).toEqual({
			ok: true,
			binding: { providerName: "anthropic", wireModelId: "gpt-5.2", reference: "anthropic/gpt-5.2" },
		});
		expect(resolveChildModel({ parentReference: "glm-5.3" })).toEqual({
			ok: true,
			binding: { providerName: "zai", wireModelId: "glm-5.3", reference: "zai/glm-5.3" },
		});
	});
});

/** D2 pin requirement: the CLI's parseModelRef must stay bit-identical. */
describe("parseModelRef pin (SA-02 D2 — CLI behavior unchanged)", () => {
	it("bare ids: glm-* → zai, everything else → anthropic", () => {
		expect(parseModelRef("glm-5.3")).toEqual({ provider: "zai", modelId: "glm-5.3" });
		expect(parseModelRef("  GLM-4.6v ")).toEqual({ provider: "zai", modelId: "GLM-4.6v" });
		expect(parseModelRef("gpt-5.4")).toEqual({ provider: "anthropic", modelId: "gpt-5.4" });
	});

	it("known prefixes are case-insensitive; model ids keep their case", () => {
		expect(parseModelRef("OpenAI/gpt-5.4")).toEqual({ provider: "openai", modelId: "gpt-5.4" });
		expect(parseModelRef(" openai/gpt-5.4")).toEqual({ provider: "openai", modelId: "gpt-5.4" });
		expect(parseModelRef("moonshotai-cn/kimi-k3")).toEqual({ provider: "moonshotai-cn", modelId: "kimi-k3" });
	});

	it("a padded prefix stays an unknown-prefix fallback (anthropic + UNTRIMMED input)", () => {
		expect(parseModelRef("zai / glm-5.3")).toEqual({ provider: "anthropic", modelId: "zai / glm-5.3" });
		expect(parseModelRef("zai /glm-5.3")).toEqual({ provider: "anthropic", modelId: "zai /glm-5.3" });
	});

	it("known prefix with an empty model id falls back to anthropic + the whole trimmed string", () => {
		expect(parseModelRef("zai/")).toEqual({ provider: "anthropic", modelId: "zai/" });
	});

	it("unknown prefixes keep the whole string as the anthropic model id", () => {
		expect(parseModelRef("vendor/models/x")).toEqual({ provider: "anthropic", modelId: "vendor/models/x" });
	});

	it("knownProvider lowercases but does not trim", () => {
		expect(knownProvider("ZAI")).toBe("zai");
		expect(knownProvider("zai ")).toBeUndefined();
		expect(knownProvider("nope")).toBeUndefined();
	});
});
