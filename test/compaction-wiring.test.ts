import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactionSettings } from "../src/core/compaction.js";
import type { LLMRequest } from "../src/provider/types.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "imp-compaction-wiring-"));
	vi.stubEnv("IMP_LOG", "0");
	vi.stubEnv("IMP_CONTEXT_WINDOW", undefined);
	vi.stubEnv("IMP_KEEP_RECENT", "1");
	vi.stubEnv("IMP_AUTOCOMPACT", "1");
	vi.stubEnv("IMP_CATALOG_PATH", join(base, "catalog.json"));
	vi.resetModules();
	writeFileSync(
		join(base, "catalog.json"),
		JSON.stringify({
			version: 1,
			providers: {
				anthropic: {
					checkedAt: Date.now(),
					models: {
						shared: { id: "shared", contextWindow: 1000000 },
						small: { id: "small", contextWindow: 100000 },
					},
				},
				openai: {
					checkedAt: Date.now(),
					models: {
						"vendor/small": { id: "vendor/small", contextWindow: 100000 },
					},
				},
				zai: {
					checkedAt: Date.now(),
					models: {
						shared: { id: "shared", contextWindow: 100000 },
					},
				},
			},
		}),
	);
	const { loadCatalogCache } = await import("../src/provider/catalog.js");
	loadCatalogCache();
});
afterEach(() => {
	vi.unstubAllEnvs();
});

const echo = {
	name: "echo",
	description: "echo",
	parameters: Type.Object({}),
	async execute() {
		return { output: "done" };
	},
};
function childScript(compacts: boolean) {
	const first = assistant([{ type: "toolCall" as const, id: "t", name: "echo", arguments: {} }]);
	// #compaction-thinking-retry: the fixture context must sit BETWEEN the
	// catalog-100k threshold (min(85k, 100k − 32,768) = 67,232) and the legacy
	// DEFAULT threshold (131,072 − 32,768 = 98,304), so the cross-provider /
	// no-reference cases (legacy settings → no compact) still discriminate
	// against the catalog cases (compact).
	first.usage = { inputTokens: 90000, outputTokens: 1 };
	return [
		first,
		...(compacts ? [assistant([{ type: "text" as const, text: "SUMMARY" }])] : []),
		assistant([{ type: "text" as const, text: "FINAL" }]),
	];
}

describe("child model-aware compaction wiring", () => {
	it.each([
		["anthropic/shared", false],
		["zai/shared", true],
	])("standalone reference %s disambiguates the same wire model", async (modelReference, compacts) => {
		const { runSubagent } = await import("../src/core/subagent.js");
		const requests: LLMRequest[] = [];
		const result = await runSubagent({
			provider: scriptedProvider(childScript(compacts), requests),
			model: "shared",
			modelReference,
			system: "test",
			tools: [echo],
			prompt: "go",
			autoCompact: true,
		});
		expect(result.text).toBe("FINAL");
		expect(requests).toHaveLength(compacts ? 3 : 2);
		expect(requests.every((r) => r.model === "shared")).toBe(true);
	});

	it("bare slash model uses the parent provider's catalog threshold", async () => {
		const { compactionSettingsFor } = await import("../src/provider/compaction-settings.js");
		expect(compactionSettingsFor("openai/vendor/small")).toMatchObject({
			contextWindow: 100000,
			triggerTokens: 67232,
		});
	});

	it("explicit settings remain authoritative over model metadata", async () => {
		const { runSubagent } = await import("../src/core/subagent.js");
		const requests: LLMRequest[] = [];
		const settings: CompactionSettings = {
			contextWindow: 1000000,
			reserveTokens: 16384,
			keepRecentTokens: 1,
		};
		const result = await runSubagent({
			provider: scriptedProvider(childScript(false), requests),
			model: "shared",
			modelReference: "zai/shared",
			system: "test",
			tools: [echo],
			prompt: "go",
			autoCompact: true,
			settings,
		});
		expect(result.text).toBe("FINAL");
		expect(requests).toHaveLength(2);
	});

	it.each([
		// [parent reference, agent override, compacts, expected wire model]
		["anthropic/shared", undefined, false, "shared"],
		["zai/shared", undefined, true, "shared"],
		["anthropic/shared", "small", true, "small"],
		["openai/shared", "vendor/small", true, "vendor/small"],
		// SA-02 C3: the same-provider prefix is stripped for the request.
		["anthropic/shared", "anthropic/small", true, "small"],
		// SA-02 D1 fallback: parent derived from "shared" = anthropic/shared,
		// so the override is same-provider (C3) — wire "small" and the settings
		// come from the canonical anthropic/small window (100k → compacts).
		[undefined, "anthropic/small", true, "small"],
		[undefined, "small", true, "small"],
	] as const)(
		"task reference %s override %s compacts=%s wire=%s",
		async (reference, override, compacts, wire) => {
			const { createTaskTool } = await import("../src/core/tools/task.js");
			const requests: LLMRequest[] = [];
			const tool = createTaskTool({
				getProvider: () => scriptedProvider(childScript(compacts), requests),
				getModel: () => "shared",
				getModelReference: reference ? () => reference : undefined,
				getSystem: () => "test",
				getTools: () => [echo],
				getSession: () => null,
				getAutoCompact: () => true,
				childSessions: false,
				agents: [{ name: "worker", description: "test", system: "", source: "test", model: override }],
			});
			const result = await tool.execute({ prompt: "go", agent: "worker" }, new AbortController().signal);
			expect(result.isError).toBe(false);
			expect(result.output).toContain("FINAL");
			expect(requests).toHaveLength(compacts ? 3 : 2);
			expect(requests.every((r) => r.model === wire)).toBe(true);
		},
	);

	it("SA-02 C4: a cross-provider override is rejected before launch — zero provider calls", async () => {
		const { createTaskTool } = await import("../src/core/tools/task.js");
		const requests: LLMRequest[] = [];
		const tool = createTaskTool({
			getProvider: () => scriptedProvider(childScript(false), requests),
			getModel: () => "shared",
			getModelReference: () => "anthropic/shared",
			getSystem: () => "test",
			getTools: () => [echo],
			getSession: () => null,
			getAutoCompact: () => true,
			childSessions: false,
			agents: [{ name: "worker", description: "test", system: "", source: "test", model: "zai/shared" }],
		});
		const result = await tool.execute({ prompt: "go", agent: "worker" }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Cross-provider subagents are not supported");
		expect(requests).toHaveLength(0);
	});
});

describe("Runner model-aware compaction wiring", () => {
	it("construction and model switching refresh actual ratio thresholds", async () => {
		const { createRunner } = await import("../src/runner.js");
		const { createSession } = await import("../src/core/session/manager.js");
		const cwd = join(base, "project");
		const store = createSession(cwd, base);
		store.appendMessage({ role: "user", content: "seed" });
		const seed = assistant([{ type: "text", text: "seed answer" }]);
		seed.usage = { inputTokens: 900000, outputTokens: 1 };
		store.appendMessage(seed);
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				assistant([{ type: "text", text: "SUMMARY" }]),
				assistant([{ type: "text", text: "reply" }]),
				...childScript(true).slice(1),
			],
			requests,
		);
		const { renderer } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "anthropic/shared",
			maxTokens: 1024,
			maxTurns: 5,
			noContextFiles: true,
			noSession: false,
			resume: store.header.id,
			sessionBaseDir: base,
			renderer,
			provider,
			agentsHomeDir: base,
		});
		await runner.runTurn({ userMessage: "continue" });
		expect(requests).toHaveLength(2); // 900k > 850k, but below the former 983616 trigger
		expect(runner.history[0]).toMatchObject({ role: "user", content: expect.stringContaining("SUMMARY") });
		runner.setModel("anthropic/small");
		// Add a fresh usage anchor after the previous summary boundary.
		const high = assistant([{ type: "text", text: "more" }]);
		high.usage = { inputTokens: 90000, outputTokens: 1 };
		runner.history.push({ role: "user", content: "next" }, high);
		runner.session?.appendMessage({ role: "user", content: "next" });
		runner.session?.appendMessage(high);
		await runner.runTurn({ userMessage: "continue again" });
		expect(requests).toHaveLength(4);
		expect(requests.slice(2).every((r) => r.model === "small")).toBe(true);
	});
});
