import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import type { LLMRequest } from "../src/provider/types.js";
import type { CommandContext } from "../src/repl/commands.js";
import { dispatchCommand, helpText, parseCommand } from "../src/repl/commands.js";
import { createRunner, type Runner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

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
	/** Hermetic test paths (create extra sessions with these). */
	cwd: string;
	baseDir: string;
	runner: Runner;
	ctx: CommandContext;
	output(): string;
	requests: LLMRequest[];
	exitCodes: number[];
	aborted: boolean;
}

async function makeEnv(args?: {
	seed?: AgentMessage[];
	noSession?: boolean;
	active?: boolean;
}): Promise<TestEnv> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-cmds-"));
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
		model: "claude-sonnet-4-5",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: args?.noSession ?? false,
		resume: store ? store.header.id : undefined,
		sessionBaseDir: baseDir,
		renderer,
		provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests),
	});
	const replayed: string[] = [];
	const exitCodes: number[] = [];
	const banner = output(); // ▪ resumed … line from seeding, if any
	const env: TestEnv = {
		cwd,
		baseDir,
		runner,
		output: () => output().slice(banner.length),
		requests,
		exitCodes,
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
	it("/help lists all seven (generated, cannot drift)", async () => {
		const env = await makeEnv();
		await dispatchCommand("/help", env.ctx);
		const text = env.output();
		for (const label of ["/help", "/exit", "/new", "/sessions", "/resume <id>", "/model [id]", "/compact"]) {
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
				"  /sessions          list saved sessions for this directory",
				"  /resume <id>       switch to a saved session (history replays on screen)",
				"  /model [id]        show the current model, or switch (applies next turn)",
				"  /compact           summarize older context now",
				"",
				"",
				"Keys:",
				"  Ctrl+C             abort the running turn (press twice to force quit);",
				"                     at an empty prompt: press twice to exit",
				"  Ctrl+D             exit",
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
				"switch with: /model <id> — e.g. claude-sonnet-4-5, glm-4.6 (any id your endpoint accepts)\n",
		);
		await dispatchCommand("/model glm-4.6", env.ctx);
		expect(env.output()).toContain("▪ model: claude-sonnet-4-5 → glm-4.6 (applies from the next turn)\n");
		expect(env.runner.model).toBe("glm-4.6");
		const result = await env.runner.runTurn({ userMessage: "hi" });
		expect(env.requests[0]?.model).toBe("glm-4.6");
		expect(result.stopReason).toBe("completed");
	});

	it("regression m3: /model rejects extra text after the id instead of setting a broken id", async () => {
		const env = await makeEnv();
		await expect(dispatchCommand("/model glm-4.6 extra", env.ctx)).rejects.toThrow(/takes one id/);
		expect(env.runner.model).toBe("claude-sonnet-4-5"); // unchanged — no delayed 404 next turn
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
				"known: /help /exit /new /sessions /resume /model /compact — /help shows what they do\n",
		);
		expect(env.requests).toHaveLength(0);
		// bare "/" gets the same teaching error with the empty name
		const bare = await makeEnv();
		await dispatchCommand("/", bare.ctx);
		expect(bare.output()).toContain('imp: unknown command "/"\n');
		expect(bare.requests).toHaveLength(0);
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
