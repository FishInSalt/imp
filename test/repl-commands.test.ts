import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPrompt } from "../src/core/commands-md.js";
import type { AgentMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { setTrust } from "../src/core/trust.js";
import type { LLMRequest } from "../src/provider/types.js";
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
	const submitted: string[] = [];
	const exitCodes: number[] = [];
	const banner = output(); // ▪ resumed … line from seeding, if any
	const trustStore = path.join(baseDir, "trust.json");
	const env: TestEnv = {
		cwd,
		baseDir,
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
				"  /sessions          list saved sessions for this directory",
				"  /resume <id>       switch to a saved session (history replays on screen)",
				"  /model [id]        show the current model, or switch (applies next turn)",
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
				"  newline            Shift+Enter · Ctrl+J · backslash at end of line + Enter",
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
				"switch with: /model <id> — e.g. claude-sonnet-4-5, glm-4.6 (any id your endpoint accepts)\n",
		);
		await dispatchCommand("/model glm-4.6", env.ctx);
		expect(env.output()).toContain("▪ model: claude-sonnet-4-5 → glm-4.6 (applies from the next turn)\n");
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
			return options.items.findIndex((item) => item.label === "glm-4.6");
		};
		await dispatchCommand("/model", env.ctx);
		expect(calls).toHaveLength(1);
		const labels = calls[0]?.items.map((item) => item.label);
		expect(labels).toEqual(["claude-sonnet-4-5", "glm-4.6", "glm-4.5", "glm-4.7"]); // v1 candidates
		expect(calls[0]?.title).toContain("model");
		expect(env.runner.model).toBe("glm-4.6");
		expect(env.output()).toBe("▪ model: claude-sonnet-4-5 → glm-4.6 (applies from the next turn)\n");
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
		expect(env.output()).toBe("▪ model: my-own-model → my-own-model (applies from the next turn)\n"); // identical to /model <id> on the same id
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
				"switch with: /model <id> — e.g. claude-sonnet-4-5, glm-4.6 (any id your endpoint accepts)\n",
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
				"known: /help /exit /new /fork /sessions /resume /model /worktrees /trust /status /compact — /help shows what they do\n",
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
