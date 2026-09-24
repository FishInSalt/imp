import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, utimes } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPrompt } from "../src/core/commands-md.js";
import type { AgentMessage, UserMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { loadSettings } from "../src/core/settings.js";
import { setTrust } from "../src/core/trust.js";
import { clearApiKey, loadApiKey, saveApiKey } from "../src/provider/auth-store.js";
import { loadCodexCredential } from "../src/provider/codex-auth.js";
import { familyConfigured } from "../src/provider/discover.js";
import { parseModelRef } from "../src/provider/resolve.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import type { CommandContext } from "../src/repl/commands.js";
import { dispatchCommand, helpText, loginNeedsGuard, parseCommand } from "../src/repl/commands.js";
import { buildTreeRows } from "../src/repl/components/tree-selector.js";
import type { SelectOptions } from "../src/repl/line-input.js";
import { createRunner, type Runner } from "../src/runner.js";
import { assistant, gate, makeRenderer, scriptedProvider, user } from "./helpers/fakes.js";

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

const userMsg = (content: string): AgentMessage => ({ role: "user", content });
const assistantText = (text: string, inputTokens = 100): AgentMessage => ({
	role: "assistant",
	blocks: [{ type: "text", text }],
	usage: { inputTokens, outputTokens: 20 },
	stopReason: "end_turn",
});

interface TestEnv {
	replayed: string[];
	/** submitPrompt recorder (M11 #6 md commands). */
	submitted: string[];
	/** Hermetic test paths (create extra sessions with these). */
	cwd: string;
	baseDir: string;
	settingsPath: string;
	runner: Runner;
	ctx: CommandContext;
	output(): string;
	requests: LLMRequest[];
	exitCodes: number[];
	aborted: boolean;
	/** Hermetic M8 trust store (create records with setTrust from trust.ts). */
	trustStore: string;
}

/** Minimal git repo with one imp-style child worktree on its own branch. */
async function makeGitRepo(args?: {
	noChild?: boolean;
	/** Create the worktree but make no commit in it (branch tip == base). */
	noChildCommit?: boolean;
	/** Name of the repo directory (default "repo"). */
	repoDirName?: string;
}): Promise<{
	root: string;
	path: string;
	branch: string;
}> {
	const base = await mkdtemp(path.join(tmpdir(), "imp-wtlist-"));
	const root = path.join(base, args?.repoDirName ?? "repo");
	mkdirSync(root, { recursive: true });
	const run = (cmd: string[], cwd: string) => execFileSync("git", cmd, { cwd, encoding: "utf8" });
	run(["init", "-q", "-b", "main"], root);
	run(["config", "user.email", "t@example.com"], root);
	run(["config", "user.name", "t"], root);
	writeFileSync(path.join(root, "a.txt"), "base\n");
	run(["add", "."], root);
	run(["commit", "-q", "-m", "base"], root);
	if (args?.noChild === true) return { root, path: "", branch: "" };
	const wtPath = path.join(base, "imp-worktree-task-test01");
	const branch = "imp/task-test01";
	run(["worktree", "add", wtPath, "-b", branch], root);
	if (args?.noChildCommit === true) return { root, path: wtPath, branch };
	// the handback shape that matters: committed work the parent has NOT merged
	writeFileSync(path.join(wtPath, "b.txt"), "child change\n");
	run(["add", "."], wtPath);
	run(["commit", "-q", "-m", "child"], wtPath);
	return { root, path: wtPath, branch };
}

/** A local fake of auth.openai.com's device-code endpoints for /login's
 *  OAuth path (batch B). Default script: one pending poll, then success —
 *  { hang: true } polls forever (cancellation tests). */
async function fakeCodexAuth(options?: {
	hang?: boolean;
	/** Delay the usercode response — the abort-DURING-fetch window (P2). */
	delayUserCodeMs?: number;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const jwt = (acct: string) =>
		`${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: acct } })}.sig`;
	let polls = 0;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			const json = (status: number, payload: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/api/accounts/deviceauth/usercode") {
				const reply = () => json(200, { device_auth_id: "dev-login", user_code: "WXYZ-6789", interval: 0 });
				if (options?.delayUserCodeMs !== undefined) setTimeout(reply, options.delayUserCodeMs);
				else reply();
				return;
			}
			if (req.url === "/api/accounts/deviceauth/token") {
				polls++;
				if (options?.hang !== true && polls >= 2) {
					json(200, { authorization_code: "ac-login", code_verifier: "cv-login" });
				} else {
					json(403, {});
				}
				return;
			}
			if (req.url === "/oauth/token") {
				json(200, {
					access_token: jwt("acct-login"),
					refresh_token: "rt-login",
					expires_in: 3600,
				});
				return;
			}
			json(404, {});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function makeEnv(args?: {
	seed?: AgentMessage[];
	noSession?: boolean;
	active?: boolean;
	provider?: LLMProvider;
	model?: string;
	/** Trust the project dir — project settings participate (batch B P2-2). */
	trusted?: boolean;
}): Promise<TestEnv> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-cmds-"));
	const settingsPath = path.join(baseDir, "settings.json");
	const cwd = path.join(baseDir, "proj");
	const requests: LLMRequest[] = [];
	const { renderer, output } = makeRenderer();
	let store = null as ReturnType<typeof createSession> | null;
	if (!args?.noSession) {
		store = createSession(cwd, baseDir);
		for (const message of args?.seed ?? []) store.appendMessage(message);
	}
	const runner = await createRunner({
		cwd,
		argv: [],
		settingsPath,
		projectSettingsAllowed: args?.trusted === true,
		model: args?.model ?? "claude-sonnet-4-5",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: args?.noSession ?? false,
		resume: store ? store.header.id : undefined,
		sessionBaseDir: baseDir,
		renderer,
		provider: args?.provider ?? scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests),
	});
	const replayed: string[] = [];
	const submitted: string[] = [];
	const exitCodes: number[] = [];
	const authStore = path.join(baseDir, "auth.json");
	const banner = output(); // ▪ resumed … line from seeding, if any
	const trustStore = path.join(baseDir, "trust.json");
	const env: TestEnv = {
		cwd,
		baseDir,
		settingsPath,
		runner,
		trustStore,
		output: () => output().slice(banner.length),
		requests,
		exitCodes,
		replayed: [],
		submitted,
		aborted: false,
		ctx: {
			runner,
			renderer,
			isActive: () => args?.active ?? false,
			requestExit: (code) => exitCodes.push(code),
			abortActive: () => {
				env.aborted = true;
				return true;
			},
			replay: (session) => {
				replayed.push(session.header.id);
				return session.stats().messageCount;
			},
			submitPrompt: (text: string) => {
				submitted.push(text);
			},
			trustStorePath: trustStore,
			authStorePath: authStore,
		},
	};
	(env as { replayed: string[] }).replayed = replayed;
	return env;
}

describe("parseCommand", () => {
	it("parses /model glm-4.6 extra, bare /, and rejects non-slash lines", () => {
		expect(parseCommand("/model glm-4.6 extra")).toEqual({ name: "model", args: "glm-4.6 extra" });
		expect(parseCommand("/")).toEqual({ name: "", args: "" });
		expect(parseCommand("/exit")).toEqual({ name: "exit", args: "" });
		expect(parseCommand(" /foo")).toBeNull(); // leading space → plain text for the model
		expect(parseCommand("hello")).toBeNull();
	});
});

describe("slash commands", () => {
	// Hermetic picker (#model-discovery): the /model list depends on which
	// families hold credentials — pin the test env to "nothing configured"
	// (IMP_AUTH_PATH to a nonexistent file; no provider keys).
	const SAVED: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of [
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_BASE_URL",
			"OPENAI_API_KEY",
			"OPENAI_BASE_URL",
			"IMP_AUTH_PATH",
		]) {
			SAVED[key] = process.env[key];
			delete process.env[key];
		}
		process.env.IMP_AUTH_PATH = "/nonexistent-imp-auth.json";
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(SAVED)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	it("/help lists all seven (generated, cannot drift)", async () => {
		const env = await makeEnv();
		await dispatchCommand("/help", env.ctx);
		const text = env.output();
		for (const label of [
			"/help",
			"/exit",
			"/new",
			"/sessions",
			"/resume <id>",
			"/model [id]",
			"/think [level]",
			"/worktrees",
			"/trust",
			"/compact",
		]) {
			expect(text).toContain(label);
		}
		expect(text).toContain("Ctrl+C");
		expect(text).toContain("Lines typed while imp is working are queued");
	});

	it("no-extras /help body is byte-pinned (review P3-1): M4b's extras plumbing cannot drift the built-in rendering", () => {
		// Golden literal — update CONSCIOUSLY if help content ever changes;
		// this is the drift lock the M4b review asked for.
		expect(helpText()).toBe(
			[
				"Commands:",
				"  /help              show this help",
				"  /exit              exit (Ctrl+D works too)",
				"  /new               start a fresh session (the old one stays on disk)",
				"  /fork              branch the conversation before an earlier message (the old branch stays)",
				"  /tree              navigate the session tree — jump to any point, optionally summarizing the left branch",
				"  /sessions          list saved sessions for this directory",
				"  /resume <id>       switch to a saved session (history replays on screen)",
				"  /model [id]        show the current model, or switch (applies next turn)",
				"  /login [provider]  sign in to a provider (stored credential beats the env var)",
				"  /logout            remove a stored credential (environment variables stay)",
				"  /think [level]     show or set the thinking level; no argument cycles (shift+tab)",
				"  /worktrees         list worktrees kept for a manual merge (M6b handbacks)",
				"  /trust             show the project-trust decision for this directory (and all records)",
				"  /status            session, model, context, and trust at a glance",
				"  /mcp               show MCP server connections and tool counts",
				"  /settings [key]    view or change settings (scope: global|project)",
				"  /copy              copy the last agent message to the clipboard",
				"  /name              name this session (shows in /sessions)",
				"  /compact           summarize older context now",
				"",
				"",
				"Keys:",
				"  Ctrl+C             abort the running turn (press twice to force quit);",
				"                     at an empty prompt: press twice to exit",
				"  Esc                abort the running turn (same as Ctrl+C); with the",
				"                     autocomplete panel open, one Esc closes the panel only",
				"  Ctrl+D             exit",
				"  Ctrl+O             expand/collapse all folds (results, errors, diffs)",
				"  Shift+Tab          cycle the thinking level (models with thinking)",
				"  Ctrl+T             hide/show reasoning traces (pi's toggle, persisted)",
				"  newline            Shift+Enter · Ctrl+J · backslash at end of line + Enter",
				"  follow-up          Alt+Enter queues the line for the SAME run — consumed",
				"                     when the model would stop, one per answer (Enter steers into",
				"                     the next model call instead)",
				"  queued input       Alt+Up (or Esc,p — works without the Kitty protocol)",
				"                     pulls all queued lines back into the editor; Ctrl+C",
				"                     abort hands them back the same way — never dropped",
				"  ! prefix           run a shell command directly — e.g. ! ls -la",
				"  autocomplete (/ commands · @ files):",
				"    ↑/↓              move the selection",
				"    Tab / Enter      complete — Enter on a command completes and runs it",
				"    Esc              close the panel",
				"  while a picker is open:",
				"    ↑/↓              move the selection",
				"    Enter            pick · Esc or Ctrl+C cancels (no interrupt)",
				"    typing           filters the list (/resume — Enter picks the original row)",
				"  while a question is pending (/login keys, confirms):",
				"    Enter            submits the answer · Esc or Ctrl+C cancels",
				"",
				"Lines typed while imp is working are queued and injected when the current turn ends.",
			].join("\n"),
		);
	});

	it("/model without args prints current model + usage; with an id it switches (next run)", async () => {
		const env = await makeEnv();
		await dispatchCommand("/model", env.ctx);
		expect(env.output()).toBe(
			"model: claude-sonnet-4-5\n" +
				"switch with: /model <id> — e.g. claude-sonnet-4-5, zai/glm-5.3 (any id your endpoint accepts)\n",
		);
		// the "switch takes effect next run" leg runs FIRST (same family —
		// the fake provider survives; a zai swap would construct the real one)
		await dispatchCommand("/model claude-opus-4-6", env.ctx);
		expect(env.output()).toContain("Model: claude-opus-4-6\n");
		const result = await env.runner.runTurn({ userMessage: "hi" });
		expect(env.requests[0]?.model).toBe("claude-opus-4-6");
		expect(result.stopReason).toBe("completed");
		// #glm-retire: bare glm routes to zai UNCONDITIONALLY — canonical
		// display, plus the sign-in teaching when no credential is present
		const prevZai = process.env.ZAI_API_KEY; // keep the dev shell out of the teaching leg
		delete process.env.ZAI_API_KEY;
		await dispatchCommand("/model glm-4.6", env.ctx);
		if (prevZai !== undefined) process.env.ZAI_API_KEY = prevZai;
		expect(env.output()).toContain("Model: zai/glm-4.6\n");
		expect(env.output()).toContain("sign in with /login zai");
		expect(env.runner.model).toBe("glm-4.6");
		expect(env.runner.providerName).toBe("zai");
	});

	it("HELP_KEYS documents the M10 affordances: Esc interrupt, newline keys, ! prefix, autocomplete keys", () => {
		const text = helpText();
		for (const line of [
			"  Esc                abort the running turn (same as Ctrl+C); with the",
			"  newline            Shift+Enter · Ctrl+J · backslash at end of line + Enter",
			"  follow-up          Alt+Enter queues the line for the SAME run — consumed",
			"  queued input       Alt+Up (or Esc,p — works without the Kitty protocol)",
			"  ! prefix           run a shell command directly — e.g. ! ls -la",
			"  autocomplete (/ commands · @ files):",
			"    Tab / Enter      complete — Enter on a command completes and runs it",
			"    Esc              close the panel",
		]) {
			expect(text).toContain(line);
		}
	});

	it("regression m3: /model rejects extra text after the id instead of setting a broken id", async () => {
		const env = await makeEnv();
		await expect(dispatchCommand("/model glm-4.6 extra", env.ctx)).rejects.toThrow(/takes one id/);
		expect(env.runner.model).toBe("claude-sonnet-4-5"); // unchanged — no delayed 404 next turn
	});

	it("M9-2: /model without args uses ctx.select when present — a pick switches like /model <id>", async () => {
		const env = await makeEnv();
		const calls: Array<{ title?: string; items: Array<{ label: string; description?: string }> }> = [];
		env.ctx.select = async (options) => {
			calls.push(options);
			return options.items.findIndex((item) => item.label === "zai/glm-5.3");
		};
		await dispatchCommand("/model", env.ctx);
		expect(calls).toHaveLength(1);
		const labels = calls[0]?.items.map((item) => item.label);
		expect(labels).toEqual([
			"claude-sonnet-4-5",
			"zai/glm-5.3",
			"zai/glm-5.3-highspeed",
			"zai/glm-4.7",
			"openai-codex/gpt-5.5",
			"openai/gpt-5.2",
		]); // v1 candidates — GLM is zai-canonical (pi parity)
		expect(calls[0]?.title).toContain("model");
		expect(env.runner.model).toBe("glm-5.3"); // the family strips the prefix
		// #glm-retire: with no zai credential the sign-in teaching precedes
		// the switch line (a stored /login key or ZAI_API_KEY silences it)
		expect(env.output()).toContain("is a Z.ai model — sign in with /login zai");
		expect(env.output()).toContain("Model: zai/glm-5.3\n"); // the zai prefix IS the connection tell
	});

	it("M9-2: a custom current model leads the candidate list (it must stay pickable)", async () => {
		const env = await makeEnv();
		env.runner.model = "my-own-model";
		let labels: string[] | undefined;
		env.ctx.select = async (options) => {
			labels = options.items.map((item) => item.label);
			return 0; // pick the custom id itself
		};
		await dispatchCommand("/model", env.ctx);
		expect(labels?.[0]).toBe("my-own-model");
		expect(env.runner.model).toBe("my-own-model");
		expect(env.output()).toBe("Model: my-own-model\n"); // identical to /model <id> on the same id
	});

	it("M9-2: a cancelled selector changes nothing and notes nothing", async () => {
		const env = await makeEnv();
		env.ctx.select = async () => null;
		await dispatchCommand("/model", env.ctx);
		expect(env.runner.model).toBe("claude-sonnet-4-5");
		expect(env.output()).toBe("");
	});

	it("M9-2: without ctx.select the legacy text path prints, byte-for-byte", async () => {
		const env = await makeEnv();
		expect(env.ctx.select).toBeUndefined(); // the readline shell wires no picker
		await dispatchCommand("/model", env.ctx);
		expect(env.output()).toBe(
			"model: claude-sonnet-4-5\n" +
				"switch with: /model <id> — e.g. claude-sonnet-4-5, zai/glm-5.3 (any id your endpoint accepts)\n",
		);
	});

	it("/new swaps the session, empties history, keeps the old file, prints the banner", async () => {
		const env = await makeEnv({ seed: [userMsg("q"), assistantText("a")] });
		const oldId8 = env.runner.session?.header.id.slice(0, 8);
		const oldPath = env.runner.session?.filePath;
		await dispatchCommand("/new", env.ctx);
		const newId8 = env.runner.session?.header.id.slice(0, 8);
		expect(newId8).not.toBe(oldId8);
		expect(env.runner.history).toHaveLength(0);
		expect(env.output()).toBe(`▪ new session ${newId8} — previous ${oldId8} saved (imp -r ${oldId8})\n`);
		// old session file still on disk, append-only
		const { readFileSync } = await import("node:fs");
		const lines = readFileSync(oldPath as string, "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(3);
	});

	it("/new during a run is rejected with a teaching line", async () => {
		const env = await makeEnv({ active: true });
		await dispatchCommand("/new", env.ctx);
		expect(env.output()).toBe(
			"imp: /new waits for the running turn — press Ctrl+C to abort it first, then /new\n",
		);
	});

	it("/compact compacts via the fake summarizer; nothing-to-compact; active & no-session rejections", async () => {
		// enough content that the retained-tail window leaves something to summarize
		const seed: AgentMessage[] = [];
		for (let i = 0; i < 6; i++) {
			seed.push(userMsg(`question ${i} ${"x".repeat(20000)}`));
			seed.push(assistantText(`answer ${i} ${"y".repeat(20000)}`));
		}
		const env = await makeEnv({ seed });
		await dispatchCommand("/compact", env.ctx);
		expect(env.output()).toContain("▪ compacting…\n");
		expect(env.output()).toMatch(
			/▪ compacted: ~[\d.]+[k]? → ~[\d.]+[k]? tokens \(\d+ msgs kept verbatim\)\n/,
		);
		const roles = env.runner.history.map((m) => m.role);
		expect(roles[0]).toBe("user"); // summary message
		expect(roles).toHaveLength(5); // summary + 4-msg retained tail (per the banner)

		// a manual compact of an already-tight context is a no-op, not an error
		const tight = await makeEnv({ seed: [userMsg("small"), assistantText("reply")] });
		await dispatchCommand("/compact", tight.ctx);
		expect(tight.output()).toContain("▪ compacting…\n");
		expect(tight.output()).toContain("▪ nothing safe to compact yet — continuing\n");

		// rejected while a run is active
		const active = await makeEnv({ seed, active: true });
		await dispatchCommand("/compact", active.ctx);
		expect(active.output()).toBe(
			"imp: /compact waits for the running turn — press Ctrl+C to abort it first, then /compact\n",
		);

		// rejected without a session
		const stateless = await makeEnv({ noSession: true });
		await dispatchCommand("/compact", stateless.ctx);
		expect(stateless.output()).toBe("imp: /compact needs a session — restart without --no-session\n");
	});

	it("unknown /foo teaches; the provider is never called", async () => {
		const env = await makeEnv();
		await dispatchCommand("/foo", env.ctx);
		expect(env.output()).toBe(
			'imp: unknown command "/foo"\n' +
				"known: /help /exit /new /fork /tree /sessions /resume /model /login /logout /think /worktrees /trust /status /mcp /settings /copy /name /compact — /help shows what they do\n",
		);
		expect(env.requests).toHaveLength(0);
		// bare "/" gets the same teaching error with the empty name
		const bare = await makeEnv();
		await dispatchCommand("/", bare.ctx);
		expect(bare.output()).toContain('imp: unknown command "/"\n');
		expect(bare.requests).toHaveLength(0);
	});
});

describe("/copy and /name (M16)", () => {
	it("/copy: no agent messages yet teaches instead of erroring", async () => {
		const env = await makeEnv();
		await dispatchCommand("/copy", env.ctx);
		expect(env.output()).toContain("No agent messages to copy yet");
		expect(env.requests).toHaveLength(0);
	});

	it("/copy: copies the LAST assistant text through the injected writer; tool-only turns are skipped", async () => {
		const env = await makeEnv({
			seed: [
				user("do it"),
				assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }]),
				assistant([{ type: "text", text: "the answer" }]),
				assistant([{ type: "thinking", thinking: "hmm" }]),
			],
		});
		const copied: string[] = [];
		(env.ctx as { copyText?: (t: string) => Promise<void> }).copyText = async (t) => {
			copied.push(t);
		};
		await dispatchCommand("/copy", env.ctx);
		expect(copied).toEqual(["the answer"]);
		expect(env.output()).toContain("Copied last agent message to clipboard");
	});

	it("/copy: writer failure surfaces the error, never a fake success", async () => {
		const env = await makeEnv({ seed: [user("hi"), assistant([{ type: "text", text: "boomable" }])] });
		(env.ctx as { copyText?: (t: string) => Promise<void> }).copyText = async () => {
			throw new Error("no clipboard writer available");
		};
		await dispatchCommand("/copy", env.ctx);
		expect(env.output()).toContain("no clipboard writer available");
		expect(env.output()).not.toContain("Copied");
	});

	it("/name: set → status line; /name shows it; sessions list titles by it; /status carries it", async () => {
		const env = await makeEnv({ seed: [user("hello")] });
		await dispatchCommand("/name fix the parser", env.ctx);
		expect(env.output()).toContain("Session name set: fix the parser");
		await dispatchCommand("/name", env.ctx);
		expect(env.output()).toContain("session name: fix the parser");
		const listing = env.runner.listSessions();
		expect(listing[0]?.title).toBe("fix the parser");
		await dispatchCommand("/status", env.ctx);
		expect(env.output()).toContain("· fix the parser");
	});

	it("/name: newlines collapse to one space AND THE WARNING SAYS SO (M16 review P1-2)", async () => {
		const env = await makeEnv({ seed: [user("hello")] });
		await dispatchCommand("/name two\nlines", env.ctx);
		expect(env.output()).toContain("Session name set: two lines");
		expect(env.output()).toContain("newlines collapsed: two lines");
	});

	it("/name -: clears the name — the store's empty semantic gets an affordance (M16 review P1-3)", async () => {
		const env = await makeEnv({ seed: [user("hello")] });
		await dispatchCommand("/name temporary", env.ctx);
		await dispatchCommand("/name -", env.ctx);
		expect(env.output()).toContain("Session name cleared");
		expect(env.runner.session?.getSessionName()).toBeUndefined();
		expect(env.runner.listSessions()[0]?.title).not.toBe("temporary");
	});

	it("/name: needs a session (the --no-session boot)", async () => {
		const env = await makeEnv({ noSession: true });
		await dispatchCommand("/name anything", env.ctx);
		expect(env.output()).toContain("/name needs a session");
	});
});

describe("/worktrees (M6b §7 follow-up)", () => {
	it("outside a git repository: the teaching error, not a stack", async () => {
		const env = await makeEnv();
		const scratch = mkdtempSync(path.join(tmpdir(), "imp-nowt-"));
		env.ctx.worktreeCwd = scratch;
		await dispatchCommand("/worktrees", env.ctx); // awaited command: output complete on return (M8 review F5)
		expect(env.output()).toContain("worktree isolation requires a git repository");
	});

	it("lists kept handbacks; after an ff-merge the advice flips to safe-to-delete and the merge note is gone", async () => {
		const env = await makeEnv();
		const repo = await makeGitRepo(); // helper: init, commit, child worktree with one commit
		env.ctx.worktreeCwd = repo.root;
		await dispatchCommand("/worktrees", env.ctx);
		const out = env.output();
		expect(out).toContain(repo.branch); // imp/task-*
		expect(out).toContain(repo.path); // the worktree path line
		expect(out).toContain("1 file changed");
		expect(out).toContain("git merge imp/task-");
		expect(out).not.toContain("safe to delete");
		const first = env.output().length;
		execFileSync("git", ["merge", "--ff-only", repo.branch], { cwd: repo.root });
		await dispatchCommand("/worktrees", env.ctx);
		const second = env.output().slice(first); // second dispatch only
		expect(second).toContain("merged — safe to delete");
		expect(second).not.toContain("git merge imp/task-");
	});

	it("M8 review P1: merged + uncommitted work must NOT say safe to delete", async () => {
		const env = await makeEnv();
		const repo = await makeGitRepo(); // branch tip == one commit ahead
		execFileSync("git", ["merge", "--ff-only", repo.branch], { cwd: repo.root });
		writeFileSync(path.join(repo.path, "dirty.txt"), "uncommitted output\n");
		writeFileSync(path.join(repo.path, "orphan.txt"), "untracked output\n");
		env.ctx.worktreeCwd = repo.root;
		await dispatchCommand("/worktrees", env.ctx);
		const out = env.output();
		expect(out).toContain("merged, but uncommitted work remains:");
		expect(out).toContain("untracked: dirty.txt, orphan.txt");
		expect(out).not.toContain("merged — safe to delete");
	});

	it("M8 review P1-b2: untracked-only handback (branch never diverged) still shows the work", async () => {
		const env = await makeEnv();
		const repo = await makeGitRepo({ noChildCommit: true }); // worktree, no commit
		writeFileSync(path.join(repo.path, "result.txt"), "the agent's only output\n");
		env.ctx.worktreeCwd = repo.root;
		await dispatchCommand("/worktrees", env.ctx);
		const out = env.output();
		expect(out).toContain("uncommitted work remains");
		expect(out).toContain("result.txt");
		expect(out).not.toContain("safe to delete");
	});

	it("M8 review F2: main advanced after branching — stat is vs the merge-base, no phantom deletions", async () => {
		const env = await makeEnv();
		const repo = await makeGitRepo(); // child: one new file (+1 line)
		writeFileSync(path.join(repo.root, "main-moved.txt"), "1\n2\n3\n4\n5\n");
		execFileSync("git", ["add", "."], { cwd: repo.root });
		execFileSync("git", ["commit", "-q", "-m", "main moves"], { cwd: repo.root });
		env.ctx.worktreeCwd = repo.root;
		await dispatchCommand("/worktrees", env.ctx);
		const out = env.output();
		expect(out).toContain("1 file changed, 1 insertion(+)");
		expect(out).not.toContain("deletions"); // main's lines must not appear as child deletions
	});

	it("M8 review F3: squash-merged handback reads already-in-main, no empty merge advice", async () => {
		const env = await makeEnv();
		const repo = await makeGitRepo();
		execFileSync("git", ["merge", "--squash", repo.branch], { cwd: repo.root });
		execFileSync("git", ["commit", "-q", "-m", "squashed"], { cwd: repo.root });
		env.ctx.worktreeCwd = repo.root;
		await dispatchCommand("/worktrees", env.ctx);
		const out = env.output();
		expect(out).toContain("already in main — safe to delete");
		expect(out).not.toContain("git merge imp/task-");
	});

	it("M8 review F4: a main checkout named imp-worktree-* is never listed as a handback", async () => {
		const env = await makeEnv();
		const repo = await makeGitRepo({ repoDirName: "imp-worktree-task-notachild" });
		env.ctx.worktreeCwd = repo.root;
		await dispatchCommand("/worktrees", env.ctx);
		const out = env.output();
		expect(out).toContain(repo.branch); // the real child is still listed
		expect(out).not.toContain(`  ${repo.root}`); // the main checkout itself never appears
	});

	it("M8 review F7: a deleted-behind-git's-back worktree says prune, not safe-to-delete", async () => {
		const env = await makeEnv();
		const repo = await makeGitRepo();
		rmSync(repo.path, { recursive: true, force: true });
		env.ctx.worktreeCwd = repo.root;
		await dispatchCommand("/worktrees", env.ctx);
		expect(env.output()).toContain("directory missing — run: git worktree prune");
		expect(env.output()).not.toContain("safe to delete");
	});

	it("a repository with no children says so", async () => {
		const env = await makeEnv();
		const repo = await makeGitRepo({ noChild: true });
		env.ctx.worktreeCwd = repo.root;
		await dispatchCommand("/worktrees", env.ctx);
		expect(env.output()).toContain("no kept worktrees");
	});
});

describe("markdown quick commands through dispatch (M11 #6)", () => {
	it("runs an md command: the rendered prompt reaches submitPrompt, /help lists it with its tier tag", async () => {
		const env = await makeEnv();
		const extras = [
			{
				command: {
					name: "review",
					summary: "Review the current diff",
					allowedDuringRun: false,
					run: (args: string, ctx: { submitPrompt: (t: string) => void }): "handled" => {
						ctx.submitPrompt(renderMdPrompt("Review the diff. $ARGUMENTS", args));
						return "handled";
					},
				},
				source: "md:project",
			},
		];
		await dispatchCommand("/review focus concurrency", env.ctx, extras);
		expect(env.submitted).toEqual(["Review the diff. focus concurrency"]);
		expect(env.requests).toHaveLength(0); // the command itself spends no model turn
		const helpEnv = await makeEnv();
		await dispatchCommand("/help", helpEnv.ctx, extras);
		expect(helpEnv.output()).toContain("/review");
		expect(helpEnv.output()).toContain("Review the current diff");
	});
});

describe("md commands during a run (review)", () => {
	it("allowedDuringRun:false is rejected mid-run with the standard teaching line — same as extension commands", async () => {
		const env = await makeEnv({ active: true });
		const extras = [
			{
				command: {
					name: "review",
					summary: "review",
					allowedDuringRun: false,
					run: (args: string, ctx: { submitPrompt: (t: string) => void }): "handled" => {
						ctx.submitPrompt(args);
						return "handled";
					},
				},
				source: "md:project",
			},
		];
		await dispatchCommand("/review now", env.ctx, extras);
		expect(env.submitted).toEqual([]); // never ran
		expect(env.output()).toMatch(/waits for the running turn/); // the standard teaching line
	});
});

describe("/status (M11)", () => {
	it("prints model, session, context, and trust lines", async () => {
		const env = await makeEnv();
		await dispatchCommand("/status", env.ctx);
		const out = env.output();
		expect(out).toContain("▪ model claude-sonnet-4-5");
		expect(out).toMatch(/▪ session [0-9a-f]{8} · [\d]+ msgs · in [\d.]+[km]? \/ out [\d.]+[km]? cumulative/);
		expect(out).toMatch(/▪ context ~[\d.]+[km]? tokens · \d+% of window/);
		expect(out).toContain("▪ project trust");
		expect(env.requests).toHaveLength(0); // read-only — no model call
	});
});

describe("/trust (M8)", () => {
	it("no records: this directory is undecided, with the teaching line", async () => {
		const env = await makeEnv();
		const outcome = await dispatchCommand("/trust", env.ctx);
		expect(outcome).toBe("handled");
		expect(env.output()).toContain("undecided");
		expect(env.output()).toContain("no records yet");
	});

	it("records render as a checklist; the decision names where it was recorded", async () => {
		const env = await makeEnv();
		// /trust reads process.cwd(); the STORE is the hermetic temp file, so
		// recording the real repo cwd stays hermetic (nothing touches ~/.imp)
		setTrust(env.trustStore, process.cwd(), true);
		const outcome = await dispatchCommand("/trust", env.ctx);
		expect(outcome).toBe("handled");
		const out = env.output();
		expect(out).toContain("trusted (decided at");
		expect(out).toContain("✓");
		expect(out).toContain(process.cwd());
	});

	it("remove deletes a record and reports misses without erroring", async () => {
		const env = await makeEnv();
		setTrust(env.trustStore, "/gone", false);
		await dispatchCommand("/trust remove /gone", env.ctx);
		expect(env.output()).toContain("removed the trust record for /gone");
		await dispatchCommand("/trust remove /gone", env.ctx);
		expect(env.output()).toContain("no trust record for /gone");
	});

	it("a corrupt store surfaces the teaching error, not a stack", async () => {
		const env = await makeEnv();
		writeFileSync(env.trustStore, "{oops", "utf8");
		const outcome = await dispatchCommand("/trust", env.ctx);
		expect(outcome).toBe("handled");
		expect(env.output()).toContain("failed to read the trust store");
	});
});

describe("/fork (#10 batch 1)", () => {
	const user = (content: string): AgentMessage => ({ role: "user", content });
	const seeded = (): AgentMessage[] => [
		user("fix the login bug"),
		assistantText("fixed it"),
		user("also add tests"),
		assistantText("added"),
	];

	it("with no picker: numbered list + teaching line; /fork <n> executes", async () => {
		const env = await makeEnv({ seed: seeded() });
		await dispatchCommand("/fork", env.ctx);
		let out = env.output();
		expect(out).toContain("#1 fix the login bug");
		expect(out).toContain("#2 also add tests");
		expect(out).toContain("/fork <n>");
		await dispatchCommand("/fork 2", env.ctx);
		out = env.output();
		expect(out).toContain("forked before “also add tests”");
		expect(out).toContain("2 messages kept on this branch"); // batch B D6: one honest count
		expect(env.replayed).toHaveLength(1); // the retained path replayed
	});

	it("/fork <n> reloads the runner history from the new branch", async () => {
		const env = await makeEnv({ seed: seeded() });
		await dispatchCommand("/fork 2", env.ctx);
		expect(env.runner.history.map((m) => (m.role === "user" ? m.content : ""))).toEqual([
			"fix the login bug",
			"",
		]);
	});

	it("out-of-range and non-numeric args teach; empty branches and no-session note", async () => {
		const env = await makeEnv({ seed: seeded() });
		await dispatchCommand("/fork 3", env.ctx);
		expect(env.output()).toContain("#1–#2");
		await dispatchCommand("/fork xyz", env.ctx);
		expect(env.output()).toContain("/fork takes no text");
		const bare = await makeEnv({ noSession: true });
		await dispatchCommand("/fork", bare.ctx);
		expect(bare.output()).toContain("nothing to fork from");
	});

	it("with a picker: cancel changes nothing; a pick forks", async () => {
		const env = await makeEnv({ seed: seeded() });
		const calls: Array<{ title?: string; filterable?: boolean }> = [];
		let answer: number | null = 1;
		(env.ctx as { select?: unknown }).select = async (options: { title?: string; filterable?: boolean }) => {
			calls.push(options);
			return answer;
		};
		answer = null;
		await dispatchCommand("/fork", env.ctx);
		expect(env.output()).toBe("");
		answer = 0;
		await dispatchCommand("/fork", env.ctx);
		expect(calls[0]?.filterable).toBe(true);
		expect(env.output()).toContain("forked before “fix the login bug”");
		expect(env.output()).toContain("0 messages kept on this branch"); // fork before the FIRST message
	});

	it("/fork during a run is rejected with the standard teaching line", async () => {
		const env = await makeEnv({ seed: seeded(), active: true });
		await dispatchCommand("/fork 1", env.ctx);
		expect(env.output()).toMatch(/waits for the running turn/);
	});
});

describe("/tree (#10 batch 2)", () => {
	const user = (content: string): AgentMessage => ({ role: "user", content });
	// A session with two branches: trunk q1/a1, then q2-old/a2-old abandoned
	// by a fork; current = the post-fork tip. Built through the real ops.
	async function branchedEnv() {
		const env = await makeEnv({
			seed: [user("q1"), assistantText("a1"), user("q2-old"), assistantText("a2-old")],
		});
		const points = env.runner.forkPoints();
		await dispatchCommand(`/fork ${points.length}`, env.ctx); // fork before q2-old
		return env;
	}

	/** branchedEnv with a custom provider (#tree integration). */
	async function branchedEnvWith(provider: LLMProvider) {
		const env = await makeEnv({
			seed: [user("q1"), assistantText("a1"), user("q2-old"), assistantText("a2-old")],
			provider,
		});
		const points = env.runner.forkPoints();
		await dispatchCommand(`/fork ${points.length}`, env.ctx);
		return env;
	}

	it("legacy shell: /tree renders the numbered text tree (#tree)", async () => {
		const env = await makeEnv({ seed: [user("q1"), assistantText("a1")] });
		await dispatchCommand("/tree", env.ctx);
		const out = env.output();
		expect(out).toContain("session tree (pick with /tree <n>)");
		expect(out).toContain("user: q1");
		expect(out).toContain("assistant: a1");
		expect(out).toContain("/tree <n> goes to that row");
	});

	it("text fallback lists tree rows; /tree <n> navigates and replays (summary off)", async () => {
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		const env = await branchedEnv();
		await dispatchCommand("/tree", env.ctx);
		let out = env.output();
		expect(out).toContain("q2-old");
		expect(out).toContain("/tree <n> goes to that row");
		// rows: #1 q1(user) #2 a1(assistant, current) #3 q2-old #4 a2-old
		await dispatchCommand("/tree 4", env.ctx);
		out = env.output();
		expect(out).toContain("navigated —");
		expect(out).toContain("summary off — IMP_BRANCH_SUMMARY=0");
		// history is the OLD branch again
		const texts = env.runner.history.map((m) => (m.role === "user" ? m.content : ""));
		expect(texts).toContain("q2-old");
		expect(texts).not.toContain("q2-new");
		expect(env.replayed.length).toBeGreaterThanOrEqual(1);
	});

	it("fork without writing, then switch back: the empty-left note (review P2-3)", async () => {
		const env = await makeEnv({
			seed: [user("q1"), assistantText("a1"), user("q2-old"), assistantText("a2-old")],
		});
		const points = env.runner.forkPoints();
		await dispatchCommand(`/fork ${points.length}`, env.ctx); // fork before q2-old, write nothing
		await dispatchCommand("/tree 4", env.ctx); // to the abandoned tip — nothing was left behind
		expect(env.output()).toContain("nothing was written beyond that point to summarize");
	});

	it("overflow-grace: a live overflow error recovers ONCE via compact-and-retry (no prompt duplication)", async () => {
		const sink: LLMRequest[] = [];
		let call = 0;
		const scripted: LLMProvider = {
			name: "overflow-then-ok",
			async *stream(request) {
				sink.push({ ...request, messages: [...request.messages] });
				call++;
				if (call === 1) throw new Error('OpenAI API error 400: {"error":{"code":"context_length_exceeded"}}');
				if (call === 2) {
					// the compaction summary call
					yield { type: "text_delta", text: "SUMMARY-OF-OLD" };
					yield { type: "message_end", message: assistant([{ type: "text", text: "SUMMARY-OF-OLD" }]) };
					return;
				}
				yield { type: "text_delta", text: "recovered answer" };
				yield { type: "message_end", message: assistant([{ type: "text", text: "recovered answer" }]) };
			},
		};
		const big = "context ".repeat(6000); // ~9k tokens each — compaction needs material beyond keepRecent
		const env = await makeEnv({
			provider: scripted,
			seed: [user(`old work A ${big}`), assistantText(`answer A ${big}`), user(`old work B ${big}`)],
		});
		const result = await env.runner.runTurn({ userMessage: "please continue" });
		expect(result.stopReason).not.toBe("error");
		expect(env.output()).toContain("compacting once and retrying");
		// direct runTurn does not stream to the recorder — assert via history
		const finalText = env.runner.history.filter((m): m is AgentMessage => m.role === "assistant").at(-1);
		expect(JSON.stringify(finalText)).toContain("recovered answer");
		// the retried request runs over history WITH the user message exactly once,
		// and the compacted history carries the summary frame
		const lastUserTexts = sink
			.at(-1)
			?.messages.filter((m): m is UserMessage => m.role === "user")
			.map((m) => m.content);
		expect(lastUserTexts?.filter((t) => t === "please continue")).toHaveLength(1);
		expect(JSON.stringify(lastUserTexts)).toContain("SUMMARY-OF-OLD");
	});

	it("overflow-grace: a SECOND overflow after recovery surfaces the guidance, not a raw 400", async () => {
		let call = 0;
		const scripted: LLMProvider = {
			name: "always-overflow",
			async *stream() {
				call++;
				if (call === 2) {
					yield { type: "message_end", message: assistant([{ type: "text", text: "SUMMARY" }]) };
					return;
				}
				throw new Error("Anthropic API error 400: prompt is too long: 500000 tokens");
			},
		};
		const big = "context ".repeat(6000);
		const env = await makeEnv({
			provider: scripted,
			seed: [user(`old work A ${big}`), assistantText(`answer A ${big}`), user(`old work B ${big}`)],
		});
		await expect(env.runner.runTurn({ userMessage: "hello" })).rejects.toThrow(/larger-context model/);
		expect(call).toBe(3); // fail → summarize → fail again → guidance (no third retry)
	});

	it("overflow-grace: the switch-down deadlock teaches instead of a raw 400 (pre-prompt compaction fails)", async () => {
		// shrink the window via a same-family /model switch so the seeded history
		// overflows and the PRE-prompt compaction itself "overflows"
		const scripted: LLMProvider = {
			name: "deadlock",
			// biome-ignore lint/correctness/useYield: error injection — throws before any yield
			async *stream() {
				// the summary call rejects with an overflow-shaped error
				throw new Error("OpenAI Codex API error 400: This model's maximum context length is 272000 tokens");
			},
		};
		const env = await makeEnv({
			provider: scripted,
			seed: [
				user("long conversation part one"),
				assistantText("answer one"),
				user("part two"),
				assistantText("answer two"),
			],
		});
		const prev = process.env.IMP_CONTEXT_WINDOW;
		process.env.IMP_CONTEXT_WINDOW = "150"; // everything overflows; keepRecent dominates
		try {
			await dispatchCommand("/model claude-opus-4-6", env.ctx); // same family → keeps the fake; window re-read from env (#glm-retire: glm-4.6 would swap to zai)
			await expect(env.runner.runTurn({ userMessage: "next" })).rejects.toThrow(
				/larger-context model.*\/compact/s,
			);
			expect(env.output()).toContain("compacting");
		} finally {
			if (prev === undefined) delete process.env.IMP_CONTEXT_WINDOW;
			else process.env.IMP_CONTEXT_WINDOW = prev;
		}
	});

	it("switching families adapts the compaction window both ways (glm-5.3 1M ↔ gpt-5.5 272k)", async () => {
		const env = await makeEnv({ model: "glm-5.3" });
		expect((env.runner as any).settings.contextWindow).toBe(1_000_000);
		await dispatchCommand("/model openai-codex/gpt-5.5", env.ctx);
		// switched DOWN to 272k: the gate tightens with the new family's window —
		// an over-limit history compacts on the next turn instead of 400ing
		expect((env.runner as any).settings.contextWindow).toBe(272_000);
		expect(env.runner.contextWindow).toBe(272_000);
		await dispatchCommand("/model glm-5.3", env.ctx);
		// switched back UP to 1M: the gate relaxes; compaction no longer fires early
		expect((env.runner as any).settings.contextWindow).toBe(1_000_000);
	});

	it("construction-time registry window reaches the compaction gate (review P1-3)", async () => {
		const env = await makeEnv(); // default claude-sonnet-4-5
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const gate = (env.runner as any).settings.contextWindow as number;
		expect(gate).toBe(1_000_000);
		const glm = await makeEnv({ model: "glm-4.6" });
		expect((glm.runner as any).settings.contextWindow).toBe(200_000);
	});

	it("cross-family switch drives a REAL turn on the new provider (review P2-9 e2e)", async () => {
		const seen: Array<{ model: string; auth: string }> = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c as Buffer));
			req.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
				seen.push({ model: body.model ?? "", auth: String(req.headers.authorization ?? "") });
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(
					`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n` +
						`data: ${JSON.stringify({ choices: [{ delta: { content: "switched ok" } }] })}\n\n` +
						`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
				);
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as { port: number };
		const env = await makeEnv({ model: "glm-4.6" });
		const prevKey = process.env.OPENAI_API_KEY;
		const prevBase = process.env.OPENAI_BASE_URL;
		process.env.OPENAI_API_KEY = "e2e-key";
		process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
		try {
			await dispatchCommand("/model openai/gpt-5.2", env.ctx);
			await env.runner.runTurn({ userMessage: "hello new family" });
			expect(seen).toHaveLength(1);
			expect(seen[0]?.model).toBe("gpt-5.2"); // wire id — prefix stripped
			expect(seen[0]?.auth).toBe("Bearer e2e-key");
		} finally {
			server.close();
			if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prevKey;
			if (prevBase === undefined) delete process.env.OPENAI_BASE_URL;
			else process.env.OPENAI_BASE_URL = prevBase;
		}
	});

	it("an in-flight turn keeps its entry-time provider+model snapshot across a mid-run /model (review P1-2)", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const seen: string[] = [];
		const gated: LLMProvider = {
			name: "gated-fake",
			async *stream(request) {
				seen.push(request.model);
				await gate;
				yield { type: "message_end", message: assistant([{ type: "text", text: "from the old family" }]) };
			},
		};
		const env = await makeEnv({ model: "glm-4.6", provider: gated });
		const turn = env.runner.runTurn({ userMessage: "slow one" });
		await new Promise((r) => setTimeout(r, 20)); // the turn is now in-flight inside the fake
		await dispatchCommand("/model openai/gpt-5.2", env.ctx); // allowedDuringRun — must not leak into the turn
		release?.();
		const result = await turn;
		expect(result.stopReason).not.toBe("error");
		expect(seen).toEqual(["glm-4.6"]);
	});

	it("after a cross-family switch the picker fronts the CANONICAL current entry (review P2-5)", async () => {
		const env = await makeEnv();
		await dispatchCommand("/model openai-codex/gpt-5.4", env.ctx);
		const calls: Array<{ items: Array<{ label: string; description?: string }> }> = [];
		const ctx = {
			...env.ctx,
			select: async (opts: { items: Array<{ label: string; description?: string }> }) => {
				calls.push(opts);
				return 0;
			},
		};
		await dispatchCommand("/model", ctx);
		const labels = calls[0]?.items.map((i) => `${i.label}${i.description === "current" ? "*" : ""}`) ?? [];
		// the current row carries its CANONICAL label — the bare "gpt-5.4"
		// entry that silently flipped families is gone
		expect(labels).toContain("openai-codex/gpt-5.4*");
		expect(labels).not.toContain("gpt-5.4*");
	});

	it("/model with a provider prefix re-routes the protocol family (multi-provider)", async () => {
		const env = await makeEnv({ seed: [] });
		expect(env.runner.model).toBe("claude-sonnet-4-5");
		await dispatchCommand("/model glm-4.6", env.ctx); // #glm-retire: zai now — provider swaps from anthropic
		expect(env.runner.model).toBe("glm-4.6");
		expect(env.runner.contextWindow).toBe(200_000);
		await dispatchCommand("/model openai-codex/gpt-5.4", env.ctx); // cross-family: provider swaps
		expect(env.runner.model).toBe("gpt-5.4");
		expect(env.runner.contextWindow).toBe(272_000);
		// pi's showStatus form: consecutive switches print one dim line each
		expect(env.output()).toContain("Model: zai/glm-4.6");
		expect(env.output()).toContain("Model: openai-codex/gpt-5.4"); // canonical — the family is visible (P2-5)
		await dispatchCommand("/model glm-4.6", env.ctx); // and back
		expect(env.runner.model).toBe("glm-4.6");
	});

	it("bad args teach; running is rejected", async () => {
		const env = await branchedEnv();
		await dispatchCommand("/tree 5", env.ctx);
		expect(env.output()).toContain("#1–#4");
		await dispatchCommand("/tree zzz", env.ctx);
		expect(env.output()).toContain("/tree takes no text");
	});

	it("summary ON (default): the left branch is summarized into the new context", async () => {
		// A provider that answers summarization calls with a marker text.
		const requests: LLMRequest[] = [];
		const provider: LLMProvider = {
			name: "mock",
			async *stream(request) {
				requests.push({ ...request, messages: [...request.messages] });
				const isSummary = (request.system ?? "").includes("summarization");
				const text = isSummary ? "SUMMARY: the abandoned branch tried q3-work" : "ok";
				yield { type: "text_delta", text };
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						blocks: [{ type: "text", text }],
						usage: { inputTokens: 1, outputTokens: 1 },
						stopReason: "end_turn",
					},
				};
			},
		};
		const env = await makeEnv({
			seed: [user("q1"), assistantText("a1"), user("q2-old"), assistantText("a2-old")],
			provider,
		});
		const points = env.runner.forkPoints();
		await dispatchCommand(`/fork ${points.length}`, env.ctx); // fork before q2-old
		// write on the NEW branch (what will be abandoned by the switch)
		const store = env.runner.session;
		store?.appendMessage(user("q3-new direction"));
		store?.appendMessage(assistantText("a3-new"));
		// the summarizer call captured the abandoned segment
		// (active-first rows: q1, a1, q3-new, a3-new, q2-old, a2-old — #6 = abandoned tip)
		await dispatchCommand("/tree 6", env.ctx);
		expect(env.output()).toContain("summarized in context");
		expect(requests).toHaveLength(1); // exactly one call — the summary
		const firstMsg = requests[0]?.messages[0] as UserMessage | undefined;
		const summaryText = firstMsg?.content ?? "";
		expect(summaryText).toContain("q3-new direction"); // the LEFT branch's content
		expect(summaryText).not.toContain("q1"); // the shared trunk is not re-summarized
		// the new context carries the framed summary
		const framed = env.runner.history.find(
			(m): m is UserMessage =>
				m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Branch summary \u2014"),
		);
		expect(typeof framed?.content === "string" && framed.content.includes("tried q3-work")).toBe(true);
	});

	it("TUI flow: three-way summary ask; custom prompt reaches the summarizer (#tree)", async () => {
		const requests: LLMRequest[] = [];
		const provider: LLMProvider = {
			name: "mock",
			async *stream(request) {
				requests.push({ ...request, messages: [...request.messages] });
				const isSummary = (request.system ?? "").includes("summarization");
				const text = isSummary ? "SUMMARY: kept the lessons" : "ok";
				yield { type: "text_delta", text };
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						blocks: [{ type: "text", text }],
						usage: { inputTokens: 1, outputTokens: 1 },
						stopReason: "end_turn",
					},
				};
			},
		};
		const env = await branchedEnvWith(provider);
		// write on the new branch so there is something to summarize
		env.runner.session?.appendMessage(user("q3-new"));
		env.runner.session?.appendMessage(assistantText("a3-new"));
		// the tree picker picks the abandoned tip (row 4 in the default tree)
		let picked = "";
		(env.ctx as { treeSelect?: unknown }).treeSelect = async () => {
			const rows = buildTreeRows(env.runner.session!.getTree(), env.runner.session!.getLeafId(), {
				filter: "default",
			});
			picked = rows[5]?.entryId ?? ""; // a2-old, the abandoned tip
			return picked;
		};
		let secretAnswer: string | null = "focus on the failures";
		const selectAnswers: number[] = [2]; // "Summarize with custom prompt"
		let selectCall = 0;
		(env.ctx as { select?: unknown }).select = async () => selectAnswers[selectCall++] ?? null;
		(env.ctx as { secret?: unknown }).secret = async () => secretAnswer;
		await dispatchCommand("/tree", env.ctx);
		const out = env.output();
		expect(out).toContain("navigated —");
		expect(out).toContain("summarized in context");
		// the custom instructions reached the summarizer prompt
		const summaryReq = requests[0];
		expect(summaryReq).toBeDefined();
		const prompt = summaryReq?.messages[0];
		expect(prompt && "content" in prompt ? String(prompt.content) : "").toContain("focus on the failures");
		// choosing "No summary" skips the summarizer entirely
		requests.length = 0;
		selectCall = 0;
		selectAnswers[0] = 0;
		await dispatchCommand("/tree", env.ctx);
		expect(requests).toHaveLength(0);
		expect(env.output()).toContain("navigated —");
		// cancelling the ask cancels the navigation
		selectCall = 0;
		selectAnswers[0] = -1;
		const leafBefore = env.runner.session?.getLeafId();
		await dispatchCommand("/tree", env.ctx);
		expect(env.runner.session?.getLeafId()).toBe(leafBefore);
		secretAnswer = null;
	});

	it("Ctrl+C mid-summary via onLongOpAbort: stayed on the current branch (#tree, review P2)", async () => {
		const hold = gate();
		const provider: LLMProvider = {
			name: "gated",
			// biome-ignore lint/correctness/useYield: the throw IS the script (abort surfaces before any delta)
			async *stream() {
				await hold.promise;
				throw new Error("branch summary: summarizer aborted — incomplete, rejected");
			},
		};
		const env = await branchedEnvWith(provider);
		env.runner.session?.appendMessage(user("q3-new"));
		const leafBefore = env.runner.session?.getLeafId();
		const seen: (AbortController | null)[] = [];
		(env.ctx as { onLongOpAbort?: unknown }).onLongOpAbort = (c: AbortController | null) => {
			seen.push(c);
		};
		const pending = dispatchCommand("/tree 4", env.ctx); // row 4 = the abandoned tip
		await new Promise((r) => setTimeout(r, 20)); // the summarizer is now hanging
		const live = seen.find((c): c is AbortController => c !== null);
		live?.abort(); // the compacting-state Ctrl+C path does exactly this
		hold.resolve();
		await pending;
		const out = env.output();
		expect(out).toContain("summarization cancelled — stayed on the current branch");
		expect(env.runner.session?.getLeafId()).toBe(leafBefore); // nothing moved
		expect(seen[seen.length - 1]).toBeNull(); // the finally cleared the channel
	});

	it("editorText backfill lands only over an EMPTY editor (#tree)", async () => {
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		const env = await branchedEnv();
		// rows: q1(1) a1(2) q2-old(3) a2-old(4); /tree 1 → q1 (user) → editorText
		let editor = "";
		(env.ctx as { getEditorText?: unknown }).getEditorText = () => editor;
		(env.ctx as { setEditorText?: unknown }).setEditorText = (text: string) => {
			editor = text;
		};
		await dispatchCommand("/tree 1", env.ctx);
		expect(env.output()).toContain("navigated —");
		expect(editor).toBe("q1");
		// navigating to the current POSITION is a no-op
		await dispatchCommand("/tree 2", env.ctx); // a1 — after /tree 1, leaf=null → moves to a1
		editor = "i am mid-thought";
		// a non-empty editor: the text goes to a note instead, editor untouched
		await dispatchCommand("/tree 3", env.ctx); // q2-old (user) on the abandoned branch
		expect(env.output()).toContain("back in the editor: “q2-old”");
		expect(editor).toBe("i am mid-thought");
	});

	it("treeSelect cancel is silent; a pick navigates (#tree)", async () => {
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		const env = await branchedEnv();
		let picked: string | null = null;
		(env.ctx as { treeSelect?: unknown }).treeSelect = async () => picked;
		const base = env.output().length; // ignore the setup fork's note
		await dispatchCommand("/tree", env.ctx);
		expect(env.output().slice(base)).toBe("");
		// rows: #1 q1 #2 a1(current) #3 q2-old #4 a2-old — pick the abandoned tip
		picked = env.runner.session?.getTree()[0]?.children[0]?.children[0]?.children[0]?.entry.id ?? null;
		expect(picked).not.toBeNull(); // a2-old — the abandoned tip
		await dispatchCommand("/tree", env.ctx);
		expect(env.output().slice(base)).toContain("navigated —");
	});
});

describe("/sessions + /resume", () => {
	it("/sessions with no saved sessions → teaching note", async () => {
		const env = await makeEnv({ noSession: true });
		await dispatchCommand("/sessions", env.ctx);
		expect(env.output()).toContain("no saved sessions for this directory yet");
	});

	it("/sessions lists ids, titles, counts; marks the current session ▸", async () => {
		const env = await makeEnv({ seed: [{ role: "user", content: "current session work" }] });
		// a second, older session in the same directory
		const other = createSession(env.cwd, env.baseDir);
		other.appendMessage({ role: "user", content: "older session title line" });
		await dispatchCommand("/sessions", env.ctx);
		const out = env.output();
		const current8 = env.runner.session?.header.id.slice(0, 8) ?? "";
		const other8 = other.header.id.slice(0, 8);
		expect(out).toContain(`▸ ${current8}`);
		expect(out).toContain(other8);
		expect(out).toContain("older session title line");
		expect(out).toContain("1 msg");
		expect(out).toContain("switch with /resume <id>");
		expect(out).toContain("use /resume (no args) to pick one"); // M10 tail hint
	});

	it("/resume <id> swaps the live session and replays its history", async () => {
		const env = await makeEnv({ seed: [{ role: "user", content: "current" }] });
		const target = createSession(env.cwd, env.baseDir);
		target.appendMessage({ role: "user", content: "target session" });
		target.appendMessage({
			role: "assistant",
			blocks: [{ type: "text", text: "answer" }],
			usage: { inputTokens: 1, outputTokens: 1 },
			stopReason: "end_turn",
		});
		await dispatchCommand(`/resume ${target.header.id.slice(0, 8)}`, env.ctx);
		expect(env.runner.session?.header.id).toBe(target.header.id);
		expect(env.replayed).toEqual([target.header.id]); // history hit the screen
		expect(env.output()).toContain("resumed");
		expect(env.output()).toContain("2 messages restored");
	});

	it("/resume with a bad id → teaching error, session unchanged", async () => {
		const env = await makeEnv({ seed: [{ role: "user", content: "current" }] });
		const before = env.runner.session?.header.id;
		await dispatchCommand("/resume nonexistent", env.ctx);
		expect(env.output()).toContain("no session matching");
		expect(env.runner.session?.header.id).toBe(before);
		expect(env.replayed).toEqual([]);
	});

	it("/resume without an id → hint line", async () => {
		const env = await makeEnv();
		await dispatchCommand("/resume", env.ctx);
		expect(env.output()).toContain("/resume <id> — pick an id from /sessions");
	});
});

describe("/resume picker (M10)", () => {
	/** A recording ctx.select that picks the row for `label` (or cancels). */
	function pickerFor(env: TestEnv, label: string | null) {
		const picks: SelectOptions[] = [];
		env.ctx.select = async (options) => {
			picks.push(options);
			return label === null ? null : options.items.findIndex((item) => item.label === label);
		};
		return picks;
	}

	it("no args + a picker: rows are <id8> · local time · msgs · title; a pick resumes exactly like /resume <id>", async () => {
		const env = await makeEnv({ seed: [userMsg("current")] });
		const target = createSession(env.cwd, env.baseDir);
		target.appendMessage(userMsg("target session"));
		target.appendMessage(assistantText("answer"));
		const target8 = target.header.id.slice(0, 8);
		const picks = pickerFor(env, target8);
		await dispatchCommand("/resume", env.ctx);
		expect(picks).toHaveLength(1);
		expect(picks[0]?.title).toBe("sessions — pick one to resume");
		const row = picks[0]?.items.find((item) => item.label === target8);
		expect(row?.description).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 2 msgs · target session/);
		// the pick walked the SAME resume flow as /resume <id>
		expect(env.runner.session?.header.id).toBe(target.header.id);
		expect(env.replayed).toEqual([target.header.id]);
		expect(env.output()).toContain("resumed");
		expect(env.output()).toContain("2 messages restored");
	});

	it("cancelling the picker notes one line and changes nothing", async () => {
		const env = await makeEnv({ seed: [userMsg("current")] });
		const before = env.runner.session?.header.id;
		pickerFor(env, null);
		await dispatchCommand("/resume", env.ctx);
		expect(env.output()).toContain("▪ resume cancelled");
		expect(env.runner.session?.header.id).toBe(before);
		expect(env.replayed).toEqual([]);
	});

	it("hides more than 20 newer empty sessions before limiting the picker and /sessions", async () => {
		const env = await makeEnv(); // the current session is also empty
		const target = createSession(env.cwd, env.baseDir);
		target.appendMessage(userMsg("older conversation"));
		await utimes(target.filePath, new Date(1000), new Date(1000));
		const emptyIds = [env.runner.session?.header.id.slice(0, 8) as string];
		for (let i = 0; i < 21; i++) {
			emptyIds.push(createSession(env.cwd, env.baseDir).header.id.slice(0, 8));
		}
		await dispatchCommand("/sessions", env.ctx);
		expect(env.output()).toContain(target.header.id.slice(0, 8));
		for (const id of emptyIds) expect(env.output()).not.toContain(id);
		expect(env.output()).not.toContain("older hidden");

		const picks = pickerFor(env, target.header.id.slice(0, 8));
		await dispatchCommand("/resume", env.ctx);
		expect(picks[0]?.items.map((item) => item.label)).toEqual([target.header.id.slice(0, 8)]);
		expect(env.runner.session?.header.id).toBe(target.header.id);
	});

	it("only empty sessions → no picker, while explicit resume still works", async () => {
		const env = await makeEnv();
		const target = createSession(env.cwd, env.baseDir);
		target.appendSessionName("not started");
		const picks = pickerFor(env, null);
		await dispatchCommand("/resume", env.ctx);
		expect(picks).toHaveLength(0);
		expect(env.output()).toContain("no saved sessions for this directory yet");
		await dispatchCommand("/sessions", env.ctx);
		expect(env.output()).not.toContain(target.header.id.slice(0, 8));
		await dispatchCommand(`/resume ${target.header.id}`, env.ctx);
		expect(env.runner.session?.header.id).toBe(target.header.id);
		expect(env.output()).toContain("0 messages restored");
	});

	it("a picker but zero saved sessions → the /sessions empty note, no picker opened", async () => {
		const env = await makeEnv({ noSession: true });
		let opened = false;
		env.ctx.select = async () => {
			opened = true;
			return null;
		};
		await dispatchCommand("/resume", env.ctx);
		expect(opened).toBe(false);
		expect(env.output()).toContain("no saved sessions for this directory yet");
	});
});

// ── #thinking-levels: /think command + runner plumbing ──────────────────

describe("/think (#thinking-levels)", () => {
	it("on a thinking model: sets, clamps, cycles; the footer hook fires", async () => {
		const env = await makeEnv();
		expect(env.runner.supportsThinking()).toBe(true); // claude-sonnet-4-5
		await dispatchCommand("/think medium", env.ctx);
		expect(env.runner.thinkingLevel).toBe("medium");
		expect(env.output()).toContain("Thinking level: medium");
		// xhigh is beyond the budget ladder — clamps to high and says so
		await dispatchCommand("/think xhigh", env.ctx);
		expect(env.runner.thinkingLevel).toBe("high");
		expect(env.output()).toContain("Thinking level: high (xhigh is not available on this model)");
		// bare /think cycles: high → off
		await dispatchCommand("/think", env.ctx);
		expect(env.runner.thinkingLevel).toBe("off");
		// invalid level teaches the ladder (pi's --thinking error shape)
		await dispatchCommand("/think turbo", env.ctx);
		expect(env.output()).toContain("thinking levels: off, minimal, low, medium, high, xhigh, max");
	});

	it("pi's DEFAULT_THINKING_LEVEL is medium: knob models start there, knob-less clamp to off, a change persists", async () => {
		// knob model: fresh session, no settings → medium (pi sdk.ts:230)
		const env = await makeEnv();
		expect(env.runner.thinkingLevel).toBe("medium");
		// the choice persists as the cross-session default (pi agent-session :1690)
		await dispatchCommand("/think low", env.ctx);
		const second = await makeEnv({ model: "claude-sonnet-4-5" });
		expect(loadSettings(env.settingsPath).defaultThinkingLevel).toBe("low");
		// BUT a fresh env with its own empty settings still defaults medium
		expect(second.runner.thinkingLevel).toBe("medium");
		// knob-less model: medium clamps to off, and off does NOT persist
		const bare = await makeEnv({ model: "openai/llama-3-70b" });
		expect(bare.runner.thinkingLevel).toBe("off");
		expect(loadSettings(bare.settingsPath).defaultThinkingLevel).toBeUndefined();
	});

	it("zai/glm-5.3: the cycle never reaches off; a zai→claude switch clamps into the budget ladder", async () => {
		const env = await makeEnv({ model: "zai/glm-5.3" });
		// the medium DEFAULT applies and immediately clamps UP — glm-5.3's
		// ladder is low/high/max (no medium; pi.dev live map)
		expect(env.runner.thinkingLevel).toBe("high");
		await dispatchCommand("/think off", env.ctx); // off is IMPOSSIBLE on this model
		expect(env.runner.thinkingLevel).toBe("low"); // clamped UP (pi.dev off:null)
		await dispatchCommand("/think max", env.ctx);
		expect(env.runner.thinkingLevel).toBe("max");
		await dispatchCommand("/think", env.ctx); // cycle: max wraps to low — off is never in the list
		expect(env.runner.thinkingLevel).toBe("low");
		// family switch carries the CURRENT level: max survives into opus-4-8
		// (its ladder goes to max), clamps DOWN to high on sonnet-4-5
		await dispatchCommand("/think max", env.ctx);
		await dispatchCommand("/model claude-opus-4-8", env.ctx);
		expect(env.runner.thinkingLevel).toBe("max");
		await dispatchCommand("/model claude-sonnet-4-5", env.ctx);
		expect(env.runner.thinkingLevel).toBe("high");
		// and into a capped model it clamps DOWN to high
		await dispatchCommand("/model claude-sonnet-4-5", env.ctx);
		expect(env.runner.thinkingLevel).toBe("high");
	});

	it("an explicit --thinking beats the session entry on resume (pi sdk.ts:222 precedence)", async () => {
		const env = await makeEnv();
		await dispatchCommand("/think low", env.ctx); // session entry now says low
		// a second runner resuming the SAME session WITH an explicit level ignores the entry
		const { renderer: r2 } = makeRenderer();
		const runner2 = await createRunner({
			cwd: env.cwd,
			argv: [],
			settingsPath: env.settingsPath,
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			resume: env.runner.session?.header.id,
			sessionBaseDir: env.baseDir,
			thinking: "high",
			renderer: r2,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], []),
		});
		expect(runner2.thinkingLevel).toBe("high"); // NOT the session's low
	});

	it("#glm-retire: bare glm routes to zai unconditionally — a MISSING credential teaches /login; a stored/env key or explicit compat stays silent", async () => {
		// no ZAI_API_KEY → zai family (routing never falls back to compat
		// anymore) + the sign-in teaching note
		const prevZai = process.env.ZAI_API_KEY;
		delete process.env.ZAI_API_KEY;
		const env = await makeEnv();
		await dispatchCommand("/model glm-5.3", env.ctx);
		expect(env.runner.providerName).toBe("zai");
		expect(env.output()).toContain("Model: zai/glm-5.3");
		expect(env.output()).toContain("glm-5.3 is a Z.ai model — sign in with /login zai");
		// a stored /login key silences the teaching (stored > env). NOTE:
		// zaiApiKey() reads the global IMP_AUTH_PATH sandbox, NOT
		// ctx.authStorePath — save there and clear it for the neighbors
		const stored = await makeEnv();
		await saveApiKey("zai", "sk-stored");
		try {
			await dispatchCommand("/model glm-5.3", stored.ctx);
			expect(stored.runner.providerName).toBe("zai");
			expect(stored.output()).toContain("Model: zai/glm-5.3");
			expect(stored.output()).not.toContain("sign in with /login zai");
		} finally {
			await clearApiKey("zai");
			if (prevZai === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = prevZai;
		}
		// explicit anthropic/ prefix — the generic compat passthrough still
		// works and never teaches (a deliberate choice needing no zai key)
		const quiet = await makeEnv();
		await dispatchCommand("/model anthropic/glm-5.3", quiet.ctx);
		expect(quiet.runner.providerName).toBe("anthropic");
		expect(quiet.output()).not.toContain("sign in with /login zai");
	});

	it("construction seam: IMP_MODEL=glm-5.3 builds the zai family and clamps into its ladder; a keyless startup teaches /login", async () => {
		// zai construction (the documented "keep IMP_MODEL, add ZAI_API_KEY" flow)
		const env = await makeEnv({ model: "glm-5.3" });
		const prev = process.env.ZAI_API_KEY;
		process.env.ZAI_API_KEY = "sk-test";
		try {
			const { renderer: r } = makeRenderer();
			const runner = await createRunner({
				cwd: env.cwd,
				argv: [],
				settingsPath: env.settingsPath,
				model: "glm-5.3",
				maxTokens: 1024,
				maxTurns: 10,
				noContextFiles: true,
				noSession: true,
				renderer: r,
				provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], []),
			});
			expect(runner.providerName).toBe("zai");
			expect(runner.thinkingLevel).toBe("high"); // medium clamps UP into low/high/max
		} finally {
			if (prev === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = prev;
		}
		// #glm-retire: startup WITHOUT a credential no longer falls back to
		// compat — the family is zai and the sign-in teaching fires at warmup
		// (fresh renderer so the warmup note is not sliced into the seeding
		// banner like makeEnv's env.output() does)
		const { renderer: bareR, output: bareOut } = makeRenderer();
		const bare = await createRunner({
			cwd: env.cwd,
			argv: [],
			settingsPath: env.settingsPath,
			model: "glm-5.3",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			renderer: bareR,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], []),
		});
		expect(bare.providerName).toBe("zai");
		expect(bareOut()).toContain("sign in with /login zai");
	});

	it("/login: picker rows carry status; a pick prompts for the key, stores it, and points at /model when the family differs", async () => {
		const env = await makeEnv();
		let labels: Array<{ label: string; description?: string }> = [];
		env.ctx.select = async (options) => {
			labels = options.items;
			return options.items.findIndex((item) => item.label === "Z.AI");
		};
		let secretPrompt = "";
		env.ctx.secret = async (question) => {
			secretPrompt = question;
			return "sk-zai-1";
		};
		await dispatchCommand("/login", env.ctx);
		// rows: one per family, status-filled (pi's OAuthSelector rows)
		expect(labels.map((r) => r.label)).toEqual(["Z.AI", "Anthropic", "OpenAI", "OpenAI (ChatGPT plan)"]);
		expect(labels.find((r) => r.label === "Z.AI")?.description).toBe("not signed in");
		expect(labels.find((r) => r.label === "OpenAI (ChatGPT plan)")?.description).toBe("not signed in");
		expect(secretPrompt).toBe("Enter Z.AI API key"); // pi's prompt form
		expect(loadApiKey("zai", env.ctx.authStorePath)).toBe("sk-zai-1");
		expect(env.output()).toContain("Saved API key for Z.AI"); // pi's wording
		// current family (anthropic) differs from the login — the pointer
		expect(env.output()).toContain("▪ switch with /model zai/glm-5.3");
	});

	it("/login: same-family login needs no pointer; env-configured rows say so; cancel is silent", async () => {
		// same family: status only, no ▪ pointer
		const same = await makeEnv({ model: "openai/gpt-5.2" });
		same.ctx.secret = async () => "sk-o";
		await dispatchCommand("/login openai", same.ctx);
		expect(loadApiKey("openai", same.ctx.authStorePath)).toBe("sk-o");
		expect(same.output()).toContain("Saved API key for OpenAI");
		expect(same.output()).not.toContain("▪ switch with");
		// env-configured row label (status source, pi-style)
		const envRow = await makeEnv();
		const rows: Array<{ label: string; description?: string }> = [];
		envRow.ctx.select = async (options) => {
			rows.push(...options.items);
			return null; // cancel the picker
		};
		const prev = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant";
		try {
			await dispatchCommand("/login", envRow.ctx);
			expect(rows.find((r) => r.label === "Anthropic")?.description).toBe("env: ANTHROPIC_API_KEY");
		} finally {
			if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prev;
		}
		// cancelled secret: nothing stored, nothing printed (pi's silent cancel)
		const cancel = await makeEnv();
		cancel.ctx.secret = async () => null;
		await dispatchCommand("/login zai", cancel.ctx);
		expect(loadApiKey("zai", cancel.ctx.authStorePath)).toBeNull();
		expect(cancel.output()).toBe("");
	});

	it("/login: unknown provider teaches; codex runs the device-code flow in-REPL; a missing secret prompts the env var", async () => {
		const env = await makeEnv();
		await dispatchCommand("/login foo", env.ctx);
		expect(env.output()).toContain('unknown provider "/login foo"');
		expect(env.output()).toContain("known: zai, anthropic, openai, openai-codex");
		// oauth family (batch B): URL + code render, no secret prompt at all
		const codex = await makeEnv();
		codex.ctx.secret = async () => {
			throw new Error("must not prompt");
		};
		const fake = await fakeCodexAuth(); // local device-code server
		codex.ctx.codexAuthBaseUrl = fake.baseUrl;
		await dispatchCommand("/login openai-codex", codex.ctx);
		expect(codex.output()).toContain("/codex/device and enter code: WXYZ-6789"); // the URL follows the injected base
		expect(codex.output()).toContain("Logged in to OpenAI (ChatGPT plan)");
		expect(codex.output()).toContain("▪ switch with /model openai-codex/gpt-5.5");
		expect(loadCodexCredential(codex.ctx.authStorePath)?.accountId).toBe("acct-login");
		// legacy ctx (no secret bound): the teaching error names the env var
		const legacy = await makeEnv();
		await dispatchCommand("/login zai", legacy.ctx);
		expect(legacy.output()).toContain("export ZAI_API_KEY=<key>");
	});

	it("loginNeedsGuard: only the OAuth-capable /login lines take the guarded state", () => {
		expect(loginNeedsGuard("/login")).toBe(true); // the picker can land on codex
		expect(loginNeedsGuard("/login openai-codex")).toBe(true);
		expect(loginNeedsGuard("/login OpenAI (ChatGPT plan)")).toBe(true); // display name, any case
		expect(loginNeedsGuard("/login zai")).toBe(false); // short api-key path
		expect(loginNeedsGuard("/login Z.AI")).toBe(false);
		expect(loginNeedsGuard("/model")).toBe(false);
		expect(loginNeedsGuard("hello")).toBe(false);
	});

	it("/logout: lists STORED credentials only (pi); removal messages match pi; env-configured providers never appear", async () => {
		// nothing stored → pi's empty message
		const empty = await makeEnv();
		await dispatchCommand("/logout", empty.ctx);
		expect(empty.output()).toContain("No stored credentials to remove");
		// a stored zai key + codex token → two rows; env vars never listed
		const env = await makeEnv();
		saveApiKey("zai", "sk-z", env.ctx.authStorePath);
		const cred = { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000, accountId: "a" };
		// makeEnv always seeds authStorePath; narrow for writeFileSync
		if (!env.ctx.authStorePath) throw new Error("makeEnv must set authStorePath");
		writeFileSync(
			env.ctx.authStorePath,
			JSON.stringify({ version: 1, apiKeys: { zai: "sk-z" }, codex: { provider: "openai-codex", ...cred } }),
		);
		let rows: Array<{ label: string; description?: string }> = [];
		env.ctx.select = async (options) => {
			rows = options.items;
			return options.items.findIndex((item) => item.label === "Z.AI");
		};
		const prevKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-env-o"; // env-configured but NOT stored
		try {
			await dispatchCommand("/logout", env.ctx);
			expect(rows.map((r) => r.label)).toEqual(["OpenAI (ChatGPT plan)", "Z.AI"]); // stored only
			expect(env.output()).toContain("Removed stored API key for Z.AI. Environment variables are unchanged.");
			expect(loadApiKey("zai", env.ctx.authStorePath)).toBeNull();
			expect(loadCodexCredential(env.ctx.authStorePath)?.accountId).toBe("a"); // untouched
			// now remove the codex token (pi's oauth wording)
			let rows2: Array<{ label: string; description?: string }> = [];
			env.ctx.select = async (options) => {
				rows2 = options.items;
				return 0;
			};
			await dispatchCommand("/logout", env.ctx);
			expect(rows2.map((r) => r.label)).toEqual(["OpenAI (ChatGPT plan)"]);
			expect(env.output()).toContain("Logged out of OpenAI (ChatGPT plan)");
			expect(loadCodexCredential(env.ctx.authStorePath)).toBeNull();
		} finally {
			if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prevKey;
		}
		// legacy ctx (no picker): the text path
		const legacy = await makeEnv();
		saveApiKey("anthropic", "sk-a", legacy.ctx.authStorePath);
		await dispatchCommand("/logout", legacy.ctx);
		expect(legacy.output()).toContain("stored: Anthropic");
		expect(legacy.output()).toContain("edit ~/.imp/auth.json");
	});

	it("/login codex: an abort landing MID-FETCH is silent too (pi's fetchWithLoginCancellation)", async () => {
		// Review P2 (batch B): aborting inside a fetch's network window used
		// to surface as "login failed — This operation was aborted".
		const env = await makeEnv();
		const fake = await fakeCodexAuth({ delayUserCodeMs: 400 }); // slow usercode
		env.ctx.codexAuthBaseUrl = fake.baseUrl;
		env.ctx.onLongOpAbort = (controller) => {
			if (controller !== null) setTimeout(() => controller.abort(), 150); // inside the fetch
		};
		await dispatchCommand("/login openai-codex", env.ctx);
		expect(env.output()).not.toContain("Logged in");
		expect(env.output()).not.toContain("failed"); // silent — mapped to Login cancelled
		expect(env.output()).not.toContain("aborted");
		expect(loadCodexCredential(env.ctx.authStorePath)).toBeNull();
	});

	it("/login codex: Ctrl+C cancellation is silent (pi's Login cancelled); a server failure renders the error", async () => {
		// cancellation: the machine aborts the registered controller — here the
		// command path is exercised with a self-aborting one
		const cancel = await makeEnv();
		const fake = await fakeCodexAuth({ hang: true }); // polls never succeed
		cancel.ctx.codexAuthBaseUrl = fake.baseUrl;
		cancel.ctx.onLongOpAbort = (controller) => {
			if (controller !== null) setTimeout(() => controller.abort(), 150);
		};
		await dispatchCommand("/login openai-codex", cancel.ctx);
		expect(cancel.output()).toContain("enter code: WXYZ-6789"); // the URL line rendered first
		expect(cancel.output()).not.toContain("Logged in");
		expect(cancel.output()).not.toContain("failed"); // silent cancel (pi)
		expect(loadCodexCredential(cancel.ctx.authStorePath)).toBeNull();
		// failure: an unreachable auth base surfaces as an error, not a hang
		const dead = await makeEnv();
		dead.ctx.codexAuthBaseUrl = "http://127.0.0.1:1";
		await dispatchCommand("/login openai-codex", dead.ctx);
		expect(dead.output()).toContain("login failed");
	});

	it("/login: display names and case-insensitive refs match (pi); a whitespace-only answer cancels", async () => {
		// pi matches provider refs against id AND display name, lowercased
		const env = await makeEnv();
		env.ctx.secret = async () => "sk-dn";
		await dispatchCommand("/login Z.AI", env.ctx);
		expect(loadApiKey("zai", env.ctx.authStorePath)).toBe("sk-dn");
		const fake = await fakeCodexAuth();
		env.ctx.codexAuthBaseUrl = fake.baseUrl;
		await dispatchCommand("/login openai (chatgpt plan)", env.ctx);
		expect(env.output()).toContain("Logged in to OpenAI (ChatGPT plan)"); // matched the codex row by name
		// whitespace-only = cancel (readline delivers raw spaces)
		const blank = await makeEnv();
		blank.ctx.secret = async (q) => (q.trim() === "" ? null : "  ");
		await dispatchCommand("/login zai", blank.ctx);
		expect(loadApiKey("zai", blank.ctx.authStorePath)).toBeNull();
	});

	it("a stored /login key flips familyConfigured (the /model picker gate); #glm-retire: bare glm routing is now STATIC", async () => {
		const env = await makeEnv();
		env.ctx.secret = async () => "sk-zai-2";
		const prevKey = process.env.ZAI_API_KEY;
		const prevAuth = process.env.IMP_AUTH_PATH;
		delete process.env.ZAI_API_KEY;
		// familyConfigured/parseModelRef read the DEFAULT store path — point
		// IMP_AUTH_PATH at the same temp file the command wrote
		process.env.IMP_AUTH_PATH = env.ctx.authStorePath;
		try {
			await dispatchCommand("/login zai", env.ctx);
			expect(familyConfigured("zai")).toBe(true);
			// routing itself no longer consults credentials (#glm-retire):
			// bare glm-* → zai both with AND without a key
			expect(parseModelRef("glm-5.3")).toEqual({ provider: "zai", modelId: "glm-5.3" });
			expect(parseModelRef("zai/glm-5.3")).toEqual({ provider: "zai", modelId: "glm-5.3" });
			expect(parseModelRef("anthropic/glm-5.3")).toEqual({ provider: "anthropic", modelId: "glm-5.3" });
		} finally {
			if (prevKey === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = prevKey;
			if (prevAuth === undefined) delete process.env.IMP_AUTH_PATH;
			else process.env.IMP_AUTH_PATH = prevAuth;
		}
	});

	it("on a model with no knob: pi's status line, level stays off", async () => {
		const env = await makeEnv({ model: "openai/llama-3-70b" });
		expect(env.runner.supportsThinking()).toBe(false);
		await dispatchCommand("/think high", env.ctx);
		expect(env.output()).toContain("Current model does not support thinking"); // pi's exact line
		expect(env.runner.thinkingLevel).toBe("off");
	});

	it("setThinkingLevel persists a session entry (pi's thinking_level_change)", async () => {
		const env = await makeEnv();
		env.runner.setThinkingLevel("low");
		const entries = env.runner.session?.getEntries() ?? [];
		const change = entries.find((e) => e.type === "thinkingLevelChange");
		expect(change).toMatchObject({ type: "thinkingLevelChange", thinkingLevel: "low" });
		// buildContext skips it (tree metadata, like branch summaries)
		expect(env.runner.session?.buildContext().messages.some((m) => m.role === "assistant")).toBe(false);
	});

	it("resume restores the branch's last recorded level (pi parity)", async () => {
		const env = await makeEnv();
		env.runner.setThinkingLevel("low");
		// a second runner resuming the SAME session file restores "low"
		const { renderer: r2 } = makeRenderer();
		const runner2 = await createRunner({
			cwd: env.cwd,
			argv: [],
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			resume: env.runner.session?.header.id,
			sessionBaseDir: env.baseDir,
			renderer: r2,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], []),
		});
		expect(runner2.thinkingLevel).toBe("low");
	});

	it("a /model switch off a thinking family drops the level (pi clamps on switch)", async () => {
		const env = await makeEnv();
		env.runner.setThinkingLevel("high");
		await dispatchCommand("/model openai/llama-3-70b", env.ctx);
		expect(env.runner.thinkingLevel).toBe("off");
	});

	it("the request carries the level; off sends none", async () => {
		const env = await makeEnv();
		env.runner.setThinkingLevel("low");
		await env.runner.runTurn({ userMessage: "hi" });
		expect(env.requests[env.requests.length - 1]?.thinking).toBe("low");
		env.runner.setThinkingLevel("off");
		await env.runner.runTurn({ userMessage: "again" });
		expect(env.requests[env.requests.length - 1]?.thinking).toBeUndefined();
	});
});

describe("/tree batch B (#tree-b)", () => {
	async function branchedEnvB(args?: { trusted?: boolean }) {
		const env = await makeEnv({
			seed: [user("q1"), assistantText("a1"), user("q2-old"), assistantText("a2-old")],
			trusted: args?.trusted,
		});
		const points = env.runner.forkPoints();
		await dispatchCommand(`/fork ${points.length}`, env.ctx);
		return env;
	}

	it("treeFilterMode setting feeds the picker's initialFilterMode; project wins over global (trusted)", async () => {
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		const env = await branchedEnvB({ trusted: true });
		const seen: (string | undefined)[] = [];
		let pick: string | null = null;
		(env.ctx as { treeSelect?: unknown }).treeSelect = async (opts: { initialFilterMode?: string }) => {
			seen.push(opts.initialFilterMode);
			return pick;
		};
		pick = env.runner.session?.getTree()[0]?.children[0]?.children[0]?.children[0]?.entry.id ?? null;
		await dispatchCommand("/tree", env.ctx);
		expect(seen[seen.length - 1]).toBe("default"); // unset → default
		pick = null; // later dispatches only capture the setting (cancel)
		const fs = await import("node:fs/promises");
		const pathMod = await import("node:path");
		// GLOBAL says user-only…
		await fs.writeFile(
			env.runner.globalSettingsPath(),
			JSON.stringify({ treeFilterMode: "user-only" }),
			"utf-8",
		);
		await dispatchCommand("/tree", env.ctx);
		expect(seen[seen.length - 1]).toBe("user-only");
		// …a TRUSTED project file wins (impl-review P2-2: pin the command seam)
		const projSettings = pathMod.join(env.runner.runnerCwd, ".imp", "settings.json");
		await fs.mkdir(pathMod.dirname(projSettings), { recursive: true });
		await fs.writeFile(projSettings, JSON.stringify({ treeFilterMode: "labeled-only" }), "utf-8");
		await dispatchCommand("/tree", env.ctx);
		expect(seen[seen.length - 1]).toBe("labeled-only");
	});

	it("branchSummary.skipPrompt=true: the picker navigates with NO ask; env=0 still wins combined", async () => {
		const fs = await import("node:fs/promises");
		const env = await branchedEnvB();
		await fs.writeFile(
			env.runner.globalSettingsPath(),
			JSON.stringify({ branchSummary: { skipPrompt: true } }),
			"utf-8",
		);
		let asks = 0;
		(env.ctx as { select?: unknown }).select = async () => {
			asks++;
			return 0;
		};
		(env.ctx as { treeSelect?: unknown }).treeSelect = async () =>
			env.runner.session?.getTree()[0]?.children[0]?.children[0]?.children[0]?.entry.id ?? null;
		await dispatchCommand("/tree", env.ctx);
		expect(asks).toBe(0); // skipped — no summary, straight over
		expect(env.output()).toContain("navigated —");
		// combined with the env hard-off: still no ask, and the runner gate keeps summaries off
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		await dispatchCommand("/tree", env.ctx);
		expect(asks).toBe(0);
	});

	it("onLabelChange persists via appendLabelChange; a bad target is refused", async () => {
		const env = await branchedEnvB();
		let captured: { onLabelChange?: (id: string, label: string | undefined) => void } | undefined;
		(env.ctx as { treeSelect?: unknown }).treeSelect = async (opts: {
			onLabelChange?: (id: string, label: string | undefined) => void;
		}) => {
			captured = opts;
			return null; // open, label, then cancel — the command just ends
		};
		await dispatchCommand("/tree", env.ctx);
		expect(captured?.onLabelChange).toBeDefined();
		const store = env.runner.session;
		expect(store).not.toBeNull();
		const target = store?.getTree()[0]?.children[0];
		captured?.onLabelChange?.(target?.entry.id ?? "", "checkpoint");
		expect(store?.getLabel(target?.entry.id ?? "")).toBe("checkpoint");
		// removal: undefined
		captured?.onLabelChange?.(target?.entry.id ?? "", undefined);
		expect(store?.getLabel(target?.entry.id ?? "")).toBeUndefined();
		// bad target: refused with an error line, nothing appended
		const before = store?.getBranch().length ?? 0;
		captured?.onLabelChange?.("no-such-entry", "x");
		expect(env.output()).toContain("cannot label no-such-entry");
		expect(store?.getBranch().length).toBe(before);
	});

	it("/fork rides navigateTree: editorText backfill + the one-count note", async () => {
		const env = await branchedEnvB();
		let editor = "";
		(env.ctx as { getEditorText?: unknown }).getEditorText = () => editor;
		(env.ctx as { setEditorText?: unknown }).setEditorText = (text: string) => {
			editor = text;
		};
		const points = env.runner.forkPoints();
		// fork before the newest message (an ANSWERED one): leaf moves to its
		// parent; the text returns to the editor
		await dispatchCommand(`/fork ${points.length}`, env.ctx);
		const out = env.output();
		expect(out).toContain("messages kept on this branch");
		expect(out).not.toContain("left on the old branch");
		expect(editor).toContain("q1"); // the first message — the only retained one
	});

	it("fork the UNANSWERED leaf message: position moves, text returns (batch B P1)", async () => {
		const env = await branchedEnvB();
		env.runner.session?.appendMessage(user("q3-drafted")); // unanswered → new leaf
		let editor = "";
		(env.ctx as { getEditorText?: unknown }).getEditorText = () => editor;
		(env.ctx as { setEditorText?: unknown }).setEditorText = (text: string) => {
			editor = text;
		};
		const points = env.runner.forkPoints();
		await dispatchCommand(`/fork ${points.length}`, env.ctx);
		const store = env.runner.session;
		// the unanswered message left the branch (its parent is where the
		// position now sits — the branch tail and leaf coincide, correctly)
		const stillThere = store
			?.getBranch()
			.some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "q3-drafted");
		expect(stillThere).toBe(false);
		expect(editor).toBe("q3-drafted"); // back for re-editing
		expect(env.output()).toContain("forked before");
	});

	it("/settings treeFilterMode parses the five literals and rejects junk", async () => {
		const env = await makeEnv();
		await dispatchCommand("/settings treeFilterMode labeled-only", env.ctx);
		expect(env.output()).toContain("treeFilterMode");
		const fs = await import("node:fs/promises");
		const raw = JSON.parse(await fs.readFile(env.runner.globalSettingsPath(), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(raw.treeFilterMode).toBe("labeled-only");
		await dispatchCommand("/settings treeFilterMode everything", env.ctx);
		expect(env.output()).toContain("must be one of");
	});
});

describe("/tree batch C (#tree-c)", () => {
	async function branchedEnvC(provider?: LLMProvider) {
		const env = await makeEnv({
			seed: [user("q1"), assistantText("a1"), user("q2-old"), assistantText("a2-old")],
			...(provider === undefined ? {} : { provider }),
		});
		const points = env.runner.forkPoints();
		await dispatchCommand(`/fork ${points.length}`, env.ctx); // fork before q2-old
		return env;
	}

	it("an aborted summarization re-opens the picker ON the attempted entry (D6)", async () => {
		const hold = gate();
		const provider: LLMProvider = {
			name: "gated",
			// biome-ignore lint/correctness/useYield: the throw IS the script (abort surfaces before any delta)
			async *stream() {
				await hold.promise;
				throw new Error("branch summary: summarizer aborted — incomplete, rejected");
			},
		};
		const env = await branchedEnvC(provider);
		env.runner.session?.appendMessage(user("q3-new"));
		// the abandoned old-branch tip a2-old (NOT the current leaf — the
		// picker short-circuits "already at that point" on the leaf itself)
		// after the fork the old chain q2-old → a2-old is the only subtree of
		// a1 until q3-new lands beside it: a1.children[0] = q2-old branch
		const a1node = env.runner.session?.getTree()[0]?.children[0];
		const abandonedTip = a1node?.children[0]?.children[0]?.entry.id ?? null;
		expect(abandonedTip).not.toBeNull();
		const seen: (AbortController | null)[] = [];
		(env.ctx as { onLongOpAbort?: unknown }).onLongOpAbort = (c: AbortController | null) => {
			seen.push(c);
		};
		const reopenCalls: (string | undefined)[] = [];
		let call = 0;
		(env.ctx as { treeSelect?: unknown }).treeSelect = async (opts: { initialSelectedId?: string }) => {
			call++;
			reopenCalls.push(opts.initialSelectedId);
			return call === 1 ? (abandonedTip ?? null) : null; // second round: cancel out
		};
		(env.ctx as { select?: unknown }).select = async () => 1; // "Summarize"
		const pending = dispatchCommand("/tree", env.ctx);
		await new Promise((r) => setTimeout(r, 20)); // summarizer now hanging
		seen.find((c): c is AbortController => c !== null)?.abort(); // Ctrl+C path
		hold.resolve();
		await pending;
		const out = env.output();
		expect(out).toContain("summarization cancelled — stayed on the current branch");
		expect(call).toBe(2); // the picker RE-OPENED…
		expect(reopenCalls).toEqual([undefined, abandonedTip]); // …ON the attempted entry
		expect(seen[seen.length - 1]).toBeNull(); // abort channel cleared both rounds
	});

	it("Esc at the three-choice ask re-opens the picker with the same entry preselected (D6, pi:5243-5246)", async () => {
		const env = await branchedEnvC();
		const tree = env.runner.session?.getTree() ?? [];
		// a2-old: the abandoned tip (no new message yet — the old chain is the
		// only subtree); never the current leaf (leaf short-circuits)
		const target = tree[0]?.children[0]?.children[0]?.children[0]?.entry.id ?? null;
		expect(target).not.toBeNull();
		const reopenCalls: (string | undefined)[] = [];
		let call = 0;
		(env.ctx as { treeSelect?: unknown }).treeSelect = async (opts: { initialSelectedId?: string }) => {
			call++;
			reopenCalls.push(opts.initialSelectedId);
			return call === 1 ? target : null; // round 2: user cancels the tree
		};
		(env.ctx as { select?: unknown }).select = async () => null; // Esc at the ask
		await dispatchCommand("/tree", env.ctx);
		expect(call).toBe(2);
		expect(reopenCalls).toEqual([undefined, target]); // preselected on re-open
		expect(env.output()).not.toContain("navigated"); // nothing moved
	});

	it("onCopy rides the ctx.copyText seam: text → status; undefined → error (D7)", async () => {
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		const env = await branchedEnvC();
		let onCopy: ((text: string | undefined) => void) | undefined;
		(env.ctx as { treeSelect?: unknown }).treeSelect = async (opts: {
			onCopy?: (t: string | undefined) => void;
		}) => {
			onCopy = opts.onCopy;
			return null;
		};
		const copied: string[] = [];
		(env.ctx as { copyText?: unknown }).copyText = async (text: string) => {
			copied.push(text);
		};
		await dispatchCommand("/tree", env.ctx);
		expect(onCopy).toBeDefined();
		onCopy?.("grabbed text");
		await new Promise((r) => setTimeout(r, 10)); // the void promise flushes
		expect(copied).toEqual(["grabbed text"]);
		expect(env.output()).toContain("Copied selected entry to clipboard");
		const base = env.output().length;
		onCopy?.(undefined);
		expect(env.output().slice(base)).toContain("no text to copy");
		// a REJECTED write surfaces as an error note (impl-review P3-4)
		(env.ctx as { copyText?: unknown }).copyText = async () => {
			throw new Error("no clipboard tool");
		};
		const base2 = env.output().length;
		onCopy?.("more text");
		await new Promise((r) => setTimeout(r, 10));
		expect(env.output().slice(base2)).toContain("imp: copy failed — no clipboard tool");
	});
});
