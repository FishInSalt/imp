import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import {
	type LoadedExtensions,
	loadExtensions,
	printExtensionDiagnostics,
} from "../src/extensions/loader.js";
import type { LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
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

// Full-path harness for the real contributed extensions (the case-9 pattern:
// real example files, real dynamic import, real cli wiring, scripted turns).

const reply = (text: string): AssistantMessage => assistant([{ type: "text", text }]);
const toolCall = (id: string, name: string, args: Record<string, unknown>): ScriptStep =>
	assistant([{ type: "toolCall", id, name, arguments: args }], "tool_use");

const example = (name: string): string => readFileSync(path.resolve("examples/extensions", name), "utf8");

interface Env {
	cwd: string;
	baseDir: string;
	fake: FakeConsole;
	runner: Runner;
	repl: Promise<number>;
	requests: LLMRequest[];
	send(text: string): void;
	output(): string;
	sessionText(): string;
}

interface StartArgs {
	scripts?: ScriptStep[];
	extensionFiles?: Record<string, string>;
	/** Applied (stubbed) after the temp dir exists, before extensions load. */
	env?: (baseDir: string) => Record<string, string>;
}

async function startRepl(args: StartArgs): Promise<Env> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-contrib-"));
	const cwd = path.join(baseDir, "proj");
	const home = path.join(baseDir, "home");
	await mkdir(cwd, { recursive: true });
	if (args.extensionFiles) await writeExtensionFiles(cwd, args.extensionFiles);
	for (const [k, v] of Object.entries(args.env?.(baseDir) ?? {})) vi.stubEnv(k, v);

	const requests: LLMRequest[] = [];
	const provider = scriptedProvider(args.scripts ?? [reply("ok")], requests);
	const fake = makeConsole({ tty: true });
	const renderer = new Renderer({
		write: (t) => fake.stdout.write(t),
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
	});
	const loaded: LoadedExtensions = await loadExtensions({
		cwd,
		cliPaths: [],
		noDiscovery: false,
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
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: baseDir,
		renderer,
		provider,
		deferInit: false,
		extensions: loaded.runtime,
		extensionFailures: loaded.failures,
	});
	const repl = runRepl({
		runner,
		commands: loaded.runtime.commands,
		input: fake.stdin,
		output: fake.stdout,
		interactive: true,
		exit: (code) => {
			throw new Error(`force-exit:${code}`);
		},
	});
	await ticks(2);
	return {
		cwd,
		baseDir,
		fake,
		runner,
		repl,
		requests,
		send: (t) => fake.send(t),
		output: () => fake.output(),
		sessionText: () => readFileSync(runner.session?.filePath as string, "utf8"),
	};
}

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("notify.mjs (run_end → sound + popup, dry-tested)", () => {
	it("notifies for runs past the threshold; entry carries turns and stopReason", async () => {
		const env = await startRepl({
			scripts: [reply("done")],
			extensionFiles: { "notify.mjs": example("notify.mjs") },
			env: (base) => ({ IMP_NOTIFY_MIN_SEC: "0", IMP_NOTIFY_DRY: path.join(base, "notify.jsonl") }),
		});
		expect(env.output()).toContain("▪ extension notify [project] — 2 hooks");
		env.send("hi\n");
		await waitUntil(() => env.output().includes("done"));
		const dry = path.join(env.baseDir, "notify.jsonl");
		await waitUntil(() => existsSync(dry));
		const entries = readFileSync(dry, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(entries.length).toBe(1);
		expect(entries[0].title).toBe("imp — completed");
		expect(entries[0].body).toContain("1 turns");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("stays silent for quick runs under the threshold", async () => {
		const env = await startRepl({
			scripts: [reply("quick")],
			extensionFiles: { "notify.mjs": example("notify.mjs") },
			env: (base) => ({ IMP_NOTIFY_MIN_SEC: "999", IMP_NOTIFY_DRY: path.join(base, "notify.jsonl") }),
		});
		env.send("hi\n");
		await waitUntil(() => env.output().includes("quick"));
		await ticks(12);
		expect(existsSync(path.join(env.baseDir, "notify.jsonl"))).toBe(false);
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("resets per run: two turns produce two entries", async () => {
		const env = await startRepl({
			scripts: [reply("one"), reply("two")],
			extensionFiles: { "notify.mjs": example("notify.mjs") },
			env: (base) => ({ IMP_NOTIFY_MIN_SEC: "0", IMP_NOTIFY_DRY: path.join(base, "notify.jsonl") }),
		});
		env.send("hi\n");
		await waitUntil(() => env.output().includes("one"));
		env.send("hi again\n");
		await waitUntil(() => env.output().includes("two"));
		const dry = path.join(env.baseDir, "notify.jsonl");
		await waitUntil(() => {
			if (!existsSync(dry)) return false;
			return readFileSync(dry, "utf8").trim().split("\n").length >= 2;
		});
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});

describe("web_search.mjs (Tavily search + page reader, fetch stubbed)", () => {
	it("no key → keyless mode: x-tavily-access-mode header, no bearer, results still returned", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [{ title: "Keyless hit", url: "https://example.com/k", content: "kc" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const env = await startRepl({
			scripts: [toolCall("t1", "web_search", { query: "imp agent" }), reply("got it")],
			extensionFiles: { "web_search.mjs": example("web_search.mjs") },
			env: () => ({ IMP_TAVILY_KEY: "" }),
		});
		expect(env.output()).toContain("▪ extension web_search [project] — 2 tools");
		env.send("search something\n");
		await waitUntil(() => env.output().includes("got it"));
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.tavily.com/search");
		const headers = init.headers as Record<string, string>;
		expect(headers["x-tavily-access-mode"]).toBe("keyless");
		expect(headers.authorization).toBeUndefined();
		expect(env.sessionText()).toContain("[1] Keyless hit");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("happy path: request shape + formatted citations reach the model", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					answer: "imp is a minimal coding agent",
					results: [{ title: "Imp repo", url: "https://example.com/imp", content: "the C1 snippet" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const env = await startRepl({
			scripts: [toolCall("t1", "web_search", { query: "what is imp", max_results: 3 }), reply("summarized")],
			extensionFiles: { "web_search.mjs": example("web_search.mjs") },
			env: () => ({ IMP_TAVILY_KEY: "test-key" }),
		});
		env.send("search\n");
		await waitUntil(() => env.output().includes("summarized"));
		// request shape: URL, bearer key, body carries query and clamped max
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.tavily.com/search");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
		const body = JSON.parse(String(init.body)) as { query: string; max_results: number };
		expect(body).toEqual({ query: "what is imp", max_results: 3 });
		// the formatted result (answer + citation) is persisted for the model
		expect(env.sessionText()).toContain("Answer: imp is a minimal coding agent");
		expect(env.sessionText()).toContain("[1] Imp repo");
		expect(env.sessionText()).toContain("https://example.com/imp");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("filters + full: days/topic, include_domains, include_raw_content pass through and render", async () => {
		const raw = "R".repeat(4000); // exceeds the 3KB per-result cap
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ title: "Fresh doc", url: "https://docs.example.com/x", content: "c", raw_content: raw },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const env = await startRepl({
			scripts: [
				toolCall("t1", "web_search", {
					query: "recent release",
					days: 7,
					include_domains: ["docs.example.com"],
					full: true,
				}),
				reply("done"),
			],
			extensionFiles: { "web_search.mjs": example("web_search.mjs") },
			env: () => ({ IMP_TAVILY_KEY: "test-key" }),
		});
		env.send("search\n");
		await waitUntil(() => env.output().includes("done"));
		const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		expect(body).toEqual({
			query: "recent release",
			max_results: 5,
			topic: "news",
			days: 7,
			include_domains: ["docs.example.com"],
			include_raw_content: true,
		});
		const session = env.sessionText();
		expect(session).toContain("<content>"); // full mode renders the raw block
		expect(session).toContain("Fresh doc");
		// per-result cap: 4000 chars of raw → at most 3000 rendered
		expect(session).not.toContain("R".repeat(3001));
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("session cache: identical repeated queries hit the network once", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ results: [{ title: "Cached hit", url: "https://example.com/c", content: "cc" }] }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const env = await startRepl({
			scripts: [
				toolCall("t1", "web_search", { query: "same question" }),
				reply("first"),
				toolCall("t2", "web_search", { query: "same question" }),
				reply("second"),
			],
			extensionFiles: { "web_search.mjs": example("web_search.mjs") },
			env: () => ({ IMP_TAVILY_KEY: "test-key" }),
		});
		env.send("go\n");
		await waitUntil(() => env.output().includes("first"));
		env.send("go again\n");
		await waitUntil(() => env.output().includes("second"));
		expect(fetchMock).toHaveBeenCalledTimes(1); // second turn served from cache
		expect(env.sessionText().match(/Cached hit/g)?.length).toBe(2); // both turns got the result
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("HTTP 401 → teaching hint to check the key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 401, statusText: "Unauthorized" })),
		);
		const env = await startRepl({
			scripts: [toolCall("t1", "web_search", { query: "x" }), reply("ok")],
			extensionFiles: { "web_search.mjs": example("web_search.mjs") },
			env: () => ({ IMP_TAVILY_KEY: "bad-key" }),
		});
		env.send("search\n");
		await waitUntil(() => env.output().includes("ok"));
		expect(env.sessionText()).toContain("401");
		expect(env.sessionText()).toContain("check IMP_TAVILY_KEY");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("url_read: html → readable text (scripts/styles stripped, entities decoded)", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(
						'<html><head><script>evil()</script><style>.x{}</style></head><body><h1>Title</h1><p>Hello&nbsp;world</p><a href="x">link</a></body></html>',
						{ status: 200, headers: { "content-type": "text/html" } },
					),
				),
		);
		const env = await startRepl({
			scripts: [toolCall("t1", "url_read", { url: "https://example.com/page" }), reply("read it")],
			extensionFiles: { "web_search.mjs": example("web_search.mjs") },
		});
		env.send("read that page\n");
		await waitUntil(() => env.output().includes("read it"));
		const session = env.sessionText();
		expect(session).toContain("Title");
		expect(session).toContain("Hello world");
		expect(session).not.toContain("evil()");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});

	it("url_read rejects non-http URLs and binaries with teaching errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }),
				),
		);
		const env = await startRepl({
			scripts: [
				toolCall("t1", "url_read", { url: "ftp://example.com/x" }),
				reply("r1"),
				toolCall("t2", "url_read", { url: "https://example.com/doc.pdf" }),
				reply("r2"),
			],
			extensionFiles: { "web_search.mjs": example("web_search.mjs") },
		});
		env.send("go\n");
		await waitUntil(() => env.output().includes("r1"));
		env.send("go again\n");
		await waitUntil(() => env.output().includes("r2"));
		expect(env.sessionText()).toContain("needs an absolute http(s) URL");
		expect(env.sessionText()).toContain("unsupported content-type");
		env.fake.eof();
		expect(await env.repl).toBe(0);
	});
});
