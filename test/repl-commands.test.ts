import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPrompt } from "../src/core/commands-md.js";
import type { AgentMessage, UserMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { loadSettings } from "../src/core/settings.js";
import { setTrust } from "../src/core/trust.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import type { CommandContext } from "../src/repl/commands.js";
import { dispatchCommand, helpText, parseCommand } from "../src/repl/commands.js";
import type { SelectOptions } from "../src/repl/line-input.js";
import { createRunner, type Runner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider, waitUntil } from "./helpers/fakes.js";

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
	run(["init", "-q"], root);
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

async function makeEnv(args?: {
	seed?: AgentMessage[];
	noSession?: boolean;
	active?: boolean;
	provider?: LLMProvider;
	model?: string;
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
				"  /tree              switch to another branch of this conversation (the left one is summarized in)",
				"  /sessions          list saved sessions for this directory",
				"  /resume <id>       switch to a saved session (history replays on screen)",
				"  /model [id]        show the current model, or switch (applies next turn)",
				"  /think [level]     show or set the thinking level; no argument cycles (shift+tab)",
				"  /worktrees         list worktrees kept for a manual merge (M6b handbacks)",
				"  /trust             show the project-trust decision for this directory (and all records)",
				"  /status            session, model, context, and trust at a glance",
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
				"  follow-up          Alt+Enter queues the line to run AFTER the running turn",
				"                     (plain Enter steers into it)",
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
		await dispatchCommand("/model glm-4.6", env.ctx);
		expect(env.output()).toContain("Model: glm-4.6\n");
		expect(env.runner.model).toBe("glm-4.6");
		const result = await env.runner.runTurn({ userMessage: "hi" });
		expect(env.requests[0]?.model).toBe("glm-4.6");
		expect(result.stopReason).toBe("completed");
	});

	it("HELP_KEYS documents the M10 affordances: Esc interrupt, newline keys, ! prefix, autocomplete keys", () => {
		const text = helpText();
		for (const line of [
			"  Esc                abort the running turn (same as Ctrl+C); with the",
			"  newline            Shift+Enter · Ctrl+J · backslash at end of line + Enter",
			"  follow-up          Alt+Enter queues the line to run AFTER the running turn",
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
		expect(env.output()).toBe("Model: zai/glm-5.3\n"); // the zai prefix IS the connection tell
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
				"known: /help /exit /new /fork /tree /sessions /resume /model /think /worktrees /trust /status /compact — /help shows what they do\n",
		);
		expect(env.requests).toHaveLength(0);
		// bare "/" gets the same teaching error with the empty name
		const bare = await makeEnv();
		await dispatchCommand("/", bare.ctx);
		expect(bare.output()).toContain('imp: unknown command "/"\n');
		expect(bare.requests).toHaveLength(0);
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
		expect(out).toContain("2 messages kept, 2 left on the old branch");
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
		expect(env.output()).toContain("0 messages kept, 4 left on the old branch");
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

	it("with no other branches: teaching note", async () => {
		const env = await makeEnv({ seed: [user("q1"), assistantText("a1")] });
		await dispatchCommand("/tree", env.ctx);
		expect(env.output()).toContain("only one branch");
	});

	it("text fallback lists tips; /tree <n> switches and replays (summary off)", async () => {
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		const env = await branchedEnv();
		await dispatchCommand("/tree", env.ctx);
		let out = env.output();
		expect(out).toContain("q2-old");
		expect(out).toContain("/tree <n>");
		await dispatchCommand("/tree 1", env.ctx);
		out = env.output();
		expect(out).toContain("switched branches");
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
		await dispatchCommand("/tree 1", env.ctx); // switch back — left branch is EMPTY
		expect(env.output()).toContain("nothing was written on the left branch to summarize");
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
			await dispatchCommand("/model glm-4.6", env.ctx); // same family → keeps the fake; window re-read from env
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
		await dispatchCommand("/model glm-4.6", env.ctx); // same family: keeps the provider instance
		expect(env.runner.model).toBe("glm-4.6");
		expect(env.runner.contextWindow).toBe(200_000);
		await dispatchCommand("/model openai-codex/gpt-5.4", env.ctx); // cross-family: provider swaps
		expect(env.runner.model).toBe("gpt-5.4");
		expect(env.runner.contextWindow).toBe(272_000);
		// pi's showStatus form: consecutive switches print one dim line each
		expect(env.output()).toContain("Model: glm-4.6");
		expect(env.output()).toContain("Model: openai-codex/gpt-5.4"); // canonical — the family is visible (P2-5)
		await dispatchCommand("/model glm-4.6", env.ctx); // and back
		expect(env.runner.model).toBe("glm-4.6");
	});

	it("bad args teach; running is rejected", async () => {
		const env = await branchedEnv();
		await dispatchCommand("/tree 5", env.ctx);
		expect(env.output()).toContain("#1–#1");
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
		await dispatchCommand("/tree 1", env.ctx);
		expect(env.output()).toContain("summarized in context");
		expect(requests).toHaveLength(1); // exactly one call — the summary
		const firstMsg = requests[0]?.messages[0] as UserMessage | undefined;
		const summaryText = firstMsg?.content ?? "";
		expect(summaryText).toContain("q3-new direction"); // the LEFT branch's content
		expect(summaryText).not.toContain("q1"); // the shared trunk is not re-summarized
		// the new context carries the framed summary
		const framed = env.runner.history.find(
			(m): m is UserMessage => m.role === "user" && m.content.startsWith("[Branch summary \u2014"),
		);
		expect(framed?.content).toContain("tried q3-work");
	});

	it("picker cancel is silent; a pick switches", async () => {
		vi.stubEnv("IMP_BRANCH_SUMMARY", "0");
		const env = await branchedEnv();
		let answer: number | null = null;
		(env.ctx as { select?: unknown }).select = async () => answer;
		const base = env.output().length; // ignore the setup fork's note
		await dispatchCommand("/tree", env.ctx);
		expect(env.output().slice(base)).toBe("");
		answer = 0;
		await dispatchCommand("/tree", env.ctx);
		expect(env.output().slice(base)).toContain("switched branches");
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

	it("GLM connection tell: a bare glm id on anthropic-compat teaches the zai path once; prefixed/zai routes stay silent", async () => {
		// bare id, no ZAI_API_KEY → anthropic-compat + the teaching note
		const env = await makeEnv();
		await dispatchCommand("/model glm-5.3", env.ctx);
		expect(env.runner.providerName).toBe("anthropic");
		expect(env.output()).toContain("Model: glm-5.3"); // bare — no zai prefix
		expect(env.output()).toContain("runs via anthropic-compat");
		// explicit anthropic/ prefix — a deliberate choice, no note
		const quiet = await makeEnv();
		await dispatchCommand("/model anthropic/glm-5.3", quiet.ctx);
		expect(quiet.runner.providerName).toBe("anthropic");
		expect(quiet.output()).not.toContain("anthropic-compat");
		// ZAI_API_KEY present → the same bare id routes to zai, prefix shows, no note
		const zaiEnv = await makeEnv();
		const prev = process.env.ZAI_API_KEY;
		process.env.ZAI_API_KEY = "sk-test";
		try {
			await dispatchCommand("/model glm-5.3", zaiEnv.ctx);
			expect(zaiEnv.runner.providerName).toBe("zai");
			expect(zaiEnv.output()).toContain("Model: zai/glm-5.3"); // the prefix IS the tell
			expect(zaiEnv.output()).not.toContain("anthropic-compat");
		} finally {
			if (prev === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = prev;
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
