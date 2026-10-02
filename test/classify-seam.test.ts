import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import { runWithToolCallContext } from "../src/extensions/call-context.js";
import { loadExtensions } from "../src/extensions/loader.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { ClassifyResult } from "../src/extensions/types.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { CLASSIFY_MAX_INPUT_CHARS, CLASSIFY_TIMEOUT_MS, HostClassify } from "../src/repl/classify.js";
import { assistant, makeRenderer } from "./helpers/fakes.js";

// #guardian-auto-mode Wave 2: the classify seam's host implementation
// (design §4 — tests 1-13, host side). The provider factory is mocked so a
// scripted LLMProvider stands in for the wire; everything else is real.

const state = vi.hoisted(() => ({
	provider: undefined as LLMProvider | undefined,
	failFor: new Set<string>(),
}));

vi.mock("../src/provider/resolve.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/provider/resolve.js")>();
	return {
		...actual,
		resolveModel: (reference: string) => {
			if (state.failFor.has(reference)) throw new Error(`unknown model ${reference}`);
			const provider = state.provider;
			if (provider === undefined) throw new Error("no provider configured");
			const ref = actual.parseModelRef(reference);
			return { provider, modelId: ref.modelId };
		},
	};
});

/** Streams `text` and completes (the successful provider contract). */
function textProvider(text: string, sink?: LLMRequest[]): LLMProvider {
	return {
		name: "fake",
		async *stream(request: LLMRequest) {
			sink?.push(request);
			yield { type: "text_delta", text };
			yield { type: "message_end", message: assistant([{ type: "text", text }]) as AssistantMessage };
		},
	};
}

/** Never yields a message_end; ends only when the request's signal aborts. */
function hangingProvider(sink?: LLMRequest[]): LLMProvider {
	return {
		name: "hanging",
		async *stream(request: LLMRequest) {
			sink?.push(request);
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted === true) resolve();
				else request.signal?.addEventListener("abort", () => resolve());
			});
			// no message_end — the seam must treat the abort as unavailable
		},
	};
}

function makeHost(options?: { timeoutMs?: number }) {
	const { renderer, output } = makeRenderer();
	const host = new HostClassify(options);
	host.bind({ renderer, modelReference: () => "anthropic/session-model" });
	return { host, output };
}

const call = <T>(fn: () => Promise<T>, userInputs: readonly string[] = ["delete the build dir"]) =>
	runWithToolCallContext({ callId: "t1", subagent: false, cwd: "/w", userInputs }, fn);

describe("api.classify host seam (#guardian-auto-mode §4)", () => {
	it("parses the contract JSON, records the verdict line, names the model", async () => {
		const { host, output } = makeHost();
		state.provider = textProvider('{"verdict":"allow","reason":"removing the build dir is safe here"}');
		const result = await call(() =>
			host.handler({ system: "you are a gate", prompt: "cmd: rm -rf build" }, "guardian"),
		);
		expect(result).toEqual({
			verdict: "allow",
			reason: "removing the build dir is safe here",
			model: "anthropic/session-model",
		});
		expect(output()).toContain("▪ guardian — classifier: allow — removing the build dir is safe here");
		expect(output()).toContain("(anthropic/session-model)");
	});

	it("returns undefined for garbage, refusal, and truncated answers", async () => {
		const { host } = makeHost();
		for (const text of ["I think it is fine", "I cannot help with that", '{"verdict":"al']) {
			state.provider = textProvider(text);
			await expect(
				call(() => host.handler({ system: "s", prompt: "p" }, "guardian")),
			).resolves.toBeUndefined();
		}
	});

	it("rejects a block verdict — the model cannot write the block path (D7)", async () => {
		const { host, output } = makeHost();
		state.provider = textProvider('{"verdict":"block","reason":"definitely dangerous"}');
		await expect(call(() => host.handler({ system: "s", prompt: "p" }, "guardian"))).resolves.toBeUndefined();
		expect(output()).not.toContain("classifier:");
	});

	it("times out to undefined (and never hangs)", async () => {
		const { host } = makeHost({ timeoutMs: 20 });
		state.provider = hangingProvider();
		await expect(call(() => host.handler({ system: "s", prompt: "p" }, "guardian"))).resolves.toBeUndefined();
	});

	it("fails over-cap requests without calling the provider", async () => {
		const { host } = makeHost();
		const sink: LLMRequest[] = [];
		state.provider = textProvider('{"verdict":"allow","reason":"x"}', sink);
		const big = "x".repeat(CLASSIFY_MAX_INPUT_CHARS);
		await expect(call(() => host.handler({ system: big, prompt: big }, "guardian"))).resolves.toBeUndefined();
		expect(sink).toEqual([]);
	});

	it("pins the §14 contract constants", () => {
		expect(CLASSIFY_MAX_INPUT_CHARS).toBe(128 * 1024);
		expect(CLASSIFY_TIMEOUT_MS).toBe(20_000);
	});

	it("caps the request's own system+prompt with a strict > (§14 boundary)", async () => {
		const { host } = makeHost();
		const sink: LLMRequest[] = [];
		state.provider = textProvider('{"verdict":"ask","reason":"x"}', sink);
		// exactly at the cap ⇒ served
		await call(() =>
			host.handler({ system: "s".repeat(CLASSIFY_MAX_INPUT_CHARS - 1), prompt: "p" }, "guardian"),
		);
		expect(sink).toHaveLength(1);
		// one char over ⇒ dropped without a provider call
		await call(() => host.handler({ system: "s".repeat(CLASSIFY_MAX_INPUT_CHARS), prompt: "p" }, "guardian"));
		expect(sink).toHaveLength(1);
	});

	it("wires the host exactly when the session is interactive (test 9, D8)", async () => {
		const { classifyHostFor, HostClassify: Host } = await import("../src/repl/classify.js");
		expect(classifyHostFor(false)).toBeUndefined();
		expect(classifyHostFor(true)).toBeInstanceOf(Host);
	});

	it("serves nothing without a binding (the non-interactive surface, D8)", async () => {
		const { renderer } = makeRenderer();
		const unbound = new HostClassify();
		void renderer;
		state.provider = textProvider('{"verdict":"allow","reason":"x"}');
		await expect(
			call(() => unbound.handler({ system: "s", prompt: "p" }, "guardian")),
		).resolves.toBeUndefined();
		// and the registry without a wired handler resolves undefined too
		const registry = new ExtensionRegistry();
		await expect(registry.classify({ system: "s", prompt: "p" }, "guardian")).resolves.toBeUndefined();
	});

	it("honors a resolvable model reference; falls back (with a record note) when it cannot resolve", async () => {
		const { host, output } = makeHost();
		const sink: LLMRequest[] = [];
		state.provider = textProvider('{"verdict":"allow","reason":"x"}', sink);
		const result = await call(() =>
			host.handler({ system: "s", prompt: "p", model: "zai/glm-5.3" }, "guardian"),
		);
		expect(result?.model).toBe("zai/glm-5.3");
		expect(sink[0]?.model).toBe("glm-5.3");

		state.failFor = new Set(["unknown/thing"]);
		const fellBack = await call(() =>
			host.handler({ system: "s", prompt: "p", model: "unknown/thing" }, "guardian"),
		);
		expect(fellBack?.model).toBe("anthropic/session-model");
		expect(output()).toContain('note: model "unknown/thing" unavailable, used anthropic/session-model');
	});

	it("carries the frozen snapshot's user inputs into the system block (D11)", async () => {
		const { host } = makeHost();
		const sink: LLMRequest[] = [];
		state.provider = textProvider('{"verdict":"allow","reason":"x"}', sink);
		await call(
			() => host.handler({ system: "you are a gate", prompt: "cmd" }, "guardian"),
			["clean up the build dir", "then run the tests"],
		);
		const system = sink[0]?.system ?? "";
		expect(system).toContain("Trusted context (host-extracted");
		expect(system).toContain("1. clean up the build dir");
		expect(system).toContain("2. then run the tests");
		expect(system).toContain('"verdict":"allow"'); // the host output contract rides along
	});

	it("marks an empty snapshot explicitly instead of pretending to carry evidence", async () => {
		const { host } = makeHost();
		const sink: LLMRequest[] = [];
		state.provider = textProvider('{"verdict":"ask","reason":"no authorization"}', sink);
		await call(() => host.handler({ system: "s", prompt: "p" }, "guardian"), []);
		expect(sink[0]?.system).toContain("no verified user context is available");
	});

	it("returns undefined when there is no call association (D15)", async () => {
		const { host } = makeHost();
		const sink: LLMRequest[] = [];
		state.provider = textProvider('{"verdict":"allow","reason":"x"}', sink);
		await expect(host.handler({ system: "s", prompt: "p" }, "guardian")).resolves.toBeUndefined();
		expect(sink).toEqual([]);
	});

	it("keeps two overlapping calls isolated (D15)", async () => {
		const { host } = makeHost();
		const seen: string[] = [];
		state.provider = {
			name: "two",
			async *stream(request: LLMRequest) {
				const system = request.system;
				await new Promise((resolve) => setTimeout(resolve, 5));
				seen.push(system);
				yield { type: "text_delta", text: '{"verdict":"allow","reason":"ok"}' };
				yield { type: "message_end", message: assistant([{ type: "text", text: "{}" }]) as AssistantMessage };
			},
		};
		await Promise.all([
			call(() => host.handler({ system: "s", prompt: "first" }, "guardian"), ["first task"]),
			call(() => host.handler({ system: "s", prompt: "second" }, "guardian"), ["second task"]),
		]);
		const first = seen.find((s) => s.includes("first task")) ?? "";
		const second = seen.find((s) => s.includes("second task")) ?? "";
		expect(first).not.toContain("second task");
		expect(second).not.toContain("first task");
	});

	it("sanitizes and caps the model's reason before rendering it", async () => {
		const { host, output } = makeHost();
		const long = "x".repeat(500);
		state.provider = textProvider(
			JSON.stringify({ verdict: "ask", reason: `\u001b[31mred\u001b[0m\nsecond line ${long}` }),
		);
		const result = await call(() => host.handler({ system: "s", prompt: "p" }, "guardian"));
		expect(result?.reason).not.toContain("\u001b");
		expect(result?.reason).not.toContain("\n");
		expect((result?.reason ?? "").length).toBeLessThanOrEqual(200);
		expect(result?.reason.endsWith("…")).toBe(true);
		expect(output()).not.toContain("\u001b[31m");
	});

	it("§15/D29: renders the optional subject between the verdict and the reason", async () => {
		const { host, output } = makeHost();
		state.provider = textProvider('{"verdict":"allow","reason":"scratch dir matches the task"}');
		await call(() =>
			host.handler({ system: "s", prompt: "p", subject: "bash: rm -rf /tmp/a1-red" }, "guardian"),
		);
		expect(output()).toContain(
			"▪ guardian — classifier: allow — bash: rm -rf /tmp/a1-red — scratch dir matches the task (anthropic/session-model)",
		);
	});

	it("§15/D29: cleans and caps the subject (160 incl. …); an empty subject is omitted", async () => {
		const { host, output } = makeHost();
		state.provider = textProvider('{"verdict":"ask","reason":"r"}');
		await call(() =>
			host.handler({ system: "s", prompt: "p", subject: `\u001b[31m  a\n b ${"s".repeat(300)}` }, "guardian"),
		);
		const line =
			output()
				.split("\n")
				.find((l) => l.includes("classifier: ask")) ?? "";
		const subject = line.slice(line.indexOf("ask — ") + "ask — ".length, line.indexOf(" — r ("));
		expect(subject.startsWith("a b ")).toBe(true);
		expect(subject.endsWith("…")).toBe(true);
		expect(subject.length).toBe(160);

		await call(() => host.handler({ system: "s", prompt: "p", subject: " \u001b[0m  " }, "guardian"));
		expect(output()).toContain("▪ guardian — classifier: ask — r (anthropic/session-model)");
	});

	it("§15/D30: the record line carries neither the system nor the prompt bodies", async () => {
		const { host, output } = makeHost();
		state.provider = textProvider('{"verdict":"allow","reason":"ok"}');
		await call(() =>
			host.handler(
				{ system: "SYSTEM-TOKEN-1a2b", prompt: "PROMPT-TOKEN-3c4d", subject: "bash: probe" },
				"guardian",
			),
		);
		expect(output()).toContain("bash: probe");
		expect(output()).not.toContain("SYSTEM-TOKEN-1a2b");
		expect(output()).not.toContain("PROMPT-TOKEN-3c4d");
	});

	it("wires the handler through loadExtensions with the extension's name as the source (D9 idiom)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-classify-"));
		const modulePath = path.join(base, "probe.mjs");
		await writeFile(
			modulePath,
			`export default function (api) {
				globalThis.__classifyProbe = () => api.classify({ system: "s", prompt: "p" });
			}\n`,
		);
		const calls: Array<ClassifyResult | undefined> = [];
		const loaded = await loadExtensions({
			cwd: base,
			cliPaths: [modulePath],
			noDiscovery: true,
			classify: async (_request, source) => {
				calls.push({ verdict: "ask", reason: `from ${source}`, model: "m" });
				return { verdict: "ask", reason: `from ${source}`, model: "m" };
			},
		});
		const probe = (globalThis as Record<string, unknown>).__classifyProbe as () => Promise<
			ClassifyResult | undefined
		>;
		const result = await probe();
		expect(result?.reason).toBe("from probe");
		expect(calls).toHaveLength(1);
		void loaded;
	});
});
