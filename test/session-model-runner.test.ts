import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, listSessions } from "../src/core/session/manager.js";
import { type SessionModel, SessionStore } from "../src/core/session/store.js";
import type { LLMRequest } from "../src/provider/types.js";
import { createRunner, type RunnerOptions } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

// Replace every provider factory, including cross-family restoration. Parsing,
// runner state transitions, context replay and JSONL persistence remain real.
const calls = vi.hoisted(() => [] as { family: string; request: LLMRequest }[]);
vi.mock("../src/provider/resolve.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/provider/resolve.js")>();
	const { assistant, scriptedProvider } = await import("./helpers/fakes.js");
	const createProviderFor = vi.fn((family: string) => {
		const fake = scriptedProvider([assistant([{ type: "text", text: "reply" }])]);
		return {
			...fake,
			stream: (...args: Parameters<typeof fake.stream>) => {
				calls.push({ family, request: args[0] });
				return fake.stream(...args);
			},
		};
	});
	return {
		...actual,
		createProviderFor,
		resolveModel: (reference: string) => {
			const ref = actual.parseModelRef(reference);
			return { provider: createProviderFor(ref.provider), modelId: ref.modelId };
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

let root: string;
let cwd: string;
let baseDir: string;
const initial = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const other = { provider: "openai", modelId: "gpt-5.2" };
const zai = { provider: "zai", modelId: "glm-5.3" };
const qualified = (model: SessionModel) => `${model.provider}/${model.modelId}`;
const snapshot = (store: SessionStore) => ({
	bytes: fs.readFileSync(store.filePath, "utf8"),
	mtime: fs.statSync(store.filePath).mtimeMs,
});
const reopen = (store: SessionStore) => SessionStore.open(store.filePath);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(tmpdir(), "imp-session-model-runner-"));
	cwd = path.join(root, "project");
	baseDir = path.join(root, "sessions");
	fs.mkdirSync(cwd);
	// settings-setup already isolates globals; each case also gets independent
	// settings/auth/catalog files and an empty home for deterministic defaults.
	for (const [key, value] of Object.entries({
		HOME: root,
		IMP_SETTINGS_PATH: path.join(root, "settings.json"),
		IMP_AUTH_PATH: path.join(root, "auth.json"),
		IMP_CATALOG_PATH: path.join(root, "catalog.json"),
		IMP_LOG: "0",
		IMP_BRANCH_SUMMARY: "0",
	}))
		vi.stubEnv(key, value);
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"OPENAI_API_KEY",
		"ZAI_API_KEY",
		"IMP_MODEL",
		"IMP_THINKING",
	])
		vi.stubEnv(key, undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden in session model tests");
		}),
	);
	calls.length = 0;
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	fs.rmSync(root, { recursive: true, force: true });
});

async function runner(options: Partial<RunnerOptions> = {}) {
	const { renderer, output } = makeRenderer();
	const live = await createRunner({
		cwd,
		argv: [],
		model: qualified(initial),
		maxTokens: 1024,
		maxTurns: 3,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: baseDir,
		renderer,
		settingsPath: path.join(root, "settings.json"),
		agentsHomeDir: root,
		...options,
	});
	return Object.assign(live, { output });
}
function saved(model?: SessionModel, text = "saved history") {
	const store = createSession(cwd, baseDir);
	if (model) store.seedModel(model);
	store.appendMessage({ role: "user", content: text });
	store.appendMessage(assistant([{ type: "text", text: "saved reply" }]));
	return store;
}

describe("runner per-session model restoration", () => {
	it.each(["resume", "continue"])("startup %s restores model before making any request", async (mode) => {
		const store = saved(other);
		const before = snapshot(store);
		const live = await runner(mode === "resume" ? { resume: store.header.id } : { continueRecent: true });
		expect(live.session?.header.id).toBe(store.header.id);
		expect(live.modelReference()).toBe(qualified(other));
		expect(live.providerName).toBe(other.provider);
		expect(live.history).toEqual(store.buildContext().messages);
		expect(live.output()).toContain(qualified(other));
		expect(snapshot(store)).toEqual(before);
		expect(calls).toEqual([]);
		await live.runTurn({ userMessage: "next" });
		expect(calls.map(({ family, request }) => [family, request.model])).toEqual([
			[other.provider, other.modelId],
		]);
	});

	it("slash resume restores independent selections and history without writing either file", async () => {
		const a = saved(initial, "session A");
		const b = saved(other, "session B");
		const beforeA = snapshot(a);
		const beforeB = snapshot(b);
		const live = await runner({ resume: a.header.id });
		const history = live.history;
		for (const [store, model] of [
			[b, other],
			[a, initial],
			[b, other],
		] as const) {
			live.resumeSession(store.header.id);
			expect(live.history).toBe(history);
			expect(live.history).toEqual(store.buildContext().messages);
			expect(live.session?.header.id).toBe(store.header.id);
			expect(live.session?.getModel()).toEqual(model);
			expect(live.providerName).toBe(model.provider);
			expect(live.model).toBe(model.modelId);
		}
		expect(snapshot(a)).toEqual(beforeA);
		expect(snapshot(b)).toEqual(beforeB);
		expect(calls).toEqual([]);
	});

	it("captures the initial model on the first message without /model and reuses injected providers", async () => {
		const requests: LLMRequest[] = [];
		const live = await runner({
			provider: scriptedProvider([assistant([{ type: "text", text: "injected" }])], requests),
		});
		const store = live.session!;
		expect(fs.existsSync(store.filePath)).toBe(false);
		expect(live.listSessions()).toEqual([]);
		await live.runTurn({ userMessage: "first" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.model).toBe(initial.modelId);
		expect(reopen(store).getModel()).toEqual(initial);
		expect(reopen(store).hasModelSelection).toBe(false);
		expect(JSON.parse(snapshot(store).bytes.split("\n")[0]!).model).toEqual(initial);
	});

	it("switching before any message immediately creates a discoverable model-only session", async () => {
		const live = await runner();
		live.setModel(qualified(other));
		const store = live.session!;
		expect(reopen(store).getModel()).toEqual(other);
		expect(reopen(store).hasModelSelection).toBe(true);
		expect(reopen(store).buildContext().messages).toEqual([]);
		expect(listSessions(cwd, baseDir)).toMatchObject([
			{ id: store.header.id, title: `(model: ${qualified(other)})` },
		]);
		const continued = await runner({ continueRecent: true });
		expect(continued.session?.header.id).toBe(store.header.id);
		expect(continued.modelReference()).toBe(qualified(other));
		expect(calls).toEqual([]);
	});

	it("explicit startup override persists once, but does not override later slash resume", async () => {
		const a = saved(initial);
		const b = saved(zai);
		const beforeB = snapshot(b);
		const live = await runner({ resume: a.header.id, model: qualified(other), modelExplicit: true });
		expect(reopen(a).getModel()).toEqual(other);
		expect(
			snapshot(a)
				.bytes.split("\n")
				.filter((line) => line.includes('"type":"session_model"')),
		).toHaveLength(1);
		const afterA = snapshot(a);
		live.resumeSession(b.header.id);
		expect(live.providerName).toBe("zai");
		expect(live.model).toBe(zai.modelId);
		live.resumeSession(a.header.id);
		expect(live.modelReference()).toBe(qualified(other));
		expect(snapshot(a)).toEqual(afterA);
		expect(snapshot(b)).toEqual(beforeB);
		expect((await runner({ resume: a.header.id })).modelReference()).toBe(qualified(other));
	});

	it("same explicit startup override and /model leave bytes and mtime unchanged", async () => {
		const store = saved(other);
		fs.utimesSync(store.filePath, new Date(1000), new Date(1000));
		const before = snapshot(store);
		const live = await runner({ resume: store.header.id, model: qualified(other), modelExplicit: true });
		live.setModel(qualified(other));
		expect(snapshot(store)).toEqual(before);
		expect(reopen(store).hasModelSelection).toBe(false);
	});

	it("legacy files use the original startup model, not the previous live session model", async () => {
		const legacy = saved();
		const modern = saved(other);
		const before = snapshot(legacy);
		const live = await runner({ resume: modern.header.id });
		live.setModel(qualified(zai));
		live.resumeSession(legacy.header.id);
		expect(live.providerName).toBe(initial.provider);
		expect(live.model).toBe(initial.modelId);
		expect(snapshot(legacy)).toEqual(before);
		expect(reopen(legacy).getModel()).toBeUndefined();
		await live.runTurn({ userMessage: "capture legacy seed" });
		expect(reopen(legacy).getModel()).toEqual(initial);
	});

	it("/new preserves the live model while remaining lazy until a message", async () => {
		const live = await runner();
		live.setModel(qualified(other));
		const previous = live.session!;
		const before = snapshot(previous);
		live.newSession();
		const fresh = live.session!;
		expect(fresh.header.id).not.toBe(previous.header.id);
		expect(live.modelReference()).toBe(qualified(other));
		expect(live.history).toEqual([]);
		expect(fs.existsSync(fresh.filePath)).toBe(false);
		live.setModel(qualified(other));
		expect(fs.existsSync(fresh.filePath)).toBe(false);
		expect(live.listSessions().map((item) => item.id)).toEqual([previous.header.id]);
		await live.runTurn({ userMessage: "new conversation" });
		expect(reopen(fresh).getModel()).toEqual(other);
		expect(snapshot(previous)).toEqual(before);
	});

	it("preserves anthropic/glm-5.3 versus zai/glm-5.3 across cross-provider restores", async () => {
		const compat = { provider: "anthropic", modelId: "glm-5.3" };
		const a = saved(compat);
		const b = saved(zai);
		const live = await runner({ resume: a.header.id, model: qualified(other) });
		expect(live.providerName).toBe("anthropic");
		await live.runTurn({ userMessage: "compat" });
		live.resumeSession(b.header.id);
		await live.runTurn({ userMessage: "native" });
		live.resumeSession(a.header.id);
		await live.runTurn({ userMessage: "compat again" });
		expect(calls.map(({ family, request }) => [family, request.model])).toEqual([
			["anthropic", "glm-5.3"],
			["zai", "glm-5.3"],
			["anthropic", "glm-5.3"],
		]);
		expect(reopen(a).getModel()).toEqual(compat);
		expect(reopen(b).getModel()).toEqual(zai);
	});

	it("/fork and /tree change history but retain the session-wide current model", async () => {
		const live = await runner();
		await live.runTurn({ userMessage: "old model turn" });
		const oldLeaf = live.session!.getLeafId()!;
		live.setModel(qualified(other));
		await live.runTurn({ userMessage: "new model turn" });
		const point = live.forkPoints()[0]!;
		await live.forkSessionAt(point.id);
		expect(live.history).toEqual([]);
		expect(live.modelReference()).toBe(qualified(other));
		await live.navigateTree(oldLeaf, { summarize: false });
		expect(live.history).toHaveLength(2);
		expect(live.modelReference()).toBe(qualified(other));
		expect(reopen(live.session!).getModel()).toEqual(other);
		expect(calls).toHaveLength(2);
	});

	it.each([false, true])(
		"restores explicit thinking after a knobless startup model (deferred=%s)",
		async (deferInit) => {
			const store = saved(initial);
			store.appendThinkingLevelChange("low");
			const live = await runner({
				resume: store.header.id,
				model: "openai/gpt-4o",
				thinking: "high",
				deferInit,
			});
			await live.warmup();
			expect(live.supportsThinking()).toBe(true);
			expect(live.thinkingLevel).toBe("high");
			expect(live.model).toBe(initial.modelId);
			expect(calls).toEqual([]);
		},
	);

	it("missing credentials never substitute a different model or make validation requests", async () => {
		const store = saved(zai);
		const before = snapshot(store);
		const live = await runner({ resume: store.header.id });
		expect(live.modelReference()).toBe(qualified(zai));
		expect(live.output()).toContain("/login zai");
		expect(calls).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
		expect(snapshot(store)).toEqual(before);
	});

	it("setModel persistence failure leaves provider, model, thinking, history and session unchanged", async () => {
		const store = saved(initial);
		const live = await runner({ resume: store.header.id, thinking: "high" });
		const session = live.session!;
		const history = live.history;
		const messages = [...history];
		const before = snapshot(session);
		const window = live.contextWindow;
		const leaf = session.getLeafId();
		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		expect(() => live.setModel("openai/gpt-4o")).toThrow("disk full");
		expect(live.session).toBe(session);
		expect(session.getModel()).toEqual(initial);
		expect(session.getLeafId()).toBe(leaf);
		expect(live.history).toBe(history);
		expect(live.history).toEqual(messages);
		expect(live.providerName).toBe(initial.provider);
		expect(live.model).toBe(initial.modelId);
		expect(live.contextWindow).toBe(window);
		expect(live.thinkingLevel).toBe("high");
		expect(snapshot(session)).toEqual(before);
		await live.runTurn({ userMessage: "still original provider" });
		expect(calls.at(-1)?.family).toBe(initial.provider);
		expect(calls.at(-1)?.request.model).toBe(initial.modelId);
	});
});
