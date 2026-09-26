import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "../src/core/messages.js";
import { createSession, SessionNotFoundError } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import type { RunnerOptions } from "../src/runner.js";
import { createRunner, type Runner, resolveRunMode } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

const userMsg = (content: string): AgentMessage => ({ role: "user", content });
const assistantText = (text: string, inputTokens = 100): AgentMessage => ({
	role: "assistant",
	blocks: [{ type: "text", text }],
	usage: { inputTokens, outputTokens: 20 },
	stopReason: "end_turn",
});

async function setup(): Promise<{ baseDir: string; cwd: string }> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-runner-"));
	const cwd = path.join(baseDir, "proj");
	return { baseDir, cwd };
}

interface MakeArgs {
	provider: LLMProvider;
	cwd: string;
	baseDir: string;
	model?: string;
	resume?: string;
	continueRecent?: boolean;
	noSession?: boolean;
}

async function makeRunner(args: MakeArgs): Promise<Runner> {
	const { renderer, output } = makeRenderer();
	const options: RunnerOptions = {
		cwd: args.cwd,
		argv: [],
		model: args.model ?? "test-model",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: args.noSession ?? false,
		resume: args.resume,
		continueRecent: args.continueRecent,
		sessionBaseDir: args.baseDir,
		renderer,
		provider: args.provider,
	};
	const runner = await createRunner(options);
	return Object.assign(runner, { capturedOutput: output });
}

/** Runner plus the collected renderer output of the runner's own banners/stats. */
type RunnerWithOutput = Runner & { capturedOutput(): string };

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0"); // keep createRunLogger silent and hermetic
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("resolveRunMode", () => {
	it("-p/positional prompt → print; no prompt + TTY → interactive REPL; no prompt + pipe → scripted REPL", () => {
		expect(resolveRunMode({ promptDefined: true, stdinIsTty: true })).toBe("print");
		expect(resolveRunMode({ promptDefined: true, stdinIsTty: false })).toBe("print");
		expect(resolveRunMode({ promptDefined: false, stdinIsTty: true })).toBe("repl");
		// piped stdin is a feature (scripted REPL), not a demotion to print
		expect(resolveRunMode({ promptDefined: false, stdinIsTty: false })).toBe("repl");
	});
});

describe("subagent event relay (M10 B)", () => {
	it("child tool events reach runTurn.onEvent with agent info; top-level events carry none", async () => {
		const { baseDir, cwd } = await setup();
		await mkdir(path.join(baseDir, "agents-home", ".imp", "agents"), { recursive: true });
		await writeFile(
			path.join(baseDir, "agents-home", ".imp", "agents", "scout.md"),
			"---\nname: scout\ndescription: test scout\n---\nYou are a test scout.\n",
			"utf-8",
		);
		const seen: string[] = [];
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer: makeRenderer().renderer,
			agentsHomeDir: path.join(baseDir, "agents-home"),
			provider: scriptedProvider([
				// parent: one task call
				assistant(
					[{ type: "toolCall", id: "t1", name: "task", arguments: { prompt: "explore", agent: "scout" } }],
					"tool_use",
				),
				// child: one bash call, then closing text
				assistant(
					[{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo relay-probe" } }],
					"tool_use",
				),
				assistant([{ type: "text", text: "child done" }]),
				// parent: closing text
				assistant([{ type: "text", text: "parent done" }]),
			]),
			deferInit: false,
		});
		const result = await runner.runTurn({
			userMessage: "go",
			onEvent: (event, info) => {
				if (event.type === "tool_start") {
					seen.push(`start:${event.name}:${event.toolCallId}:${info?.agent ?? "-"}`);
				} else if (event.type === "tool_end") {
					seen.push(`end:${event.result.toolName}:${info?.agent ?? "-"}`);
				}
			},
		});
		expect(result.stopReason).toBe("completed");
		expect(seen).toContain("start:task:t1:-"); // top-level: no info
		expect(seen).toContain("start:bash:c1:scout"); // child: relayed with the agent name
		expect(seen).toContain("end:bash:scout"); // child end is tagged too
		expect(seen).toContain("end:task:-"); // top-level end: no info
		// top-level events must never carry a child tag (renderer feed filter)
		expect(seen.filter((entry) => entry.endsWith(":-"))).toHaveLength(2);
	});
});

describe("createRunner", () => {
	it("resumes a pre-seeded session with the exact banner and seeded history", async () => {
		const { baseDir, cwd } = await setup();
		const store = createSession(cwd, baseDir);
		store.appendMessage(userMsg("hello"));
		store.appendMessage(assistantText("hi there", 100));

		const requests: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests);
		const runner = (await makeRunner({
			provider,
			cwd,
			baseDir,
			resume: store.header.id,
		})) as RunnerWithOutput;

		const id8 = store.header.id.slice(0, 8);
		expect(runner.capturedOutput()).toBe(`▪ resumed ${id8} · test-model · 2 msgs · ~120 tokens\n`);
		expect(runner.history.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(runner.session?.header.id).toBe(store.header.id);
	});

	it("resumes a legacy header-only file as persisted with empty history", async () => {
		const { baseDir, cwd } = await setup();
		const store = createSession(cwd, baseDir);
		// Older versions eagerly wrote the header even without any entries.
		await writeFile(store.filePath, `${JSON.stringify(store.header)}\n`);
		const runner = (await makeRunner({
			provider: scriptedProvider([]),
			cwd,
			baseDir,
			resume: store.header.id,
		})) as RunnerWithOutput;
		expect(runner.session?.header.id).toBe(store.header.id);
		expect(runner.session?.isPersisted).toBe(true);
		expect(runner.history).toEqual([]);
		expect(runner.capturedOutput()).toContain(
			`▪ resumed ${store.header.id.slice(0, 8)} · test-model · 0 msgs`,
		);
	});

	it("-c with no prior session prints the starting-fresh banner", async () => {
		const { baseDir, cwd } = await setup();
		const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])]);
		const runner = (await makeRunner({ provider, cwd, baseDir, continueRecent: true })) as RunnerWithOutput;
		expect(runner.capturedOutput()).toBe("▪ no previous session, starting fresh\n");
		expect(runner.session).not.toBeNull();
	});

	it("getTool looks up the live tool set by name — injected fakes included (M10 ! passthrough seam)", async () => {
		const { baseDir, cwd } = await setup();
		const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])]);
		const fake = {
			name: "bash",
			description: "fake",
			parameters: { properties: { command: { type: "string" } }, required: ["command"] },
			execute: async () => ({ output: "fake bash" }),
		};
		const { renderer } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer,
			provider,
			tools: [fake],
		});
		expect(runner.getTool("bash")).toBe(fake); // the exact instance the loop runs
		expect(runner.getTool("nope")).toBeUndefined();
	});

	it("rethrows SessionNotFoundError for the caller to report", async () => {
		const { baseDir, cwd } = await setup();
		const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])]);
		await expect(makeRunner({ provider, cwd, baseDir, resume: "zzzzzzzz" })).rejects.toBeInstanceOf(
			SessionNotFoundError,
		);
	});
});

describe("Runner.runTurn", () => {
	it("persists every message to the session JSONL; history identity is stable across turns", async () => {
		const { baseDir, cwd } = await setup();
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "one" }])], requests);
		const runner = await makeRunner({ provider, cwd, baseDir });

		const historyRef = runner.history;
		await runner.runTurn({ userMessage: "first" });
		await runner.runTurn({ userMessage: "second" });

		expect(runner.history).toBe(historyRef);
		expect(runner.history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		const filePath = runner.session?.filePath;
		expect(filePath).toBeDefined();
		const lines = readFileSync(filePath as string, "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(5); // header + 4 messages
		const roles = lines.slice(1).map((l) => (JSON.parse(l) as { message: AgentMessage }).message.role);
		expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
		// second request contains the first exchange
		expect(requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
	});

	it("default builtins run under RunnerOptions.cwd — bash pwd and relative reads resolve there, never process.cwd()", async () => {
		const { baseDir, cwd } = await setup();
		await mkdir(cwd, { recursive: true });
		await writeFile(path.join(cwd, "marker.txt"), "hermetic marker\n", "utf8");
		const provider = scriptedProvider([
			assistant([{ type: "toolCall", id: "p1", name: "bash", arguments: { command: "pwd" } }], "tool_use"),
			assistant(
				[{ type: "toolCall", id: "p2", name: "read", arguments: { path: "marker.txt" } }],
				"tool_use",
			),
			assistant([{ type: "text", text: "done" }]),
		]);
		const runner = await makeRunner({ provider, cwd, baseDir });

		await runner.runTurn({ userMessage: "where are we?" });

		const results = runner.history
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.flatMap((m) => m.results);
		const bash = results.find((r) => r.toolCallId === "p1");
		const read = results.find((r) => r.toolCallId === "p2");
		// bash spawned in the runner's cwd (the temp project), not the repo root
		expect(bash?.isError).toBe(false);
		expect(bash?.content).toContain(cwd);
		expect(bash?.content).not.toContain(process.cwd());
		// the relative read resolved against that same cwd
		expect(read?.isError).toBe(false);
		expect(read?.content).toContain("hermetic marker");
	});

	it("runner.model = x → next provider request carries x; stats line shows the run-time model", async () => {
		const { baseDir, cwd } = await setup();
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests);
		const runner = await makeRunner({ provider, cwd, baseDir, model: "model-a" });

		await runner.runTurn({ userMessage: "hi" });
		runner.model = "model-b";
		const result = await runner.runTurn({ userMessage: "again" });

		expect(requests.map((r) => r.model)).toEqual(["model-a", "model-b"]);
		// stats line shows the model captured at run entry, not the current one
		runner.printRunStats(result);
		expect((runner as RunnerWithOutput).capturedOutput()).toContain(
			"— model-b · 1 turns · in 10 / out 5 tokens\n",
		);
	});

	it("printRunStats/printSessionStats exact strings (cache↓ only when truthy)", async () => {
		const { baseDir, cwd } = await setup();
		const withCache: AssistantMessage = assistant([{ type: "text", text: "rich" }], "end_turn", {
			inputTokens: 1234,
			outputTokens: 56,
			cacheReadTokens: 789,
		});
		const provider = scriptedProvider([withCache]);
		const runner = await makeRunner({ provider, cwd, baseDir });

		const result = await runner.runTurn({ userMessage: "hi" });
		runner.printRunStats(result);
		runner.printSessionStats();
		const id8 = runner.session?.header.id.slice(0, 8);
		const expected =
			`— test-model · 1 turns · in 1.2k / out 56 tokens · cache↓789\n` +
			`— session ${id8} · 2 msgs total · in 1.2k / out 56 cumulative\n`;
		expect((runner as RunnerWithOutput).capturedOutput().endsWith(expected)).toBe(true);

		// and without cache tokens: no cache note at all
		const { baseDir: b2, cwd: c2 } = await setup();
		const p2 = scriptedProvider([
			assistant([{ type: "text", text: "ok" }], "end_turn", { inputTokens: 10, outputTokens: 5 }),
		]);
		const runner2 = (await makeRunner({ provider: p2, cwd: c2, baseDir: b2 })) as RunnerWithOutput;
		const result2 = await runner2.runTurn({ userMessage: "hi" });
		runner2.printRunStats(result2);
		expect(runner2.capturedOutput()).toContain("— test-model · 1 turns · in 10 / out 5 tokens\n");
		expect(runner2.capturedOutput()).not.toContain("cache↓");
	});

	it("auto-compaction fires inside runTurn (tiny keep window): banners + history splice", async () => {
		vi.stubEnv("IMP_KEEP_RECENT", "1"); // retained tail as small as possible
		vi.resetModules();
		const { createRunner: freshCreateRunner } = await import("../src/runner.js");
		const { baseDir, cwd } = await setup();

		// seed a session whose last assistant usage reports a huge context
		const store = createSession(cwd, baseDir);
		store.appendMessage(userMsg("seed question"));
		store.appendMessage(assistantText("seed answer", 200000));

		const requests: LLMRequest[] = [];
		const summaryMsg = assistant([{ type: "text", text: "SUMMARY" }]);
		const replyMsg = assistant([{ type: "text", text: "final reply" }]);
		const provider = scriptedProvider([summaryMsg, replyMsg], requests);

		const { renderer, output } = makeRenderer();
		const runner = await freshCreateRunner({
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			resume: store.header.id,
			sessionBaseDir: baseDir,
			renderer,
			provider,
		});

		await runner.runTurn({ userMessage: "continue" });
		expect(output()).toContain("▪ context ~200k tokens — compacting…\n");
		expect(output()).toMatch(/▪ compacted: ~200k → ~\d+ tokens \(1 msgs kept verbatim\)\n/);
		// history = [summary message, retained tail ("continue"), fresh reply]
		const first = runner.history[0];
		expect(first?.role).toBe("user");
		expect(first !== undefined && first.role === "user" ? first.content : "").toContain("SUMMARY");
		expect(runner.history.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
	});

	it("--no-session: no banners, no persistence, compactNow → no-session", async () => {
		const { baseDir, cwd } = await setup();
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests);
		const runner = (await makeRunner({ provider, cwd, baseDir, noSession: true })) as RunnerWithOutput;

		expect(runner.session).toBeNull();
		await runner.runTurn({ userMessage: "hi" });
		expect(runner.history).toHaveLength(2);
		expect(runner.capturedOutput()).toBe(""); // no banners, no stats from banners
		await expect(runner.compactNow()).resolves.toBe("no-session");
		runner.printSessionStats(); // no session — prints nothing
		expect(runner.capturedOutput()).toBe("");
	});
});

describe("Runner.newSession", () => {
	it("recovers from first-open failure without retaining an unsaved prompt in history", async () => {
		const { baseDir, cwd } = await setup();
		const requests: LLMRequest[] = [];
		const runner = await makeRunner({
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests),
			cwd,
			baseDir,
		});
		const store = runner.session;
		if (!store) throw new Error("expected session");
		const dir = path.dirname(store.filePath);
		await rename(dir, `${dir}-moved`);
		await expect(runner.runTurn({ userMessage: "unsaved prompt" })).rejects.toThrow(/ENOENT/);
		expect(runner.history).toEqual([]);
		expect(store.isPersisted).toBe(false);
		expect(store.getEntries()).toEqual([]);
		expect(requests).toHaveLength(0);

		await mkdir(dir);
		await runner.runTurn({ userMessage: "retry prompt" });
		expect(store.isPersisted).toBe(true);
		expect(runner.history).toHaveLength(2);
		expect(runner.history[0]).toEqual(userMsg("retry prompt"));
		expect(SessionStore.open(store.filePath).buildContext().messages).toEqual(runner.history);
		expect(requests).toHaveLength(1);
	});

	it("replacing a pristine store creates no files and does not claim the previous session was saved", async () => {
		const { baseDir, cwd } = await setup();
		const runner = (await makeRunner({
			provider: scriptedProvider([]),
			cwd,
			baseDir,
		})) as RunnerWithOutput;
		const previous = runner.session;
		if (!previous) throw new Error("expected session");
		runner.newSession();
		expect(runner.session?.header.id).not.toBe(previous.header.id);
		expect(previous.isPersisted).toBe(false);
		expect(existsSync(previous.filePath)).toBe(false);
		expect(runner.session?.isPersisted).toBe(false);
		expect(existsSync(runner.session?.filePath as string)).toBe(false);
		expect(runner.capturedOutput()).toContain("▪ new session");
		expect(runner.capturedOutput()).not.toContain("saved");
		expect(runner.capturedOutput()).not.toContain("imp -r");
	});

	it("swaps to a fresh store, empties history, keeps the old file on disk, prints the banner", async () => {
		const { baseDir, cwd } = await setup();
		const provider = scriptedProvider([assistant([{ type: "text", text: "ok" }])]);
		const runner = (await makeRunner({ provider, cwd, baseDir })) as RunnerWithOutput;
		await runner.runTurn({ userMessage: "hi" });
		const oldPath = runner.session?.filePath;
		const oldId8 = runner.session?.header.id.slice(0, 8);

		runner.newSession();

		const newId8 = runner.session?.header.id.slice(0, 8);
		expect(newId8).toBeDefined();
		expect(newId8).not.toBe(oldId8);
		expect(runner.capturedOutput()).toContain(
			`▪ new session ${newId8} — previous ${oldId8} saved (imp -r ${oldId8})\n`,
		);
		expect(runner.history).toHaveLength(0);
		expect(runner.session?.isPersisted).toBe(false);
		expect(existsSync(runner.session?.filePath as string)).toBe(false);
		// old file untouched on disk (append-only)
		const lines = readFileSync(oldPath as string, "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(3); // header + user + assistant
	});
});

describe("run_start extension event (task-timer design §4.1/§4.6)", () => {
	/** A registry with one "probe" extension recording observer-event order. */
	function probeRegistry(events: string[]): ExtensionRegistry {
		const registry = new ExtensionRegistry();
		registry.beginExtension("probe", "cli");
		registry.subscribe("run_start", () => events.push("run_start"));
		registry.subscribe("message_end", () => events.push("message_end"));
		registry.subscribe("run_end", () => events.push("run_end"));
		registry.commitExtension();
		return registry;
	}

	it("fires exactly once per runTurn, before message_end and run_end", async () => {
		const { baseDir, cwd } = await setup();
		const events: string[] = [];
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer: makeRenderer().renderer,
			provider: scriptedProvider([assistant([{ type: "text", text: "hi" }])]),
			extensions: probeRegistry(events),
		});
		await runner.runTurn({ userMessage: "go" });
		await runner.runTurn({ userMessage: "again" });
		// Both print (cli.ts:885) and REPL (repl.ts:608) reach runTurn — one
		// site covers both shells by construction.
		expect(events).toEqual(["run_start", "message_end", "run_end", "run_start", "message_end", "run_end"]);
	});

	it("overflow recovery: one run_start and one run_end across the compact-and-retry", async () => {
		const { baseDir, cwd } = await setup();
		const events: string[] = [];
		let call = 0;
		const provider: LLMProvider = {
			name: "overflow-then-ok",
			async *stream() {
				call++;
				if (call === 1)
					throw new Error('OpenAI API error 400: {"error":{"code":"context_length_exceeded"}}');
				if (call === 2) {
					// the compaction summary call — internal, emits no extension events
					yield { type: "text_delta", text: "SUMMARY-OF-OLD" };
					yield { type: "message_end", message: assistant([{ type: "text", text: "SUMMARY-OF-OLD" }]) };
					return;
				}
				yield { type: "text_delta", text: "recovered answer" };
				yield { type: "message_end", message: assistant([{ type: "text", text: "recovered answer" }]) };
			},
		};
		const store = createSession(cwd, baseDir);
		const big = "context ".repeat(6000); // compaction needs material beyond keepRecent
		store.appendMessage(userMsg(`old work A ${big}`));
		store.appendMessage(assistantText(`answer A ${big}`));
		store.appendMessage(userMsg(`old work B ${big}`));
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			resume: store.isPersisted ? store.header.id : undefined,
			renderer: makeRenderer().renderer,
			provider,
			extensions: probeRegistry(events),
		});
		const result = await runner.runTurn({ userMessage: "please continue" });
		expect(result.stopReason).toBe("completed");
		// The retry re-enters runTurnInner, never runTurn: exactly one pair.
		expect(events.filter((e) => e === "run_start")).toHaveLength(1);
		expect(events.filter((e) => e === "run_end")).toHaveLength(1);
		expect(events[0]).toBe("run_start");
		expect(events.at(-1)).toBe("run_end");
	});

	it("does not fire for subagent runs — top-level only, symmetric with run_end", async () => {
		const { baseDir, cwd } = await setup();
		await mkdir(path.join(baseDir, "agents-home", ".imp", "agents"), { recursive: true });
		await writeFile(
			path.join(baseDir, "agents-home", ".imp", "agents", "scout.md"),
			"---\nname: scout\ndescription: test scout\n---\nYou are a test scout.\n",
			"utf-8",
		);
		const events: string[] = [];
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer: makeRenderer().renderer,
			agentsHomeDir: path.join(baseDir, "agents-home"),
			provider: scriptedProvider([
				assistant(
					[{ type: "toolCall", id: "t1", name: "task", arguments: { prompt: "explore", agent: "scout" } }],
					"tool_use",
				),
				assistant([{ type: "text", text: "child done" }]),
				assistant([{ type: "text", text: "parent done" }]),
			]),
			deferInit: false,
			extensions: probeRegistry(events),
		});
		const result = await runner.runTurn({ userMessage: "go" });
		expect(result.stopReason).toBe("completed");
		expect(events.filter((e) => e === "run_start")).toHaveLength(1);
		expect(events.filter((e) => e === "run_end")).toHaveLength(1);
	});

	it("a provider crash emits run_start but no run_end (documented asymmetry, design §3.3)", async () => {
		const { baseDir, cwd } = await setup();
		const events: string[] = [];
		const provider: LLMProvider = {
			name: "always-fails",
			async *stream() {
				throw new Error("provider exploded");
			},
		};
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer: makeRenderer().renderer,
			provider,
			extensions: probeRegistry(events),
		});
		await expect(runner.runTurn({ userMessage: "go" })).rejects.toThrow("provider exploded");
		expect(events).toEqual(["run_start"]);
	});
});
