import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import {
	type LoadedExtensions,
	loadExtensions,
	printExtensionDiagnostics,
} from "../src/extensions/loader.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/repl/render.js";
import { runRepl } from "../src/repl/repl.js";
import { createRunner, type Runner } from "../src/runner.js";
import {
	assistant,
	type FakeConsole,
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
	extensionPaths?: string[];
	noExtensions?: boolean;
	noContextFiles?: boolean;
	agentsMd?: boolean;
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
	if (args.agentsMd) await writeFile(path.join(cwd, "AGENTS.md"), "# Test agents context\n", "utf8");

	const requests: LLMRequest[] = [];
	const provider: LLMProvider = scriptedProvider(args.scripts ?? [reply("ok")], requests);
	const fake = makeConsole({ tty: args.tty ?? true });
	const renderer = new Renderer({
		write: (text) => fake.stdout.write(text),
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
	});

	// the exact cli wiring (design §10): load → banner → createRunner
	const loaded: LoadedExtensions = await loadExtensions({
		cwd,
		cliPaths: args.extensionPaths ?? [],
		noDiscovery: args.noExtensions ?? false,
		home,
		onDiagnostic: (line) => renderer.error(line),
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
		input: fake.stdin,
		output: fake.stdout,
		interactive: args.tty ?? true,
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
			scripts: [toolCall("t1", "good_tool", {}), reply("done")],
			extensionFiles: {
				"broken.mjs": "export default function (api) {\n\tthis is not valid js\n",
				"good.mjs": `export default function (api) {
	api.registerTool({
		name: "good_tool",
		description: "the one that works",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { output: "good output" };
		},
	});
}
`,
			},
		});
		env.send("go\n");
		await waitUntil(() => env.output().includes("done"));
		expect(env.output()).toMatch(/imp: extension broken failed to load — /);
		expect(env.output()).toContain("▪ extension good [project] — 1 tool");
		// the good extension's tool executed through the scripted round-trip
		const sessionText = readFileSync(env.runner.session?.filePath as string, "utf8");
		expect(sessionText).toContain("good output");
		env.fake.eof();
		expect(await env.repl).toBe(0); // the exit path is unaffected by the failure
	});

	it("M4a stored-unconsumed: registerCommand/registerContext/on are banner-counted but not dispatched, injected, or fired", async () => {
		const env = await startRepl({
			scripts: [toolCall("t1", "tour_tool", { text: "x" }), reply("round trip done")],
			extensionFiles: {
				"tour.mjs": `import { writeFileSync } from "node:fs";
import path from "node:path";
export default function (api) {
	api.registerTool({
		name: "tour_tool",
		description: "the only live contribution in M4a",
		parameters: { type: "object", properties: { text: { type: "string" } } },
		async execute(args) {
			return { output: "tour:" + String(args.text) };
		},
	});
	api.registerCommand({
		name: "tourcmd",
		summary: "stored until M4b",
		allowedDuringRun: true,
		run(_args, ctx) {
			ctx.renderer.note("should not dispatch in M4a");
			return "handled";
		},
	});
	api.registerContext("tour", "Tour context (M4c injects this)");
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
		// the stored command is NOT dispatched: unknown-command lists built-ins only
		env.send("/tourcmd hello\n");
		await waitUntil(() => env.output().includes('imp: unknown command "/tourcmd"'));
		expect(env.output()).toContain("known: /help /exit /new /model /compact — /help shows what they do");
		// the stored context is NOT injected into the system prompt
		expect(env.requests[0]?.system).not.toContain("# Extension context:");
		// the stored on() handler never fired (no emitter exists in M4a)
		expect(existsSync(path.join(env.cwd, "observer-fired.txt"))).toBe(false);
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
