import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import {
	type LoadedExtensions,
	loadExtensions,
	printExtensionDiagnostics,
} from "../src/extensions/loader.js";
import { VERSION } from "../src/format.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { runRepl, TtyConfirm } from "../src/repl/repl.js";
import { createRunner, type Runner } from "../src/runner.js";
import {
	assistant,
	type FakeConsole,
	gate,
	gatedTool,
	makeConsole,
	type ScriptStep,
	scriptedProvider,
	ticks,
	waitUntil,
	writeExtensionFiles,
} from "./helpers/fakes.js";

const reply = (text: string): AssistantMessage => assistant([{ type: "text", text }]);

const toolCall = (id: string, name: string, args: Record<string, unknown>): ScriptStep =>
	assistant([{ type: "toolCall", id, name, arguments: args }], "tool_use");

interface ReplEnv {
	cwd: string;
	fake: FakeConsole;
	runner: Runner;
	repl: Promise<number>;
	requests: LLMRequest[];
	send(text: string): void;
	output(): string;
}

interface StartArgs {
	scripts?: ScriptStep[];
	tools?: Tool[];
	tty?: boolean;
	extensionFiles?: Record<string, string>;
	/** Written to <cwd>/.imp/agents/ before the runner loads (M5c discovery). */
	agentFiles?: Record<string, string>;
	extensionPaths?: string[];
	noExtensions?: boolean;
	noContextFiles?: boolean;
	agentsMd?: boolean;
	/** git init + one commit in <cwd> — worktree-children tests (M6b). */
	gitInit?: boolean;
	/** Wire a TtyConfirm into loading + runRepl: api.confirm asks [y/N] on the
	 *  fake stdin (spec part 2 item 6). */
	confirm?: boolean;
}

/**
 * The M3-style full-path harness (design §14): a real runRepl over a real
 * Runner — plus the real extension wiring cli.ts uses, minus parseArgs and
 * process.exit. Fixtures are real .mjs files loaded by real dynamic import.
 */
async function startRepl(args: StartArgs): Promise<ReplEnv> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-extrepl-"));
	const cwd = path.join(baseDir, "proj");
	const home = path.join(baseDir, "home"); // hermetic global extension dir
	await mkdir(cwd, { recursive: true });
	if (args.extensionFiles) await writeExtensionFiles(cwd, args.extensionFiles);
	if (args.agentFiles) {
		const agentsDir = path.join(cwd, ".imp", "agents");
		await mkdir(agentsDir, { recursive: true });
		for (const [name, content] of Object.entries(args.agentFiles)) {
			await writeFile(path.join(agentsDir, name), content, "utf8");
		}
	}
	if (args.agentsMd) await writeFile(path.join(cwd, "AGENTS.md"), "# Test agents context\n", "utf8");
	if (args.gitInit === true) {
		const g = (flags: string[]): void => {
			const r = spawnSync("git", flags, { cwd, encoding: "utf8" });
			if (r.status !== 0) throw new Error(`git ${flags.join(" ")}: ${r.stderr}`);
		};
		g(["init", "-q"]);
		g(["config", "user.email", "t@imp.dev"]);
		g(["config", "user.name", "t"]);
		await writeFile(path.join(cwd, "seed.txt"), "committed\n", "utf8");
		g(["add", "."]);
		g(["commit", "-qm", "seed"]);
	}

	const requests: LLMRequest[] = [];
	const provider: LLMProvider = scriptedProvider(args.scripts ?? [reply("ok")], requests);
	const fake = makeConsole({ tty: args.tty ?? true });
	const renderer = new Renderer({
		write: (text) => fake.stdout.write(text),
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
	});

	// the exact cli wiring (design §10): load → banner → createRunner → runRepl
	// with the registered commands (M4b §8.2). confirm mirrors cli.ts's
	// interactive wiring (spec part 2 item 6).
	const ttyConfirm = args.confirm === true ? new TtyConfirm(renderer) : undefined;
	const loaded: LoadedExtensions = await loadExtensions({
		cwd,
		cliPaths: args.extensionPaths ?? [],
		noDiscovery: args.noExtensions ?? false,
		home,
		onDiagnostic: (line) => renderer.error(line),
		confirm: ttyConfirm?.handler,
	});
	printExtensionDiagnostics(loaded.summaries, (line) => renderer.note(line));

	const runner = await createRunner({
		cwd,
		argv: [],
		model: "test-model",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: args.noContextFiles ?? true,
		noSession: false,
		sessionBaseDir: baseDir,
		renderer,
		provider,
		tools: args.tools,
		deferInit: false,
		extensions: loaded.runtime,
		extensionFailures: loaded.failures,
	});
	const repl = runRepl({
		runner,
		commands: loaded.runtime.commands,
		input: fake.stdin,
		output: fake.stdout,
		interactive: args.tty ?? true,
		confirm: ttyConfirm,
		exit: (code) => {
			throw new Error(`force-exit:${code}`);
		},
	});
	await ticks(2);
	return {
		cwd,
		fake,
		runner,
		repl,
		requests,
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

describe("full-path extension wiring through the REPL (design §14)", () => {
	it("case 9: the real examples/extensions/notes.mjs tool is visible to the model, callable, and persisted", async () => {
		const env = await startRepl({
			scripts: [toolCall("t1", "notes", { action: "set", text: "ship it" }), reply("saved your note")],
			extensionFiles: {
				"notes.mjs": readFileSync(path.resolve("examples/extensions/notes.mjs"), "utf8"),
			},
		});
		env.send("save a note saying 'ship it'\n");
		await waitUntil(() => env.output().includes("saved your note"));
		// the banner counts all three stored registration kinds
		expect(env.output()).toContain("▪ extension notes [project] — 1 tool, 1 command, 1 context");
		// the model saw the extension tool in its tool set
		expect(env.requests[0]?.tools.map((t) => t.name)).toContain("notes");
		// M4c: the registered context section is injected into the system prompt
		expect(env.requests[0]?.system).toContain("# Extension context: notes");
		// the tool really executed against the fixture's file
		const saved = JSON.parse(readFileSync(path.join(env.cwd, ".imp", "notes.json"), "utf8")) as {
			notes: string[];
		};
		expect(saved.notes).toEqual(["ship it"]);
		// the round-trip persisted to the session as a healthy tool_use/result pair
		const entries = readFileSync(env.runner.session?.filePath as string, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						message?: { role: string; results?: Array<{ toolName: string; isError: boolean }> };
					},
			);
		const toolResult = entries.find((e) => e.message?.role === "toolResult")?.message;
		expect(toolResult?.results?.[0]?.toolName).toBe("notes");
		expect(toolResult?.results?.[0]?.isError).toBe(false);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("case 16: a broken extension beside a good one — E1 line + banner, good tool works, scripted pipe still exits 0", async () => {
		const env = await startRepl({
			tty: false, // echo-pipe probe (M3 lesson): drive the scripted path end to end
			agentsMd: true, // P3-6: gives the deferred context banner something to print
			noContextFiles: false,
			scripts: [toolCall("t1", "good_tool", {}), reply("done")],
			extensionFiles: {
				"broken.mjs": "export default function (api) {\n\tthis is not valid js\n",
				"good.mjs": `import { writeFileSync } from "node:fs";
import path from "node:path";
export default function (api) {
	api.registerTool({
		name: "good_tool",
		description: "the one that works",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "good output" };
		},
	});
	// P3-4: pin api.version (cwd and origin already asserted elsewhere)
	writeFileSync(path.join(api.cwd, "ver.txt"), api.version);
}
`,
			},
		});
		env.send("go\n");
		await waitUntil(() => env.output().includes("done"));
		expect(env.output()).toMatch(/imp: extension broken failed to load — /);
		expect(env.output()).toContain("▪ extension good [project] — 1 tool");
		// P3-6: scripted/deferInit mode still prints extensions BEFORE the
		// deferred context banner (structurally guaranteed — now asserted)
		expect(env.output().indexOf("▪ extension good")).toBeLessThan(env.output().indexOf("▪ context:"));
		// P3-4: the factory's facts carried the host version
		expect(readFileSync(path.join(env.cwd, "ver.txt"), "utf8")).toBe(VERSION);
		// the good extension's tool executed through the scripted round-trip
		const sessionText = readFileSync(env.runner.session?.filePath as string, "utf8");
		expect(sessionText).toContain("good output");
		env.fake.eof();
		expect(await env.repl).toBe(0); // the exit path is unaffected by the failure
	});

	it("M4c: context injects into the system prompt and on() observers fire through the real line path", async () => {
		const env = await startRepl({
			scripts: [toolCall("t1", "tour_tool", { text: "x" }), reply("round trip done")],
			extensionFiles: {
				"tour.mjs": `import { writeFileSync } from "node:fs";
import path from "node:path";
export default function (api) {
	api.registerTool({
		name: "tour_tool",
		description: "the tool contribution",
		parameters: { type: "object", properties: { text: { type: "string" } } },
		async execute(args) {
			return { output: "tour:" + String(args.text) };
		},
	});
	api.registerCommand({
		name: "tourcmd",
		summary: "dispatched since M4b",
		allowedDuringRun: true,
		async run(_args, ctx) {
			ctx.renderer.note("tourcmd dispatched");
			return "handled";
		},
	});
	api.registerContext("tour", "Tour context (injected since M4c)");
	api.on("tool_end", () => {
		writeFileSync(path.join(api.cwd, "observer-fired.txt"), "fired");
	});
}
`,
			},
		});
		env.send("go\n");
		await waitUntil(() => env.output().includes("round trip done"));
		// stored + banner-counted: all four categories
		expect(env.output()).toContain("▪ extension tour [project] — 1 tool, 1 command, 1 context, 1 hook");
		// M4b: the stored command IS dispatched now — via the real line path
		env.send("/tourcmd hello\n");
		await waitUntil(() => env.output().includes("tourcmd dispatched"));
		// M4c: the stored context IS injected into the system prompt — exact header, exact text
		expect(env.requests[0]?.system).toContain(
			"\n\n# Extension context: tour\n\nTour context (injected since M4c)",
		);
		// M4c: the stored on("tool_end") handler fired for the tour_tool round trip
		expect(existsSync(path.join(env.cwd, "observer-fired.txt"))).toBe(true);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("banner order: extension lines print after loadExtensions and before the context banner and the REPL banner (design §7.3)", async () => {
		const env = await startRepl({
			agentsMd: true,
			noContextFiles: false,
			scripts: [reply("ok")],
			extensionFiles: {
				"one.mjs": `export default function (api) {
	api.registerTool({
		name: "one_tool",
		description: "banner order probe",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "one" };
		},
	});
}
`,
			},
		});
		const out = env.output();
		const extAt = out.indexOf("▪ extension one [project]");
		const contextAt = out.indexOf("▪ context:");
		const replAt = out.indexOf("imp 0.1.0 — /help for commands");
		expect(extAt).toBeGreaterThanOrEqual(0);
		expect(contextAt).toBeGreaterThanOrEqual(0);
		expect(replAt).toBeGreaterThanOrEqual(0);
		expect(extAt).toBeLessThan(contextAt);
		expect(extAt).toBeLessThan(replAt);
		env.send("hi\n");
		await waitUntil(() => env.output().includes("1 turns"));
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("-ne end to end: discovery dirs are skipped, an explicit -e path still loads", async () => {
		const explicitDir = await mkdtemp(path.join(tmpdir(), "imp-ext-cli-"));
		const explicit = path.join(explicitDir, "explicit.mjs");
		await writeFile(
			explicit,
			`export default function (api) {
	api.registerTool({
		name: "explicit_tool",
		description: "explicit intent",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "explicit" };
		},
	});
}
`,
			"utf8",
		);
		const env = await startRepl({
			tty: false,
			noExtensions: true,
			extensionPaths: [explicit],
			extensionFiles: {
				"disc.mjs": `export default function (api) {
	api.registerTool({
		name: "disc_tool",
		description: "must not load",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "nope" };
		},
	});
}
`,
			},
			scripts: [reply("ok")],
		});
		env.send("hi\n");
		await waitUntil(() => env.output().includes("ok"));
		expect(env.output()).toContain("▪ extension explicit [cli] — 1 tool");
		expect(env.output()).not.toContain("disc_tool");
		const toolNames = env.requests[0]?.tools.map((t) => t.name) ?? [];
		expect(toolNames).toContain("explicit_tool");
		expect(toolNames).not.toContain("disc_tool");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});

describe("extension commands through the REPL line path (M4b, design §8.2/§14)", () => {
	it("case 10: /notes <text> dispatches via fake.send, spends no model turn, persists, and /help lists it with [notes]", async () => {
		const env = await startRepl({
			extensionFiles: {
				"notes.mjs": readFileSync(path.resolve("examples/extensions/notes.mjs"), "utf8"),
			},
		});
		env.send("/notes save hi\n");
		await waitUntil(() => env.output().includes("▪ note saved (1 total)"));
		// the command really executed against the fixture's file
		const saved = JSON.parse(readFileSync(path.join(env.cwd, ".imp", "notes.json"), "utf8")) as {
			notes: string[];
		};
		expect(saved.notes).toEqual(["save hi"]);
		// "without spending a model turn" — the provider was never called
		expect(env.requests).toHaveLength(0);
		// /help lists the extension command with its dim source suffix (design §8.2)
		env.send("/help\n");
		await waitUntil(() => env.output().includes("Commands:"));
		expect(env.output()).toContain(
			"  /notes             save a note without spending a model turn    [notes]",
		);
		// built-ins are still listed and byte-stable above the extension row
		expect(env.output()).toContain("  /compact           summarize older context now");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("case 11: the unknown-command teaching line lists extension commands too (generated, cannot drift)", async () => {
		const env = await startRepl({
			extensionFiles: {
				"extcmd.mjs": `export default function (api) {
	api.registerCommand({
		name: "extcmd",
		summary: "fixture command",
		allowedDuringRun: true,
		run(_args, ctx) {
			ctx.renderer.note("▪ extcmd ran");
			return "handled";
		},
	});
}
`,
			},
		});
		env.send("/nope\n");
		await waitUntil(() => env.output().includes('imp: unknown command "/nope"'));
		expect(env.output()).toContain(
			"known: /help /exit /new /sessions /resume /model /compact /extcmd — /help shows what they do",
		);
		// the provider was never called — teaching errors never reach the model
		expect(env.requests).toHaveLength(0);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("case 12: an allowedDuringRun:false extension command is rejected mid-run with the standard teaching line, dispatches once idle", async () => {
		const toolGate = gate();
		const env = await startRepl({
			tools: [gatedTool(toolGate, "slow")],
			scripts: [toolCall("t1", "slow", { message: "hold" }), reply("done")],
			extensionFiles: {
				"slowcmd.mjs": `export default function (api) {
	api.registerCommand({
		name: "slowcmd",
		summary: "fixture that must wait",
		allowedDuringRun: false,
		run(_args, ctx) {
			ctx.renderer.note("▪ slowcmd ran");
			return "handled";
		},
	});
}
`,
			},
		});
		env.send("go\n");
		// the gated tool holds the turn open — the run is definitively active
		await waitUntil(() => env.requests.length === 1);
		await ticks(2);
		env.send("/slowcmd\n");
		await waitUntil(() => env.output().includes("waits for the running turn"));
		expect(env.output()).toContain(
			"imp: /slowcmd waits for the running turn — press Ctrl+C to abort it first, then /slowcmd",
		);
		expect(env.output()).not.toContain("▪ slowcmd ran");
		// once idle, the same command dispatches normally
		toolGate.resolve();
		await waitUntil(() => env.output().includes("done"));
		env.send("/slowcmd\n");
		await waitUntil(() => env.output().includes("▪ slowcmd ran"));
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("conflict: extension-vs-extension first-wins with named rejection; only the winner dispatches and gets the [source] tag", async () => {
		const env = await startRepl({
			extensionFiles: {
				// load order is code-point sort: first.mjs loads before second.mjs
				"first.mjs": `export default function (api) {
	api.registerCommand({
		name: "shared",
		summary: "the first one",
		allowedDuringRun: true,
		run(_args, ctx) {
			ctx.renderer.note("▪ shared ran: first");
			return "handled";
		},
	});
}
`,
				"second.mjs": `export default function (api) {
	api.registerCommand({
		name: "shared",
		summary: "the second one",
		allowedDuringRun: true,
		run(_args, ctx) {
			ctx.renderer.note("▪ shared ran: second");
			return "handled";
		},
	});
	api.registerCommand({
		name: "only_second",
		summary: "survives the conflict",
		allowedDuringRun: true,
		run(_args, ctx) {
			ctx.renderer.note("▪ only_second ran");
			return "handled";
		},
	});
}
`,
			},
		});
		// named rejection at load time (design §9/E6) — the loser's registration is skipped
		expect(env.output()).toContain(
			'imp: extension second could not register command "shared" — already registered by first',
		);
		// first wins at dispatch time
		env.send("/shared\n");
		await waitUntil(() => env.output().includes("▪ shared ran: first"));
		expect(env.output()).not.toContain("▪ shared ran: second");
		// the losing extension's OTHER registration still stands (errors as data)
		env.send("/only_second\n");
		await waitUntil(() => env.output().includes("▪ only_second ran"));
		// /help tags the winner; the loser's "shared" registration never lists
		// (its summary is absent) while its surviving command keeps its own tag
		env.send("/help\n");
		await waitUntil(() => env.output().includes("Commands:"));
		expect(env.output()).toContain("the first one");
		expect(env.output()).toContain("[first]");
		expect(env.output()).not.toContain("the second one");
		expect(env.output()).toContain("survives the conflict");
		expect(env.output()).toContain("[second]");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});

it("M6a: the extension gate sees subagent tool calls — subagent: true, agent name, block reaches the child", async () => {
	const env = await startRepl({
		scripts: [
			toolCall("t1", "task", { prompt: "probe once", agent: "scout" }),
			toolCall("c1", "probe_tool", {}),
			reply("child saw the block"),
			reply("parent done"),
		],
		agentFiles: {
			"scout.md": "---\nname: scout\ndescription: probes\n---\nScout body.",
		},
		extensionFiles: {
			"gate.mjs": `import { appendFileSync } from "node:fs";
import path from "node:path";
export default function (api) {
	const log = path.join(api.cwd, "gate-events.jsonl");
	api.on("tool_call", (e) => {
		appendFileSync(log, JSON.stringify({ kind: "call", name: e.name, subagent: e.subagent, agent: e.agent, cwd: e.cwd }) + "\\n");
		if (e.subagent) return { block: true, reason: "children may not probe" };
	});
	api.on("tool_end", (e) => {
		appendFileSync(log, JSON.stringify({ kind: "end", name: e.name, isError: e.isError, subagent: e.subagent, agent: e.agent }) + "\\n");
	});
	api.registerTool({
		name: "probe_tool",
		description: "probe",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "probed" };
		},
	});
}
`,
		},
	});
	env.send("delegate to scout");
	env.fake.eof();
	expect(await env.repl).toBe(0);

	// the gate observed both calls, with the subagent discriminator on the
	// child's; both loops run in the project cwd (no worktree here)
	const events = readFileSync(path.join(env.cwd, "gate-events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(events).toEqual([
		{ kind: "call", name: "task", subagent: undefined, agent: undefined, cwd: env.cwd }, // parent: no subagent mark
		{ kind: "call", name: "probe_tool", subagent: true, agent: "scout", cwd: env.cwd }, // child: marked + named
		{ kind: "end", name: "probe_tool", isError: true, subagent: true, agent: "scout" }, // child audit (M6a fix)
		{ kind: "end", name: "task", isError: false, subagent: undefined, agent: undefined }, // parent's own task end
	]);

	// the block reason reached the child as its tool result (child request 2)
	const childSecond = env.requests[2];
	expect(JSON.stringify(childSecond?.messages)).toContain("children may not probe");
	// the child recovered, the parent got the recovery text as the task result
	expect(env.fake.output()).toContain("child saw the block");
	expect(env.fake.output()).toContain("parent done");
});

/** An observer fixture that appends every received event to events.jsonl. */
const EVENTS_FIXTURE = `import { appendFileSync } from "node:fs";
import path from "node:path";
export default function (api) {
	const log = path.join(api.cwd, "events.jsonl");
	const write = (entry) => appendFileSync(log, JSON.stringify(entry) + "\\n");
	api.on("tool_call", (e) => write({ type: "tool_call", toolCallId: e.toolCallId, name: e.name, cwd: e.cwd }));
	api.on("tool_end", (e) => write({ type: "tool_end", toolCallId: e.toolCallId, isError: e.isError, cwd: e.cwd }));
	api.on("message_end", (e) => write({ type: "message_end", blocks: e.message.blocks.map((b) => b.type) }));
	api.on("run_end", (e) =>
		write({ type: "run_end", stopReason: e.stopReason, turns: e.turns, usage: e.usage }),
	);
}
`;

/** A minimal model-callable tool fixture (no side effects beyond its output). */
const PROBE_TOOL_FIXTURE = `export default function (api) {
	api.registerTool({
		name: "probe_tool",
		description: "a fixture tool that echoes",
		parameters: { type: "object", properties: { message: { type: "string" } } },
		async execute(args) {
			return { output: "probe:" + String(args.message) };
		},
	});
}
`;

interface SessionEntry {
	message?: {
		role: string;
		results?: Array<{ toolCallId: string; toolName?: string; isError: boolean; content: string }>;
	};
}

/** Parses a session JSONL file into its entries. */
function readSession(filePath: string | undefined): SessionEntry[] {
	if (!filePath) throw new Error("no session file");
	return readFileSync(filePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as SessionEntry);
}

describe("context injection and loop events through the real path (M4c, design §8.3/§14)", () => {
	it("case 13: context sections land after the AGENTS.md block in stable multi-extension load order; /new re-appends them", async () => {
		const env = await startRepl({
			agentsMd: true,
			noContextFiles: false,
			scripts: [reply("first done"), reply("second done")],
			extensionFiles: {
				// load order is code-point sort: alpha.mjs loads before omega.mjs
				"alpha.mjs": `export default function (api) {
	api.registerContext("alpha", "Alpha context block.");
}
`,
				"omega.mjs": `export default function (api) {
	api.registerContext("omega", "Omega context block.");
}
`,
			},
		});
		env.send("one\n");
		await waitUntil(() => env.output().includes("first done"));
		const system = env.requests[0]?.system ?? "";
		const agentsAt = system.indexOf("# Project context (AGENTS.md)");
		const alphaAt = system.indexOf("\n\n# Extension context: alpha\n\nAlpha context block.");
		const omegaAt = system.indexOf("\n\n# Extension context: omega\n\nOmega context block.");
		expect(agentsAt).toBeGreaterThanOrEqual(0);
		expect(alphaAt).toBeGreaterThanOrEqual(0);
		expect(omegaAt).toBeGreaterThanOrEqual(0);
		// position per design §8.3: after the AGENTS.md block, in load order
		expect(agentsAt).toBeLessThan(alphaAt);
		expect(alphaAt).toBeLessThan(omegaAt);
		// /new re-runs assembleSystem: the same registered sections re-append
		// (registration data outlives sessions — no re-registration needed)
		env.send("/new\n");
		await waitUntil(() => env.output().includes("▪ new session"));
		env.send("two\n");
		await waitUntil(() => env.output().includes("second done"));
		const system2 = env.requests[1]?.system ?? "";
		expect(system2).toContain("# Extension context: alpha");
		expect(system2).toContain("# Extension context: omega");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("case 14: tool_call/tool_end/message_end/run_end fire in order with correct payloads after a scripted 2-turn run", async () => {
		const env = await startRepl({
			scripts: [toolCall("t1", "probe_tool", { message: "hi" }), reply("done")],
			extensionFiles: { "events.mjs": EVENTS_FIXTURE, "probe.mjs": PROBE_TOOL_FIXTURE },
		});
		env.send("go\n");
		await waitUntil(() => env.output().includes("done"));
		const events = readFileSync(path.join(env.cwd, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		// emission order is the designed one: each assistant message as it enters
		// history, the gate around each execution, then the run result. Main-loop
		// tool events carry the runner's cwd (spec part 1 item 2).
		expect(events).toEqual([
			{ type: "message_end", blocks: ["toolCall"] },
			{ type: "tool_call", toolCallId: "t1", name: "probe_tool", cwd: env.cwd },
			{ type: "tool_end", toolCallId: "t1", isError: false, cwd: env.cwd },
			{ type: "message_end", blocks: ["text"] },
			{
				type: "run_end",
				stopReason: "completed",
				turns: 2,
				usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
			},
		]);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("aborted turn: run_end fires with stopReason aborted; a tool that never ran gets no tool_end; the session keeps a complete pair", async () => {
		const started = { value: false };
		const abortAware: Tool = {
			name: "abortme",
			description: "resolves only when the run aborts",
			parameters: Type.Object({ message: Type.String() }),
			async execute(_args, signal) {
				started.value = true;
				return await new Promise<{ output: string }>((resolve) => {
					signal?.addEventListener("abort", () => resolve({ output: "saw abort" }), { once: true });
				});
			},
		};
		const env = await startRepl({
			tools: [abortAware],
			scripts: [
				assistant(
					[
						{ type: "toolCall", id: "t1", name: "abortme", arguments: { message: "first" } },
						{ type: "toolCall", id: "t2", name: "abortme", arguments: { message: "second" } },
					],
					"tool_use",
				),
				reply("never"),
			],
			extensionFiles: { "events.mjs": EVENTS_FIXTURE },
		});
		env.send("go\n");
		await waitUntil(() => started.value);
		env.fake.interrupt(); // Ctrl+C while t1 executes — t2 never starts
		await waitUntil(() => env.output().includes("(aborted)"));
		const events = readFileSync(path.join(env.cwd, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		// aborted turns emit the assistant message already produced and the run
		// result — but no gate/tool_end for a call that never ran (its
		// synthesized closer is not a completed tool; design §6.1/§8.3)
		expect(events).toEqual([
			{ type: "message_end", blocks: ["toolCall", "toolCall"] },
			{ type: "tool_call", toolCallId: "t1", name: "abortme", cwd: env.cwd },
			{ type: "tool_end", toolCallId: "t1", isError: false, cwd: env.cwd },
			{
				type: "run_end",
				stopReason: "aborted",
				turns: 1,
				usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
			},
		]);
		// the persisted session still has a complete tool_use → tool_result pair
		const entries = readSession(env.runner.session?.filePath);
		const lastTool = [...entries].reverse().find((e) => e.message?.role === "toolResult")?.message;
		const byId = new Map(lastTool?.results?.map((r) => [r.toolCallId, r]));
		expect(byId.get("t1")?.isError).toBe(false);
		expect(byId.get("t2")?.content).toBe("(interrupted before this tool ran)");
		expect(byId.get("t2")?.isError).toBe(true);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("blocked-call round trip: the model receives the exact refusal, the run continues, the session persists a healthy pair", async () => {
		const executed: string[] = [];
		const probe: Tool = {
			name: "probe_tool",
			description: "records execution",
			parameters: Type.Object({ message: Type.String() }),
			async execute(args) {
				executed.push(String(args.message));
				return { output: "ran" };
			},
		};
		const env = await startRepl({
			tools: [probe],
			scripts: [toolCall("t1", "probe_tool", { message: "forbidden" }), reply("adapted instead")],
			extensionFiles: {
				"gate.mjs": `export default function (api) {
	api.on("tool_call", (event) => {
		if (event.name === "probe_tool") {
			return { block: true, reason: "probes are off — use read instead" };
		}
	});
}
`,
			},
		});
		env.send("go\n");
		await waitUntil(() => env.output().includes("adapted instead"));
		expect(executed).toEqual([]); // the gate ran before execute — nothing executed
		const refusal = env.requests[1]?.messages.find((m) => m.role === "toolResult")?.results[0];
		expect(refusal).toMatchObject({
			toolCallId: "t1",
			toolName: "probe_tool",
			content: 'Tool "probe_tool" blocked by an extension: probes are off — use read instead',
			isError: true,
		});
		// a blocked call is resumable history: header line, then user → assistant(tool_use) → toolResult → assistant
		const entries = readSession(env.runner.session?.filePath);
		const roles = entries.map((e) => e.message?.role).filter((r): r is string => r !== undefined);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const pair = entries.find((e) => e.message?.role === "toolResult")?.message?.results?.[0];
		expect(pair?.isError).toBe(true);
		expect(pair?.content).toBe(
			'Tool "probe_tool" blocked by an extension: probes are off — use read instead',
		);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});

describe("guardian case study (design §13.1)", () => {
	it("the real examples/extensions/guardian.mjs blocks rm -rf and outside-cwd writes with teaching reasons, and audits both", async () => {
		const fakeHome = await mkdtemp(path.join(tmpdir(), "imp-guardhome-"));
		vi.stubEnv("HOME", fakeHome); // guardian audits to ~/.imp/guardian.log — keep it hermetic
		// The hazards are armed hermetically: the delete targets a sacrificial
		// tree inside the temp project, the write targets a sibling temp dir — a
		// fail-open gate reds the survival assertions below without touching
		// anything real (review P1: the gate must not be the only containment).
		const outsideDir = await mkdtemp(path.join(tmpdir(), "imp-guardout-"));
		const env = await startRepl({
			scripts: [
				toolCall("g1", "bash", { command: "rm -rf sacrifice" }),
				reply("adapted after the bash block"),
				toolCall("g2", "write", {
					path: path.join(outsideDir, "imp-guardian-must-not-exist.txt"),
					content: "nope",
				}),
				reply("adapted after the write block"),
			],
			extensionFiles: {
				"guardian.mjs": readFileSync(path.resolve("examples/extensions/guardian.mjs"), "utf8"),
			},
		});
		// what the blocked rm would have deleted — a bare relative name can only
		// ever resolve under the runner's cwd, never above it
		const sacrifice = path.join(env.cwd, "sacrifice", "nested");
		await mkdir(sacrifice, { recursive: true });
		expect(env.output()).toContain("▪ extension guardian [project] — 2 hooks");
		env.send("clean up\n");
		await waitUntil(() => env.output().includes("adapted after the bash block"));
		env.send("write outside\n");
		await waitUntil(() => env.output().includes("adapted after the write block"));
		const refusal1 = env.requests[1]?.messages.find((m) => m.role === "toolResult")?.results[0];
		expect(refusal1?.content).toBe(
			'Tool "bash" blocked by an extension: recursive force delete — list the files that would go and ask first, or delete the specific files one by one',
		);
		const refusal2 = env.requests[3]?.messages
			.flatMap((m) => (m.role === "toolResult" ? m.results : []))
			.find((r) => r.toolCallId === "g2");
		expect(refusal2?.content).toMatch(
			/^Tool "write" blocked by an extension: writing outside the project directory \(.*\) — /,
		);
		// both hazards were vetoed: the sacrificial tree still stands and the outside file never appeared
		expect(existsSync(sacrifice)).toBe(true);
		expect(existsSync(path.join(outsideDir, "imp-guardian-must-not-exist.txt"))).toBe(false);
		// audit: one line per blocked result in ~/.imp/guardian.log
		const audit = readFileSync(path.join(fakeHome, ".imp", "guardian.log"), "utf8")
			.trim()
			.split("\n");
		expect(audit).toHaveLength(2);
		expect(audit[0]).toContain("[bash]");
		expect(audit[1]).toContain("[write]");
		for (const line of audit) expect(line).toContain("blocked by an extension");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("M6a audit: a named subagent's blocked call is logged as [bash child:wrecker]", async () => {
		const fakeHome = await mkdtemp(path.join(tmpdir(), "imp-guardhome-"));
		vi.stubEnv("HOME", fakeHome);
		const env = await startRepl({
			scripts: [
				toolCall("t1", "task", { prompt: "delete the sacrifice tree", agent: "wrecker" }),
				toolCall("g1", "bash", { command: "rm -rf sacrifice" }),
				reply("child adapted"),
				reply("parent done"),
			],
			agentFiles: {
				// no `tools:` restriction — the child pool includes bash
				"wrecker.md": "---\nname: wrecker\ndescription: demolishes sacrificial trees\n---\nWreck things.",
			},
			extensionFiles: {
				"guardian.mjs": readFileSync(path.resolve("examples/extensions/guardian.mjs"), "utf8"),
			},
		});
		const sacrifice = path.join(env.cwd, "sacrifice", "nested");
		await mkdir(sacrifice, { recursive: true });
		env.send("go\n");
		await waitUntil(() => env.output().includes("parent done"));
		// the veto reached the child, and the audit line names the child
		const refusal = env.requests[2]?.messages.find((m) => m.role === "toolResult")?.results[0];
		expect(refusal?.content).toContain("blocked by an extension: recursive force delete");
		const audit = readFileSync(path.join(fakeHome, ".imp", "guardian.log"), "utf8")
			.trim()
			.split("\n");
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain("[bash child:wrecker]");
		expect(audit[0]).toContain("blocked by an extension");
		// the tree the child tried to delete still stands
		expect(existsSync(sacrifice)).toBe(true);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("IMP_GUARDIAN_BLOCK adds custom patterns with a teaching reason; invalid patterns are skipped without taking the gate down", async () => {
		const fakeHome = await mkdtemp(path.join(tmpdir(), "imp-guardhome-"));
		vi.stubEnv("HOME", fakeHome); // the blocked result triggers an audit write
		vi.stubEnv("IMP_GUARDIAN_BLOCK", "deploy-prod, ([unclosed");
		const env = await startRepl({
			scripts: [toolCall("g1", "bash", { command: "deploy-prod --yes" }), reply("adapted")],
			extensionFiles: {
				"guardian.mjs": readFileSync(path.resolve("examples/extensions/guardian.mjs"), "utf8"),
			},
		});
		env.send("ship\n");
		await waitUntil(() => env.output().includes("adapted"));
		const refusal = env.requests[1]?.messages.find((m) => m.role === "toolResult")?.results[0];
		expect(refusal?.content).toBe(
			'Tool "bash" blocked by an extension: matched your IMP_GUARDIAN_BLOCK pattern deploy-prod — adjust the env var if this should run',
		);
		// the invalid regex was skipped — the extension loaded and gated anyway
		expect(env.output()).toContain("▪ extension guardian [project] — 2 hooks");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});

describe("handler isolation through the full path (design §6.1, E10)", () => {
	it("a throwing observer (sync tool_end, rejected message_end) reports E10 lines and never breaks the run or the host", async () => {
		const executed: string[] = [];
		const probe: Tool = {
			name: "probe_tool",
			description: "records execution",
			parameters: Type.Object({ message: Type.String() }),
			async execute(args) {
				executed.push(String(args.message));
				return { output: "ran fine" };
			},
		};
		const env = await startRepl({
			tools: [probe],
			scripts: [toolCall("t1", "probe_tool", { message: "audit me" }), reply("run continued")],
			extensionFiles: {
				"crashy.mjs": `export default function (api) {
	api.on("tool_end", () => {
		throw new Error("observer exploded");
	});
	api.on("message_end", () => Promise.reject(new Error("async observer exploded")));
}
`,
			},
		});
		env.send("go\n");
		await waitUntil(() => env.output().includes("run continued"));
		// the tool ran and its result reached the model — the observer throw
		// neither vetoed the call nor broke the turn
		expect(executed).toEqual(["audit me"]);
		const result = env.requests[1]?.messages.find((m) => m.role === "toolResult")?.results[0];
		expect(result).toMatchObject({ toolCallId: "t1", content: "ran fine", isError: false });
		// both handler failures surfaced as E10 diagnostics, exactly once each
		expect(
			env.output().match(/imp: extension crashy handler error \(tool_end\) — observer exploded/g),
		).toHaveLength(1);
		expect(
			env.output().match(/imp: extension crashy handler error \(message_end\) — async observer exploded/g),
		).toHaveLength(2); // one per assistant message: the tool_use turn and the closing reply
		env.fake.eof();
		expect(await env.repl).toBe(0); // the host process is still standing
	});
});

describe("caller cwd on gate events + ui.confirm through the live REPL (spec parts 1-3)", () => {
	/** Logs one line per tool_call with its cwd — the cwd-discriminator probe. */
	const CWD_LOG_FIXTURE = `import { appendFileSync } from "node:fs";
import path from "node:path";
export default function (api) {
	const log = path.join(api.cwd, "cwd-events.jsonl");
	api.on("tool_call", (e) => {
		appendFileSync(log, JSON.stringify({ name: e.name, subagent: e.subagent ?? false, cwd: e.cwd }) + "\\n");
	});
}
`;

	it("M6b: a worktree child's tool_call carries the worktree path as cwd; the parent's carries the project cwd", async () => {
		const env = await startRepl({
			gitInit: true,
			scripts: [
				toolCall("t1", "task", { prompt: "write child-note.txt", worktree: true }),
				toolCall("w1", "write", { path: "child-note.txt", content: "child work" }),
				reply("child done"),
				reply("parent done"),
			],
			extensionFiles: { "cwdlog.mjs": CWD_LOG_FIXTURE },
		});
		env.send("delegate\n");
		await waitUntil(() => env.output().includes("parent done"));
		const events = readFileSync(path.join(env.cwd, "cwd-events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { name: string; subagent: boolean; cwd?: string });
		const taskCall = events.find((e) => e.name === "task");
		const childWrite = events.find((e) => e.name === "write");
		expect(taskCall).toMatchObject({ subagent: false, cwd: env.cwd });
		// the whole point (M6b): the child's cwd is ITS worktree, not the parent
		// project — the known guardian false positive on absolute worktree paths
		expect(childWrite).toMatchObject({ subagent: true });
		expect(childWrite?.cwd).toContain("imp-worktree-");
		expect(childWrite?.cwd).not.toBe(env.cwd);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("ui.confirm over the fake tty: y approves and the tool runs; n declines with the pre-confirm teaching text", async () => {
		const fakeHome = await mkdtemp(path.join(tmpdir(), "imp-confhome-"));
		vi.stubEnv("HOME", fakeHome); // guardian audits to ~/.imp/guardian.log — keep it hermetic
		const env = await startRepl({
			confirm: true,
			scripts: [
				toolCall("g1", "bash", { command: "rm -rf sacrifice" }),
				reply("ran the approved delete"),
				toolCall("g2", "bash", { command: "rm -rf sacrifice" }),
				reply("adapted after the decline"),
			],
			extensionFiles: {
				"guardian.mjs": readFileSync(path.resolve("examples/extensions/guardian.mjs"), "utf8"),
			},
		});
		expect(env.output()).toContain("▪ extension guardian [project] — 2 hooks");
		const sacrifice = path.join(env.cwd, "sacrifice", "nested");
		// approved: the question renders on the tty, y executes the delete
		await mkdir(sacrifice, { recursive: true });
		env.send("clean up\n");
		await waitUntil(() => env.output().includes("proceed? [y/N]"));
		env.send("y\n");
		await waitUntil(() => env.output().includes("ran the approved delete"));
		expect(existsSync(sacrifice)).toBe(false); // approved → the command really ran
		// declined: same rule, answered n → the old teaching reason reaches the model
		await mkdir(sacrifice, { recursive: true });
		env.send("clean up again\n");
		await waitUntil(() => env.output().split("[y/N]").length >= 3); // second prompt shown
		env.send("n\n");
		await waitUntil(() => env.output().includes("adapted after the decline"));
		const refusal = env.requests[3]?.messages
			.flatMap((m) => (m.role === "toolResult" ? m.results : []))
			.find((r) => r.toolCallId === "g2");
		expect(refusal?.content).toBe(
			'Tool "bash" blocked by an extension: recursive force delete — list the files that would go and ask first, or delete the specific files one by one',
		);
		expect(existsSync(sacrifice)).toBe(true); // declined → nothing deleted
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("ui.confirm over the fake tty: an outside-cwd write approved by y runs; EOF/empty answers decline", async () => {
		const fakeHome = await mkdtemp(path.join(tmpdir(), "imp-confhome-"));
		vi.stubEnv("HOME", fakeHome);
		const outsideDir = await mkdtemp(path.join(tmpdir(), "imp-confout-"));
		const env = await startRepl({
			confirm: true,
			scripts: [
				toolCall("g1", "write", { path: path.join(outsideDir, "approved.txt"), content: "yes" }),
				reply("wrote it"),
				toolCall("g2", "write", { path: path.join(outsideDir, "declined.txt"), content: "no" }),
				reply("adapted"),
			],
			extensionFiles: {
				"guardian.mjs": readFileSync(path.resolve("examples/extensions/guardian.mjs"), "utf8"),
			},
		});
		env.send("write outside\n");
		await waitUntil(() => env.output().includes("proceed? [y/N]"));
		env.send("yes\n"); // the long form approves too
		await waitUntil(() => env.output().includes("wrote it"));
		expect(readFileSync(path.join(outsideDir, "approved.txt"), "utf8")).toBe("yes");
		// empty answer = decline (the [y/N] default)
		env.send("write outside again\n");
		await waitUntil(() => env.output().split("[y/N]").length >= 3);
		env.send("\n");
		await waitUntil(() => env.output().includes("adapted"));
		const refusal = env.requests[3]?.messages
			.flatMap((m) => (m.role === "toolResult" ? m.results : []))
			.find((r) => r.toolCallId === "g2");
		expect(refusal?.content).toMatch(
			/^Tool "write" blocked by an extension: writing outside the project directory \(.*\) — /,
		);
		expect(existsSync(path.join(outsideDir, "declined.txt"))).toBe(false);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});

describe("confirm queue edge cases (M7 review: EOF crash, FIFO, Ctrl+C)", () => {
	const GUARDIAN = { "guardian.mjs": readFileSync(path.resolve("examples/extensions/guardian.mjs"), "utf8") };

	it("EOF (Ctrl+D) at a pending ask declines it and exits cleanly — no ERR_USE_AFTER_CLOSE, no lost turn", async () => {
		const fakeHome = await mkdtemp(path.join(tmpdir(), "imp-eofhome-"));
		vi.stubEnv("HOME", fakeHome);
		// The P1: settleAsk prompted the NEXT question on an interface whose
		// close event was already firing — uncaught exception, ask never
		// resolved, process died. Fix: resolve first, prompt only if live.
		const env = await startRepl({
			confirm: true,
			scripts: [
				toolCall("g1", "bash", { command: "rm -rf sacrifice" }),
				toolCall("g2", "bash", { command: "rm -rf sacrifice" }),
				reply("both declined"),
			],
			extensionFiles: GUARDIAN,
		});
		env.send("clean up\n");
		await waitUntil(() => env.output().includes("proceed? [y/N]"));
		env.fake.eof(); // Ctrl+D at the question — both asks drain as declines
		const code = await env.repl; // completing AT ALL is the regression pin
		expect(code).toBe(0);
	});

	it("FIFO: two gated calls in ONE turn queue two asks; y settles the first, n the second — no crossed answers", async () => {
		const fakeHome = await mkdtemp(path.join(tmpdir(), "imp-fifo-"));
		vi.stubEnv("HOME", fakeHome);
		const env = await startRepl({
			confirm: true,
			scripts: [
				// one assistant message, TWO tool calls — both gates fire before
				// either command runs, so both asks are pending simultaneously
				assistant(
					[
						{ type: "toolCall", id: "g1", name: "bash", arguments: { command: "rm -rf first" } },
						{ type: "toolCall", id: "g2", name: "bash", arguments: { command: "rm -rf second" } },
					],
					"tool_use",
				),
				reply("handled both"),
			],
			extensionFiles: GUARDIAN,
		});
		await mkdir(path.join(env.cwd, "first"), { recursive: true });
		await mkdir(path.join(env.cwd, "second"), { recursive: true });
		env.send("clean\n");
		await waitUntil(() => env.output().includes("proceed? [y/N]")); // first question renders
		env.send("y\n"); // approves g1 only
		await waitUntil(() => env.output().split("proceed? [y/N]").length >= 3); // second renders
		env.send("n\n"); // declines g2
		await waitUntil(() => env.output().includes("handled both"));
		expect(existsSync(path.join(env.cwd, "first"))).toBe(false); // approved → ran
		expect(existsSync(path.join(env.cwd, "second"))).toBe(true); // declined → untouched
		const results = env.requests
			.flatMap((r) => r.messages.flatMap((m) => (m.role === "toolResult" ? m.results : [])))
			.filter((r) => r.toolCallId === "g1" || r.toolCallId === "g2");
		const g2 = results.find((r) => r.toolCallId === "g2");
		expect(g2?.isError ?? (g2?.content ?? "").startsWith('Tool "bash" blocked')).toBe(true);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("terminal Ctrl+C at a pending ask declines THAT question; the run continues (single settle)", async () => {
		const fakeHome = await mkdtemp(path.join(tmpdir(), "imp-ctr-"));
		vi.stubEnv("HOME", fakeHome);
		const env = await startRepl({
			confirm: true,
			scripts: [toolCall("g1", "bash", { command: "rm -rf sacrifice" }), reply("adapted after ctrl-c")],
			extensionFiles: GUARDIAN,
		});
		env.send("clean up\n");
		await waitUntil(() => env.output().includes("proceed? [y/N]"));
		env.fake.interrupt(); // \x03 — readline raw mode routes it as SIGINT on the ask
		await waitUntil(() => env.output().includes("adapted after ctrl-c"));
		const refusal = env.requests[1]?.messages
			.flatMap((m) => (m.role === "toolResult" ? m.results : []))
			.find((r) => r.toolCallId === "g1");
		expect(refusal?.content).toContain("blocked by an extension");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});
