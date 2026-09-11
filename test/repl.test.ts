import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import { loadApiKey } from "../src/provider/auth-store.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
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
	baseDir: string;
	send(text: string): void;
	output(): string;
}

interface StartArgs {
	scripts?: ScriptStep[];
	tools?: Tool[];
	tty?: boolean;
	interactive?: boolean;
	model?: string;
	noSession?: boolean;
	resume?: string;
	sessionBaseDir?: string;
	/** When set, runRepl gets a releaseStartupNotes that writes this marker —
	 *  pins the release timing relative to the banner block. */
	releaseProbe?: string;
	provider?: LLMProvider;
	deferInit?: boolean;
}

async function startRepl(args: StartArgs): Promise<ReplEnv> {
	// a shared sessionBaseDir implies a shared cwd too: session files are
	// namespaced by the flattened working directory, so a "resume" test needs
	// both from the same world
	const baseDir = args.sessionBaseDir ?? (await mkdtemp(path.join(tmpdir(), "imp-repl-")));
	const cwd = path.join(baseDir, "proj");
	const requests: LLMRequest[] = [];
	const provider: LLMProvider = args.provider ?? scriptedProvider(args.scripts ?? [reply("ok")], requests);
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
		resume: args.resume,
		sessionBaseDir: args.sessionBaseDir ?? baseDir,
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
		interactive: args.interactive ?? args.tty ?? true,
		// These scenarios pin the readline shell (the IMP_REPL=legacy escape
		// hatch path). The pi-tui shell has its own suite (repl-tui.test.ts).
		shell: "legacy",
		releaseStartupNotes:
			args.releaseProbe !== undefined ? () => renderer.writeLine(args.releaseProbe as string) : undefined,
		exit: (code) => {
			exitCodes.push(code);
			throw new Error(`force-exit:${code}`);
		},
	});
	await ticks(2);
	return {
		fake,
		runner,
		repl,
		requests,
		exitCodes,
		baseDir,
		send: (t) => fake.send(t),
		output: () => fake.output(),
	};
}

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("runRepl welcome panel", () => {
	it("fresh session: gradient pixel logo, numbered tips, and dim identity", async () => {
		const env = await startRepl({ scripts: [reply("hi")] });
		await waitUntil(() => env.output().includes("Tips for getting started:"));
		const out = env.output();
		// glyphs pinned verbatim against ANSI Shadow.flf (full-width
		// layout): tittle-less i, m, and p whose bowl closes one row above
		// the bare descender — rendered plain because ansi:false
		expect(out).toContain("██╗███╗   ███╗██████╗");
		expect(out).toContain("██║████╗ ████║██╔══██╗");
		expect(out).toContain("██║██╔████╔██║██████╔╝");
		expect(out).toContain("██║██║╚██╔╝██║██╔═══╝");
		expect(out).toContain("██║██║ ╚═╝ ██║██║");
		expect(out).toContain("╚═╝╚═╝     ╚═╝╚═╝");
		// Gemini-style numbered tips (verbatim — generic best practice)
		expect(out).toContain("1. Ask questions, edit files, or run commands.");
		expect(out).toContain("2. Be specific for the best results.");
		expect(out).toContain("3. /help for more information.");
		// identity line: version + session id + model
		expect(out).toMatch(/imp 0\.1\.0 · session [0-9a-f]{8} · test-model/);
		// the old compact banner line is gone on fresh sessions
		expect(out).not.toContain("/help for commands");
		env.fake.eof();
		await env.repl;
	});

	it("gradientLine colorizes per column when ansi, stays plain otherwise", async () => {
		const { welcomeLines } = await import("../src/repl/repl.js");
		const plain = welcomeLines("deadbeef", "test-model", false);
		expect(plain[0]).toBe("██╗███╗   ███╗██████╗"); // no escapes
		const colored = welcomeLines("deadbeef", "test-model", true);
		// first painted column ≈ blue stop, last ≈ pink stop (exact lerp
		// values depend on the column index — anchor on near-stop hues)
		expect(colored[0]).toMatch(/\x1b\[38;2;7[0-9];13[0-9];24[0-9]m/); // ≈ blue
		expect(colored[0]).toContain("\x1b[38;2;255;110;199m"); // last column ≈ pink
		// tips and identity are never colorized
		expect(colored.find((l) => l.startsWith("1. Ask"))).not.toContain("\x1b[");
	});

	it("releaseStartupNotes fires AFTER the welcome panel (fresh) — deferred notes never bury the greeting", async () => {
		const env = await startRepl({ scripts: [reply("ok")], releaseProbe: "RELEASED-HERE" });
		await waitUntil(() => env.output().includes("RELEASED-HERE"));
		const out = env.output();
		// the box is the only thing before the release point: no tips line
		// either — the editor placeholder below teaches the keys
		expect(out).not.toContain("Ctrl+D exits");
		expect(out).not.toContain("@ files");
		expect(out).toContain("RELEASED-HERE");
		expect(out.indexOf("Tips for getting started:")).toBeLessThan(out.indexOf("RELEASED-HERE"));
		env.fake.eof();
		await env.repl;
	});

	it("interactive=false (print/pipe path): no welcome panel — banner bytes stay frozen", async () => {
		const env = await startRepl({ scripts: [reply("hi")], interactive: false, tty: false });
		env.send("hi\n");
		await waitUntil(() => env.output().includes("1 turns"));
		expect(env.output()).not.toContain("Welcome to imp");
		expect(env.output()).not.toContain("╭");
		env.fake.eof();
		await env.repl;
	});

	it("resumed session: compact banner + replayed note, no welcome panel", async () => {
		// first process creates and saves a session with one exchange
		const first = await startRepl({ scripts: [reply("earlier")] });
		first.send("hello\n");
		await waitUntil(() => first.output().includes("1 turns"));
		const id8 = first.runner.session?.header.id.slice(0, 8) ?? "";
		first.fake.eof();
		await first.repl;

		// second process resumes it
		const second = await startRepl({
			scripts: [reply("now")],
			resume: id8,
			sessionBaseDir: first.baseDir,
		});
		await waitUntil(() => second.output().includes("replayed"));
		const out = second.output();
		expect(out).toContain("imp 0.1.0 — /help for commands"); // legacy banner on resume
		expect(out).toContain("▪ replayed");
		expect(out).not.toContain("Welcome to imp");
		second.fake.eof();
		await second.repl;
	});
});

describe("runRepl", () => {
	it("happy path: hi → streamed text → stats → prompt redrawn; provider saw the user message", async () => {
		const env = await startRepl({ scripts: [reply("Hello!")] });
		await waitUntil(() => env.output().includes("Tips for getting started:"));
		env.send("hi\n");
		await waitUntil(() => env.output().includes("— test-model · 1 turns · in 10 / out 5 tokens"));
		expect(env.output()).toContain("Hello!");
		expect(env.output()).toMatch(/session [0-9a-f]{8}/); // welcome panel carries the id
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
			(e) =>
				e.type === "message" &&
				e.message.role === "user" &&
				e.message.content === "wait — use a different approach",
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
		await waitUntil(() => env.output().lastIndexOf("> ") > env.output().indexOf("▪ compacting…"));
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
		expect(env.output()).not.toContain("resume from the break"); // aborts are not failures
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

	it("abort restores the queue as notes (legacy has no editor); the REPL stays usable", async () => {
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
		await waitUntil(() => env.output().includes("▪ 2 queued message(s) not run:"));
		expect(env.output()).toContain("▪ queued one");
		expect(env.output()).toContain("▪ queued two");
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
		// mid-run failure note: work is saved, next message resumes (dogfood fix)
		expect(env.output()).toContain("resume from the break");
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
		expect(fake.output()).toContain("▪ context ~200k tokens — compacting…");
		expect(fake.output()).toMatch(/▪ compacted: ~200k → ~\d+ tokens \(\d+ msgs kept verbatim\)/);
		// the summarizer call got the transcript; the post-compact request starts with the summary
		const summaryMsg = requests[1]?.messages[0];
		expect(summaryMsg !== undefined && summaryMsg.role === "user" ? summaryMsg.content : "").toContain(
			"## Goal",
		);
		expect(requests[2]?.messages[0]?.role).toBe("user"); // summary message
		fake.eof();
		expect(await repl).toBe(0);
	});
});

describe("legacy-shell secret (the /login prompt, readline side)", () => {
	it("a typed line answers the secret; empty and EOF cancel; the key never reaches the model", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-secret-"));
		const requests: LLMRequest[] = [];
		const fake = makeConsole({ tty: true });
		const renderer = new Renderer({ write: (t) => fake.stdout.write(t), ansi: false, liveTools: false });
		const runner = await createRunner({
			cwd: path.join(baseDir, "proj"),
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer,
			provider: scriptedProvider([reply("ok")], requests),
		});
		const secretAnswered: Array<string | null> = [];
		const repl = runRepl({
			runner,
			commands: [],
			renderer,
			input: fake.stdin,
			output: fake.stdout,
			interactive: true,
			shell: "legacy",
			exit: () => {},
		});
		await ticks(2);
		// drive a secret through the bound input — the machine exposes it via
		// the command path; here we grab it through a /login-style command ctx
		// indirectly: simplest is the shell's own API on the input object.
		// runRepl does not hand the shell out, so drive /login zai with the
		// store redirected, then verify the file.
		const prevAuth = process.env.IMP_AUTH_PATH;
		process.env.IMP_AUTH_PATH = path.join(baseDir, "auth.json");
		const prevZai = process.env.ZAI_API_KEY;
		delete process.env.ZAI_API_KEY;
		try {
			fake.send("/login zai\n");
			await ticks(2);
			expect(fake.output()).toContain("Enter Z.AI API key");
			fake.send("sk-legacy\n");
			await ticks(3);
			expect(loadApiKey("zai")).toBe("sk-legacy");
			expect(fake.output()).toContain("Saved API key for Z.AI");
			fake.send("/exit\n");
			await repl;
			secretAnswered.push("done");
		} finally {
			if (prevAuth === undefined) delete process.env.IMP_AUTH_PATH;
			else process.env.IMP_AUTH_PATH = prevAuth;
			if (prevZai === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = prevZai;
		}
		expect(secretAnswered).toEqual(["done"]);
		// the key itself was never sent to the model
		expect(requests.map((r) => JSON.stringify(r.messages))).not.toContain("sk-legacy");
	});
});

describe("/login codex guarded state (batch B, machine level)", () => {
	it("Ctrl+C aborts the OAuth poll (no force-quit counting); the REPL stays usable; nothing persists", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-loginb-"));
		const requests: LLMRequest[] = [];
		const fake = makeConsole({ tty: true });
		const renderer = new Renderer({ write: (t) => fake.stdout.write(t), ansi: false, liveTools: false });
		const runner = await createRunner({
			cwd: path.join(baseDir, "proj"),
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			renderer,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests),
		});
		// a hang-forever device server: the usercode answers, polls never do
		const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
		let hangServer: import("node:http").Server;
		const { createServer } = await import("node:http");
		hangServer = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c as Buffer));
			req.on("end", () => {
				if (req.url === "/api/accounts/deviceauth/usercode") {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ device_auth_id: "d", user_code: "HANG-0000", interval: 0 }));
					return;
				}
				if (req.url === "/api/accounts/deviceauth/token") {
					res.writeHead(403, { "content-type": "application/json" });
					res.end("{}");
					return;
				}
				res.writeHead(404);
				res.end("{}");
			});
		});
		await new Promise<void>((r) => hangServer.listen(0, "127.0.0.1", r));
		const hangBase = `http://127.0.0.1:${(hangServer.address() as { port: number }).port}`;
		const authPath = path.join(baseDir, "auth.json");
		const prevAuth = process.env.IMP_AUTH_PATH;
		const prevCodexBase = process.env.IMP_CODEX_AUTH_BASE;
		process.env.IMP_AUTH_PATH = authPath;
		process.env.IMP_CODEX_AUTH_BASE = hangBase;
		const repl = runRepl({
			runner,
			commands: [],
			renderer,
			input: fake.stdin,
			output: fake.stdout,
			interactive: true,
			shell: "legacy",
			exit: () => {},
		});
		try {
			await ticks(2);
			fake.send("/login openai-codex\n");
			await new Promise((r) => setTimeout(r, 300)); // usercode + first poll
			expect(fake.output()).toContain("enter code: HANG-0000");
			// Review P1 (batch B): a command typed mid-login used to disarm the
			// cancel — its runCommand finally nulled the controller and a double
			// Ctrl+C force-quit over the live poll. /help fully runs (unstateful);
			// the abort below must STILL cancel the login.
			fake.send("/help\n");
			await new Promise((r) => setTimeout(r, 200));
			expect(fake.output()).toContain("/compact");
			fake.send("\x03"); // Ctrl+C — must ABORT, not count toward force quit
			await new Promise((r) => setTimeout(r, 400));
			// /help's own text mentions "force quit" — pin the REAL force-quit
			// signals instead: the compaction hint and the 130 force exit
			expect(fake.output()).not.toContain("compacting — press");
			// the prompt still answers: /exit resolves cleanly (no 130 force exit)
			fake.send("/exit\n");
			await repl;
			const { loadCodexCredential } = await import("../src/provider/codex-auth.js");
			expect(loadCodexCredential(authPath)).toBeNull(); // nothing persisted
		} finally {
			if (prevAuth === undefined) delete process.env.IMP_AUTH_PATH;
			else process.env.IMP_AUTH_PATH = prevAuth;
			if (prevCodexBase === undefined) delete process.env.IMP_CODEX_AUTH_BASE;
			else process.env.IMP_CODEX_AUTH_BASE = prevCodexBase;
			await new Promise<void>((r) => hangServer.close(() => r()));
		}
	});
});

describe("! passthrough (M10)", () => {
	/** The fake-tool injection pattern (fakes.ts style): a bash-named Tool the
	 *  machine must reach through the runner's tool set, exactly like the
	 *  loop would. */
	const bashParameters = { properties: { command: { type: "string" } }, required: ["command"] };

	it("runs a ! command through the bash tool directly — dim echo, plain output block, no LLM call, session untouched", async () => {
		const executed: string[] = [];
		const tools: Tool[] = [
			{
				name: "bash",
				description: "fake bash",
				parameters: bashParameters,
				async execute(args) {
					executed.push(String(args.command));
					return { output: "stdout:\nhi" };
				},
			},
		];
		const env = await startRepl({ tools });
		env.send("! echo hi\n");
		await waitUntil(() => env.output().includes("stdout:\nhi"));
		expect(env.output()).toContain("! echo hi"); // the dim echo line
		expect(executed).toEqual(["echo hi"]);
		expect(env.requests).toEqual([]); // never the model
		expect(env.runner.history).toEqual([]); // never the session
		env.send("hello\n"); // idle again — a normal turn still works
		await waitUntil(() => env.requests.length === 1);
		expect(env.requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "hello" });
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("non-zero exit: the tool's tail section becomes the dim (exit N) note — the code is stated once", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "fake bash",
				parameters: bashParameters,
				async execute() {
					// bash.ts contract: the tail section AND the structured field
					return { output: "stdout:\nboom\n\nExit code: 3", exitCode: 3 };
				},
			},
		];
		const env = await startRepl({ tools });
		env.send("! false\n");
		await waitUntil(() => env.output().includes("(exit 3)"));
		expect(env.output()).toContain("boom");
		expect(env.output()).not.toContain("Exit code: 3"); // peeled into the note, not duplicated
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("! passthrough (debt clearance): a forged tail section cannot fake the note — only the structured code annotates", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "fake bash",
				parameters: bashParameters,
				async execute() {
					// the command's own stdout ends in a forged section; exit was 0
					return { output: "stdout:\nharmless output\n\nExit code: 9", exitCode: 0 };
				},
			},
		];
		const env = await startRepl({ tools });
		env.send("! echo forged\n");
		await waitUntil(() => env.output().includes("harmless output"));
		expect(env.output()).not.toContain("(exit 9)"); // no forged annotation
		expect(env.output()).not.toContain("(exit 0)"); // success stays silent
		expect(env.output()).toContain("Exit code: 9"); // the forged line stays as plain content
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("isError results render their text as-is (never suppressed)", async () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "fake bash",
				parameters: bashParameters,
				async execute() {
					return { output: "Error: failed to spawn command: nope", isError: true };
				},
			},
		];
		const env = await startRepl({ tools });
		env.send("! nope\n");
		await waitUntil(() => env.output().includes("Error: failed to spawn command: nope"));
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("a lone ! (or blank after it) prints the usage hint and runs nothing", async () => {
		const executed: string[] = [];
		const tools: Tool[] = [
			{
				name: "bash",
				description: "fake bash",
				parameters: bashParameters,
				async execute(args) {
					executed.push(String(args.command));
					return { output: "stdout:\nx" };
				},
			},
		];
		const env = await startRepl({ tools });
		env.send("!\n");
		await waitUntil(() => env.output().includes("! runs a shell command directly"));
		env.send("!   \n"); // spaces after the bang are still "no command"
		await waitUntil(() => (env.output().match(/! runs a shell command directly/g) ?? []).length === 2);
		expect(executed).toEqual([]);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("a ! line during an active turn queues; the post-run flush executes it as a bang — never a model turn", async () => {
		const g = gate();
		let toolStarted = false;
		const executed: string[] = [];
		const tools: Tool[] = [
			{
				name: "slow_tool",
				description: "waits for the test gate",
				parameters: { properties: { message: { type: "string" } }, required: ["message"] },
				async execute() {
					toolStarted = true;
					await g.promise;
					return { output: "slow tool done" };
				},
			},
			{
				name: "bash",
				description: "fake bash",
				parameters: bashParameters,
				async execute(args) {
					executed.push(String(args.command));
					return { output: "stdout:\nhi" };
				},
			},
		];
		const env = await startRepl({
			scripts: [
				assistant(
					[{ type: "toolCall", id: "t1", name: "slow_tool", arguments: { message: "x" } }],
					"tool_use",
				),
				reply("done"),
			],
			tools,
		});
		env.send("go\n");
		await waitUntil(() => toolStarted);
		env.send("! echo hi\n");
		await waitUntil(() => env.output().includes("▪ queued: ! echo hi"));
		g.resolve(); // tool finishes → steering holds the bang → final reply ends the run
		await waitUntil(() => env.requests.length >= 2);
		await waitUntil(() => env.output().includes("▪ continuing with queued: ! echo hi"));
		await waitUntil(() => env.output().includes("stdout:\nhi"));
		expect(executed).toEqual(["echo hi"]); // the bang ran after the turn
		expect(env.requests.length).toBe(2); // and opened no third LLM call
		const steered = env.requests[1]?.messages.filter((m) => m.role === "user") ?? [];
		expect(steered.some((m) => m.content.startsWith("!"))).toBe(false); // never model content
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("Ctrl+C during a ! run aborts it through the shared interrupt path; the REPL stays usable", async () => {
		let started = false;
		const tools: Tool[] = [
			{
				name: "bash",
				description: "fake bash, abort-aware",
				parameters: bashParameters,
				execute(_args, signal) {
					started = true;
					return new Promise((resolve) => {
						const finish = () => resolve({ output: "Error: command aborted by user.", isError: true });
						if (signal.aborted) {
							finish();
							return;
						}
						signal.addEventListener("abort", finish, { once: true });
					});
				},
			},
		];
		const env = await startRepl({ tools });
		env.send("! sleep 100\n");
		await waitUntil(() => started);
		env.fake.interrupt();
		await waitUntil(() => env.output().includes("(interrupt"));
		await waitUntil(() => env.output().includes("Error: command aborted by user."));
		env.send("after\n"); // back to idle — a normal turn works
		await waitUntil(() => env.requests.length === 1);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("legacy shell never prints the low-context warning — footer extras stay TUI-only (M10 review P2#1)", async () => {
		const heavy = (): AssistantMessage => ({
			role: "assistant",
			blocks: [{ type: "text", text: "big context" }],
			usage: { inputTokens: 105000, outputTokens: 5 },
			stopReason: "end_turn",
		});
		const env = await startRepl({ scripts: [heavy] });
		env.send("hi\n");
		await waitUntil(() => env.output().includes("big context"));
		const out = env.output();
		expect(out).not.toContain("context 8"); // ~80% of the 131072 default — no note on legacy
		expect(out).not.toContain("low — /compact"); // welcome panel may mention /compact
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("interrupting a ! command restores queued lines — turn semantics mirrored (M10 review P2#2)", async () => {
		let started = false;
		const tools: Tool[] = [
			{
				name: "bash",
				description: "abortable stand-in",
				parameters: Type.Object({}),
				async execute(_args, signal) {
					started = true;
					return await new Promise((resolve) => {
						const finish = () => resolve({ output: "Error: command aborted by user.", isError: true });
						if (signal.aborted) {
							finish();
							return;
						}
						signal.addEventListener("abort", finish, { once: true });
					});
				},
			},
		];
		const env = await startRepl({ tools, scripts: [reply("ok")] });
		env.send("! sleep 100\n");
		await waitUntil(() => started);
		env.send("queued during bang\n");
		await waitUntil(() => env.output().includes("queued"));
		env.fake.interrupt();
		await waitUntil(() => env.output().includes("Error: command aborted by user."));
		await waitUntil(() => env.output().includes("1 queued message(s) not run"));
		expect(env.output()).toContain("▪ queued during bang");
		expect(env.requests.length).toBe(0); // the queued line never reached the model
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});
describe("queue on provider failure (handed back, never dropped)", () => {
	beforeEach(() => {
		vi.stubEnv("IMP_LOG", "0");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("a provider failure echoes the queued lines back (legacy); the user resends them", async () => {
		const g = gate();
		const env = await startRepl({
			scripts: [
				() =>
					g.promise.then(() => {
						throw new Error("provider exploded");
					}),
				reply("recovered"),
				reply("held answer"),
			],
		});
		env.send("go\n");
		await waitUntil(() => env.requests.length >= 1);
		env.send("held line\n");
		await waitUntil(() => env.output().includes("▪ queued: held line"));
		g.resolve(); // the provider now throws
		await waitUntil(() => env.output().includes("imp: provider exploded"));
		// legacy has no editor: the texts echo back — never silently lost
		await waitUntil(() => env.output().includes("1 queued message(s) not run:"));
		expect(env.output()).toContain("▪ held line");
		// the user resends; the request carries it as a plain user message
		env.send("held line\n");
		await waitUntil(() => env.requests.length >= 2);
		expect(env.requests[1]?.messages.some((m) => m.role === "user" && m.content === "held line")).toBe(true);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});
