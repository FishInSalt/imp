import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/repl/render.js";
import { runRepl } from "../src/repl/repl.js";
import { createRunner, type Runner } from "../src/runner.js";
import {
	assistant,
	type FakeConsole,
	gate,
	makeConsole,
	type ScriptStep,
	scriptedProvider,
	streamingProvider,
	ticks,
	waitUntil,
} from "./helpers/fakes.js";

const reply = (text: string): AssistantMessage => assistant([{ type: "text", text }]);

interface ReplEnv {
	fake: FakeConsole;
	runner: Runner;
	repl: Promise<number>;
	requests: LLMRequest[];
	exitCodes: number[];
	send(text: string): void;
	output(): string;
}

interface StartArgs {
	scripts?: ScriptStep[];
	tools?: Tool[];
	tty?: boolean;
	model?: string;
	noSession?: boolean;
	provider?: LLMProvider;
	deferInit?: boolean;
}

async function startRepl(args: StartArgs): Promise<ReplEnv> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-repl-"));
	const cwd = path.join(baseDir, "proj");
	const requests: LLMRequest[] = [];
	const provider: LLMProvider =
		args.provider ?? scriptedProvider(args.scripts ?? [reply("ok")], requests);
	const fake = makeConsole({ tty: args.tty ?? true });
	const renderer = new Renderer({
		write: (text) => fake.stdout.write(text),
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
	});
	const runner = await createRunner({
		cwd,
		argv: [],
		model: args.model ?? "test-model",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: args.noSession ?? false,
		sessionBaseDir: baseDir,
		renderer,
		provider,
		tools: args.tools,
		deferInit: args.deferInit ?? false,
	});
	const exitCodes: number[] = [];
	const repl = runRepl({
		runner,
		input: fake.stdin,
		output: fake.stdout,
		interactive: args.tty ?? true,
		exit: (code) => {
			exitCodes.push(code);
			throw new Error(`force-exit:${code}`);
		},
	});
	await ticks(2);
	return { fake, runner, repl, requests, exitCodes, send: (t) => fake.send(t), output: () => fake.output() };
}

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("runRepl", () => {
	it("happy path: hi → streamed text → stats → prompt redrawn; provider saw the user message", async () => {
		const env = await startRepl({ scripts: [reply("Hello!")] });
		await waitUntil(() => env.output().includes("imp 0.1.0 — /help for commands"));
		env.send("hi\n");
		await waitUntil(() => env.output().includes("— test-model · 1 turns · in 10 / out 5 tokens"));
		expect(env.output()).toContain("Hello!");
		expect(env.output()).toContain("▪ session ");
		// prompt redrawn after the run settled (after the stats line)
		expect(env.output().lastIndexOf("> ")).toBeGreaterThan(env.output().indexOf("— test-model · 1 turns"));
		expect(env.requests[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(env.requests[0]?.system).not.toBe("");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("multi-turn: second request contains the first exchange; same history array", async () => {
		const env = await startRepl({ scripts: [reply("one")] });
		const historyRef = env.runner.history;
		env.send("first\n");
		await waitUntil(() => env.requests.length >= 1 && env.output().includes("1 turns"));
		env.send("second\n");
		await waitUntil(() => env.requests.length >= 2);
		expect(env.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(env.requests[1]?.messages[0]).toEqual({ role: "user", content: "first" });
		expect(env.runner.history).toBe(historyRef);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("steering: a line typed during a tool run is queued, then injected before the next LLM call", async () => {
		const g = gate();
		let startedFlag = false;
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					startedFlag = true;
					await g.promise;
					return { output: "slow tool done" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "x" } }],
					"tool_use",
				),
				reply("acknowledged"),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => startedFlag);
		env.send("wait — use a different approach\n");
		await waitUntil(() => env.output().includes("▪ queued: wait — use a different approach"));
		g.resolve();
		await waitUntil(() => env.requests.length >= 2);
		await waitUntil(() => env.output().includes("acknowledged"));
		expect(env.output()).toContain("▪ steering: wait — use a different approach");
		expect(env.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("leftover queue auto-continues: ▪ continuing with queued starts the next turn", async () => {
		const g = gate();
		const g2 = gate();
		let toolStarted = false;
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					toolStarted = true;
					await g.promise;
					return { output: "done" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "x" } }],
					"tool_use",
				),
				() =>
					new Promise<AssistantMessage>((resolve) => {
						void g2.promise.then(() => resolve(reply("final answer")));
					}),
				reply("after-queued reply"),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => toolStarted);
		g.resolve(); // tool finishes → steering poll (queue empty) → final stream starts (gated)
		await waitUntil(() => env.requests.length >= 2);
		env.send("next line\n"); // queued AFTER the last steering poll — leftover
		await waitUntil(() => env.output().includes("▪ queued: next line"));
		g2.resolve(); // final reply completes the run; leftover flushes as a new turn
		await waitUntil(() => env.requests.length >= 3);
		expect(env.output()).toContain("▪ continuing with queued: next line");
		const last = env.requests[2]?.messages.at(-1);
		expect(last).toEqual({ role: "user", content: "next line" });
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("abort mid-tool-batch: (aborted), prompt returns, session has no orphaned tool_use", async () => {
		const g = gate();
		let startedFlag = false;
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					startedFlag = true;
					await g.promise;
					return { output: "ran" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[
						{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "a" } },
						{ type: "toolCall", id: "t2", name: "slow_tool", arguments: { message: "b" } },
					],
					"tool_use",
				),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => startedFlag);
		env.fake.interrupt(); // first Ctrl+C: abort
		g.resolve(); // first tool returns; t2 never runs (signal already aborted)
		await waitUntil(() => env.output().includes("(aborted)"));
		expect(env.output()).toContain("(interrupt — press Ctrl+C again to force quit)");
		// every tool_use id in the persisted file has a tool_result pairing it
		const lines = readFileSync(env.runner.session?.filePath as string, "utf8")
			.trim()
			.split("\n");
		const used = new Set<string>();
		const answered = new Set<string>();
		for (const line of lines) {
			const entry = JSON.parse(line) as { message?: { role: string } } & {
				message?: { blocks?: { type: string; id?: string }[]; results?: { toolCallId: string }[] };
			};
			if (entry.message?.role === "assistant") {
				for (const block of entry.message.blocks ?? []) {
					if (block.type === "toolCall" && block.id) used.add(block.id);
				}
			}
			if (entry.message?.role === "toolResult") {
				for (const result of entry.message.results ?? []) answered.add(result.toolCallId);
			}
		}
		expect(used).toEqual(new Set(["t1", "t2"]));
		expect(answered).toEqual(used);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("regression M1: Ctrl+C during TEXT streaming aborts cleanly — (aborted), no error, REPL reusable", async () => {
		const g = gate();
		const env = await startRepl({
			provider: streamingProvider(g, "streaming a long answer word by word"),
		});
		env.send("hi\n");
		// first deltas are already on screen — we are mid-stream with no tool in flight
		await waitUntil(() => env.output().includes("streaming"));
		env.fake.interrupt();
		g.resolve(); // held stream learns of the abort and ends without message_end
		await waitUntil(() => env.output().includes("(aborted)"));
		expect(env.output()).not.toContain("imp:");
		expect(env.output()).not.toContain("This operation was aborted"); // no DOMException leak
		// prompt restored — a command still works after the abort
		env.send("/help\n");
		await waitUntil(() => env.output().includes("/exit"));
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("regression m2: double Ctrl+C (force exit) closes dangling tool_use in the session file", async () => {
		const g = gate();
		let startedFlag = false;
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					startedFlag = true;
					await g.promise;
					return { output: "never" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "a" } }],
					"tool_use",
				),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => startedFlag);
		env.fake.send("\x03\x03");
		expect(await env.repl).toBe(130);
		const file = env.runner.session?.filePath;
		expect(file).toBeDefined();
		const lines = readFileSync(file as string, "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l));
		const roles = lines.filter((e) => e.type === "message").map((e) => e.message.role);
		expect(roles).toEqual(["user", "assistant", "toolResult"]);
		const closer = lines[lines.length - 1];
		expect(closer.message.results[0].content).toBe("(force quit before this tool ran)");
		expect(closer.message.results[0].isError).toBe(true);
		g.resolve();
		await ticks();
	});

	it("regression m4: steering user message is persisted to the session exactly once", async () => {
		const g = gate();
		let startedFlag = false;
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					startedFlag = true;
					await g.promise;
					return { output: "done" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "x" } }],
					"tool_use",
				),
				reply("acknowledged"),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => startedFlag);
		env.send("wait — use a different approach\n");
		await waitUntil(() => env.output().includes("▪ queued:"));
		g.resolve();
		await waitUntil(() => env.output().includes("acknowledged"));
		const file = env.runner.session?.filePath as string;
		const entries = readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l));
		const steering = entries.filter(
				(e) => e.type === "message" && e.message.role === "user" && e.message.content === "wait — use a different approach",
		);
		expect(steering.length).toBe(1);
		expect(steering[0].parentId).not.toBeNull();
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("regression P1: scripted mode with a bad -r id reports a clean error, no unhandled rejection", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-repl-"));
		const fake = makeConsole({ tty: false });
		const renderer = new Renderer({
			write: (text) => fake.stdout.write(text),
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
		});
		const runner = await createRunner({
			cwd: path.join(baseDir, "proj"),
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			resume: "deadbeef", // no such session anywhere under baseDir
			sessionBaseDir: baseDir,
			renderer,
			provider: scriptedProvider([reply("unreachable")]),
			deferInit: true, // piped stdin defers warmup to the first line
		});
		const repl = runRepl({
			runner,
			input: fake.stdin,
			output: fake.stdout,
			interactive: false,
			exit: (code) => {
				throw new Error(`force-exit:${code}`);
			},
		});
		await ticks(2);
		fake.send("hi\n"); // triggers warmup -> resolveSession throws
		await waitUntil(() => fake.output().includes("imp:"));
		expect(fake.output()).toMatch(/deadbeef/);
		expect(fake.output()).not.toContain("unreachable"); // the turn never ran
		fake.eof();
		expect(await repl).toBe(0); // resolved cleanly — no unhandled rejection
		runner.close();
	});

	it("regression P1: /compact typed at an idle prompt actually runs (state pre-set must not reject itself)", async () => {
		// Full path through handleLine — unit tests called dispatchCommand
		// directly with a controlled isActive(), which is exactly why this
		// self-rejection slipped through 141 green tests.
		const env = await startRepl({ scripts: [reply("first turn done")] });
		env.send("hi\n");
		await waitUntil(() => env.output().includes("— test-model · 1 turns")); // settled ⇒ idle
		env.send("/compact\n");
		await waitUntil(() => env.output().includes("▪ compacting…"));
		expect(env.output()).not.toContain("waits for the running turn");
		// machine returns to idle afterwards — prompt redrawn after the banner
		await waitUntil(
				() => env.output().lastIndexOf("> ") > env.output().indexOf("▪ compacting…"),
		);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("regression (layer-3): a provider AbortError escaping to settleFailure prints (aborted), not an error", async () => {
		const abortError = () => {
			const err = new Error("This operation was aborted");
			err.name = "AbortError";
			throw err;
		};
		const env = await startRepl({ scripts: [abortError as unknown as ScriptStep] });
		env.send("hi\n");
		await waitUntil(() => env.output().includes("(aborted)"));
		expect(env.output()).not.toContain("imp:");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("regression m1: zero-line piped stdin (deferInit) creates no session and prints no banners", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-repl-"));
		const fake = makeConsole({ tty: false });
		const renderer = new Renderer({
			write: (text) => fake.stdout.write(text),
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
		});
		const runner = await createRunner({
			cwd: path.join(baseDir, "proj"),
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			renderer,
			provider: scriptedProvider([reply("ok")]),
			deferInit: true,
		});
		const repl = runRepl({
			runner,
			input: fake.stdin,
			output: fake.stdout,
			interactive: false,
			exit: (code) => {
				throw new Error(`force-exit:${code}`);
			},
		});
		await ticks(2);
		fake.eof(); // zero lines piped
		expect(await repl).toBe(1); // HELP + exit 1 is cli's job
		expect(runner.session).toBeNull(); // no empty session file was created
		expect(fake.output()).toBe(""); // no banners before HELP
		runner.close();
	});

	it("abort discards the queue with a note; the REPL stays usable", async () => {
		const g = gate();
		let startedFlag = false;
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					startedFlag = true;
					await g.promise;
					return { output: "ran" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "a" } }],
					"tool_use",
				),
				reply("recovered"),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => startedFlag);
		env.send("queued one\n");
		env.send("queued two\n");
		await waitUntil(() => env.output().includes("▪ queued: queued two"));
		env.fake.interrupt();
		g.resolve();
		await waitUntil(() => env.output().includes("▪ discarded 2 queued line(s)"));
		// REPL is alive again
		env.send("after\n");
		await waitUntil(() => env.requests.length >= 2);
		expect(env.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: "after" });
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("Ctrl+C during a run twice → force exit 130 (never awaits the hung tool)", async () => {
		const g = gate();
		let startedFlag = false;
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					startedFlag = true;
					await g.promise;
					return { output: "ran" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "a" } }],
					"tool_use",
				),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => startedFlag);
		env.fake.send("\x03\x03");
		expect(await env.repl).toBe(130);
		expect(env.exitCodes).toEqual([130]);
		g.resolve(); // let the aborted run settle into the exited machine
		await ticks();
	});

	it("Ctrl+C at an empty prompt: hint first, then graceful 130 + resume line", async () => {
		const env = await startRepl({ scripts: [reply("ok")] });
		env.fake.interrupt();
		await waitUntil(() => env.output().includes("(press Ctrl+C again to quit — /exit or Ctrl+D also work)"));
		env.fake.interrupt();
		expect(await env.repl).toBe(130);
		const id8 = env.runner.session?.header.id.slice(0, 8);
		expect(env.output()).toContain(`▪ session ${id8} saved — resume with: imp -r ${id8}`);
	});

	it("Ctrl+C with a typed buffer clears it and keeps the REPL alive", async () => {
		const env = await startRepl({ scripts: [reply("ok")] });
		env.send("partial"); // typed, not submitted
		await ticks(2);
		env.fake.interrupt(); // clears the buffer — no hint line expected
		await ticks(2);
		expect(env.output()).not.toContain("press Ctrl+C again to quit");
		env.send("real line\n");
		await waitUntil(() => env.requests.length >= 1);
		expect(env.requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "real line" });
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("Ctrl+D → graceful 0 + resume line; --no-session → ▪ bye", async () => {
		const env = await startRepl({ scripts: [reply("ok")] });
		env.send("hi\n");
		await waitUntil(() => env.output().includes("1 turns"));
		env.fake.send("\x04");
		expect(await env.repl).toBe(0);
		const id8 = env.runner.session?.header.id.slice(0, 8);
		expect(env.output()).toContain(`▪ session ${id8} saved — resume with: imp -r ${id8}`);

		const stateless = await startRepl({ scripts: [reply("ok")], noSession: true });
		stateless.fake.send("\x04");
		expect(await stateless.repl).toBe(0);
		expect(stateless.output()).toContain("▪ bye");
		expect(stateless.output()).not.toContain("saved — resume with");
	});

	it("/exit during a run: aborts, settles, exits 0", async () => {
		const g = gate();
		let startedFlag = false;
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					startedFlag = true;
					await g.promise;
					return { output: "ran" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "a" } }],
					"tool_use",
				),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => startedFlag);
		env.send("/exit\n");
		g.resolve();
		expect(await env.repl).toBe(0);
		expect(env.output()).toContain("(aborted)"); // the run was aborted before the exit
	});

	it("provider throw mid-run: imp: <msg>, the REPL survives and keeps working", async () => {
		const env = await startRepl({
			scripts: [
				reply("fine"),
				() => {
					throw new Error("boom");
				},
				reply("fine again"),
			],
		});
		env.send("go\n");
		await waitUntil(() => env.requests.length >= 1);
		env.send("again\n");
		await waitUntil(() => env.output().includes("imp: boom"));
		env.send("third\n");
		await waitUntil(() => env.requests.length >= 3);
		expect(env.output()).toContain("fine again");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("scripted pipe: one turn then EOF exits 0; no prompts, no +, no ANSI", async () => {
		const env = await startRepl({ scripts: [reply("piped reply")], tty: false });
		env.send("hi\n");
		await waitUntil(() => env.output().includes("piped reply"));
		env.fake.eof();
		expect(await env.repl).toBe(0);
		const out = env.output();
		expect(out).not.toContain("> ");
		expect(out).not.toContain("+ ");
		expect(out).not.toContain("\x1b");
		expect(out).toContain("— test-model · 1 turns");
	});

	it("zero-line piped stdin → resolves 1 (cli prints HELP for that code)", async () => {
		const env = await startRepl({ scripts: [reply("never")], tty: false });
		env.fake.eof();
		expect(await env.repl).toBe(1);
		expect(env.output()).toBe("");
	});

	it("empty/whitespace lines are ignored: no provider call, prompt refreshed", async () => {
		const env = await startRepl({ scripts: [reply("ok")] });
		env.send("\n");
		env.send("   \n");
		await ticks(4);
		expect(env.requests).toHaveLength(0);
		env.send("hi\n");
		await waitUntil(() => env.requests.length >= 1);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("auto-compaction across REPL turns (tiny keep window): banner appears, conversation continues", async () => {
		vi.stubEnv("IMP_KEEP_RECENT", "1");
		vi.resetModules();
		const { createRunner: freshCreateRunner } = await import("../src/runner.js");
		const { runRepl: freshRunRepl } = await import("../src/repl/repl.js");

		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-repl-c-"));
		const cwd = path.join(baseDir, "proj");
		const requests: LLMRequest[] = [];
		const bigReply = assistant([{ type: "text", text: "first reply" }], "end_turn", {
			inputTokens: 200000,
			outputTokens: 100,
		});
		const provider = scriptedProvider([bigReply, reply("SUMMARY"), reply("second reply")], requests);
		const fake = makeConsole({ tty: false });
		const renderer = new Renderer({
			write: (text) => fake.stdout.write(text),
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
		});
		const runner = await freshCreateRunner({
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			renderer,
			provider,
		});
		const repl = freshRunRepl({ runner, input: fake.stdin, output: fake.stdout, interactive: false });

		fake.send("go\n");
		await waitUntil(() => fake.output().includes("first reply"));
		await waitUntil(() => fake.output().includes("1 turns"));
		fake.send("again\n");
		await waitUntil(() => fake.output().includes("second reply"));
		expect(fake.output()).toContain("▪ context ~200.1k tokens — compacting…");
		expect(fake.output()).toMatch(/▪ compacted: ~200\.1k → ~\d+ tokens \(\d+ msgs kept verbatim\)/);
		// the summarizer call got the transcript; the post-compact request starts with the summary
		expect(requests[1]?.messages[0]?.content).toContain("## Goal");
		expect(requests[2]?.messages[0]?.role).toBe("user"); // summary message
		fake.eof();
		expect(await repl).toBe(0);
	});
});
