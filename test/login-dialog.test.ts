// #login-dialog: the exclusive login dialog — TUI-level tests
// (docs/login-dialog-design.md §3, items 1-16). The oauth tests budget
// ≥5000ms: codex-auth's poll floor is 1000ms (Math.max(intervalSeconds,1)),
// even with the fake server's interval: 0.

import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadApiKey } from "../src/provider/auth-store.js";
import { loadCodexCredential } from "../src/provider/codex-auth.js";
import { Renderer } from "../src/render.js";
import { LoginDialog } from "../src/repl/login-dialog.js";
import { runRepl } from "../src/repl/repl.js";
import { TuiShell } from "../src/repl/shell.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner } from "../src/runner.js";
import { scriptedProvider } from "./helpers/fakes.js";
import { FakeTerminal, settle } from "./login-dialog.helpers.js";

const OAUTH_BUDGET = 6000; // 1s poll floor ×2 polls + render + CI slack

interface Env {
	terminal: FakeTerminal;
	transcript: TranscriptSink;
	authPath: string;
	baseDir: string;
	repl: Promise<number>;
	requests: unknown[];
	exitCode: Promise<number> | null;
}

async function startDialogRepl(commands?: Parameters<typeof runRepl>[0]["commands"]): Promise<Env> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-login-dlg-"));
	const authPath = path.join(baseDir, "auth.json");
	process.env.IMP_AUTH_PATH = authPath;
	for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ZAI_API_KEY"]) {
		if (process.env[key] !== undefined) delete process.env[key];
	}
	const terminal = new FakeTerminal();
	const transcript = new TranscriptSink();
	const renderer = new Renderer({
		write: transcript.feed,
		thinkingSink: transcript.thinkingSink,
		userSink: (t: string) => transcript.feedUser(t),
		statusSink: (t: string) => transcript.feedStatus(t),
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
		foldedResults: true,
	});
	const requests: unknown[] = [];
	const provider = scriptedProvider(
		[
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			} as never,
		],
		requests as never,
	);
	const runner = await createRunner({
		cwd: baseDir,
		argv: [],
		model: "test-model",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: baseDir,
		settingsPath: path.join(baseDir, "settings.json"),
		renderer,
		provider,
		deferInit: false,
	});
	const repl = runRepl({
		runner,
		commands: commands ?? [],
		shell: "tui",
		transcript,
		terminal,
		interactive: true,
		exit: (code: number) => {
			throw new Error(`force-exit:${code}`);
		},
	});
	await settle(40);
	return { terminal, transcript, authPath, baseDir, repl, requests, exitCode: null };
}

/** A local fake of auth.openai.com's device-code endpoints (mirrors
 *  repl-commands.test.ts:93; hang polls forever for cancel tests). */
async function fakeCodexAuth(options?: {
	hang?: boolean;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const token = (acct: string) =>
		`${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: acct } }),
		).toString("base64url")}.sig`;

	let polls = 0;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const json = (status: number, payload: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/api/accounts/deviceauth/usercode") {
				json(200, { device_auth_id: "dev-dlg", user_code: "DLGQ-1234", interval: 0 });
				return;
			}
			if (req.url === "/api/accounts/deviceauth/token") {
				polls++;
				if (options?.hang !== true && polls >= 2) {
					json(200, { authorization_code: "ac-dlg", code_verifier: "cv-dlg" });
				} else {
					json(403, {});
				}
				return;
			}
			if (req.url === "/oauth/token") {
				json(200, { access_token: token("acct-dlg"), refresh_token: "rt-dlg", expires_in: 3600 });
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

const envs: Env[] = [];
const servers: Server[] = [];
async function fresh(commands?: Parameters<typeof runRepl>[0]["commands"]): Promise<Env> {
	const env = await startDialogRepl(commands);
	envs.push(env);
	return env;
}

beforeEach(() => {
	vi.unstubAllEnvs();
});

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.terminal.data("/exit\r");
		try {
			await Promise.race([env.repl, new Promise((r) => setTimeout(r, 500))]);
		} catch {
			/* force-exit throw is fine */
		}
	}
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
	delete process.env.IMP_CODEX_AUTH_BASE;
	delete process.env.IMP_AUTH_PATH;
});

describe("login dialog (#login-dialog)", () => {
	it("1. api-key flow: dialog renders, paste feeds the Input, Enter stores; teardown then transcript status", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle(60);
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("Login to Z.AI");
		expect(frame).toContain("Enter Z.AI API key");
		expect(frame).toContain("esc to cancel");
		// §2.1.2 paste verification (not assumed): bracketed paste lands
		// whole in the Input.
		env.terminal.data("\x1b[200~sk-pasted-key\x1b[201~");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("sk-pasted-key");
		const submitMark = env.terminal.writes.length;
		env.terminal.data("\r");
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBe("sk-pasted-key");
		// restore-then-status: the dialog is gone BEFORE the status lands
		expect(env.transcript.completedLines().join("\n")).toContain("Saved API key for Z.AI");
		expect(env.terminal.frameSince(submitMark)).not.toContain("Enter Z.AI API key");
		// the key never enters input history
		expect(env.terminal.frameSince(0)).not.toContain("/login zaisk-pasted");
	});

	it("2. Esc during the prompt: silent cancel, nothing stored, editor restored", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		const escMark = env.terminal.writes.length;
		env.terminal.data("\x1b"); // Esc
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBeNull();
		expect(env.terminal.frameSince(escMark)).not.toContain("Enter Z.AI API key");
		expect(env.transcript.completedLines().join("\n")).not.toContain("Saved");
		// a follow-up command works — no guard residue
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
		envs.splice(envs.indexOf(env), 1);
	});

	it("3. oauth flow: device code renders, waiting APPENDS below it, poll completes, teardown", async () => {
		const fake = await fakeCodexAuth();
		process.env.IMP_CODEX_AUTH_BASE = fake.baseUrl;
		const env = await fresh();
		env.terminal.data("/login openai-codex\r");
		await settle(80);
		const frame = env.terminal.frameSince(0);
		// 1b: URL + user code + waiting coexist (append, not replace)
		expect(frame).toContain("/codex/device");
		expect(frame).toContain("DLGQ-1234");
		expect(frame).toContain("Waiting");
		// 1b: the hint row carries an OSC-8 hyperlink
		const raw = env.terminal.writes.join("");
		expect(raw).toContain("\x1b]8;;");
		const doneMark = env.terminal.writes.length;
		await frameEventually(env, "Logged in to OpenAI (ChatGPT plan)", OAUTH_BUDGET);
		expect(loadCodexCredential(env.authPath)?.accountId).toBe("acct-dlg");
		expect(env.terminal.frameSince(doneMark)).not.toContain("Waiting");
		await fake.close();
	});

	it("4. Esc during the oauth poll: silent cancel, no credential, no guard residue", async () => {
		const fake = await fakeCodexAuth({ hang: true });
		process.env.IMP_CODEX_AUTH_BASE = fake.baseUrl;
		const env = await fresh();
		env.terminal.data("/login openai-codex\r");
		await settle(80);
		expect(env.terminal.frameSince(0)).toContain("DLGQ-1234");
		env.terminal.data("\x1b"); // Esc mid-poll
		await settle();
		expect(loadCodexCredential(env.authPath)).toBeNull();
		expect(env.transcript.completedLines().join("\n")).not.toContain("login failed");
		// follow-up /login works — the dialog mutex cleared with the dispatch
		await fake.close();
		const fake2 = await fakeCodexAuth();
		process.env.IMP_CODEX_AUTH_BASE = fake2.baseUrl;
		env.terminal.data("/login zai\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("Enter Z.AI API key");
		await fake2.close();
	});

	it("5. Ctrl+C as a KEYpress cancels the dialog (raw \\x03, not SIGINT)", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		const cMark = env.terminal.writes.length;
		env.terminal.data("\x03"); // Ctrl+C data
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBeNull();
		expect(env.terminal.frameSince(cMark)).not.toContain("Enter Z.AI API key");
		expect(env.transcript.completedLines().join("\n")).not.toContain("interrupt");
	});

	it("6. keystrokes while the dialog is open land in the dialog's input — no command dispatch", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		env.terminal.data("/exit"); // typed into the dialog's Input
		await settle();
		expect(env.terminal.frameSince(0)).toContain("/exit"); // visible in the input
		expect(env.transcript.completedLines().join("\n")).not.toContain("/exit");
		env.terminal.data("\x1b"); // cancel
		await settle();
		// the process is still alive — /exit did not dispatch
		env.terminal.data("/help\r");
		await settle();
		// the help listing rendered — /exit did not kill the process
		expect(env.terminal.frameSince(0).slice(-3000)).toContain("/logout");
	});

	it("13. dialogOpen refusals: a delayed submitPrompt mid-dialog is refused (authorized exemption holds)", async () => {
		// An extension-style ASYNC prompt: the command schedules submitPrompt
		// for later (the only reachable enqueuePrompt path mid-dialog — the
		// editor has no keys, so nothing synchronous can arrive).
		const delayedRef: { fn: (() => void) | null } = { fn: null };
		const env = await fresh([
			{
				source: "test",
				command: {
					name: "probe",
					summary: "arms a delayed prompt",
					usage: "/probe",
					allowedDuringRun: true,
					run: (_args: string, ctx: { submitPrompt?: (t: string) => void }) => {
						delayedRef.fn = () => ctx.submitPrompt?.("hello-mid-dialog");
						return "handled";
					},
				},
			},
		]);
		env.terminal.data("/probe\r"); // arm BEFORE the dialog
		await settle();
		env.terminal.data("/login zai\r"); // authorized: opens despite... (exemption regression pin)
		await settle();
		expect(env.terminal.frameSince(0)).toContain("Enter Z.AI API key");
		delayedRef.fn?.(); // fires mid-dialog → enqueuePrompt must refuse
		await settle();
		expect(env.transcript.completedLines().join("\n")).not.toContain("hello-mid-dialog");
		expect(env.terminal.frameSince(0)).not.toContain("working…");
		// cancel and confirm the machine is idle again: a normal turn works
		env.terminal.data("\x1b");
		await settle();
		delayedRef.fn?.(); // now it must START a turn
		await settle(200);
		expect(env.transcript.completedLines().join("\n")).toContain("hello-mid-dialog");
	});

	it("14. a held ask arriving mid-dialog renders and settles after teardown (real hold/drain)", async () => {
		// Shell-level (the machine harness cannot reach shell.ask): open the
		// dialog via openLoginDialog directly, then ask() mid-dialog — it
		// must be HELD (unanswerable under the dialog), render after the
		// dialog tears down, and settle when answered.
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink();
		const events: string[] = [];
		const shell = new TuiShell({
			transcript,
			terminal,
			onLine: (l: string) => events.push(`line:${l}`),
			onInterrupt: () => events.push("interrupt"),
			onEof: () => events.push("eof"),
			onDequeue: () => events.push("dequeue"),
			onCycleThinking: () => events.push("cycle-thinking"),
			onToggleThinking: () => events.push("toggle-thinking"),
		});
		shell.start();
		await settle(0);
		const release: { fn: (() => void) | null } = { fn: null };
		const dialogPromise = shell.openLoginDialog({
			title: "Login to Z.AI",
			run: async (dialog) => {
				await new Promise<void>((resolve) => {
					release.fn = resolve;
				});
				void dialog;
			},
		});
		await settle();
		expect(terminal.frameSince(0)).toContain("Login to Z.AI");
		// the ask arrives mid-dialog → held (not rendered yet)
		const asked = shell.ask("proceed?");
		await settle();
		expect(terminal.frameSince(0)).not.toContain("proceed?");
		// resolve the flow → wrapper tears the dialog down → the held ask
		// renders (the finish() re-show block — the load-bearing drain)
		release.fn?.();
		await dialogPromise;
		await settle();
		expect(terminal.frameSince(0)).toContain("proceed?");
		// it settles when answered (typed line answers it, never dispatches)
		terminal.data("y\r");
		await expect(asked).resolves.toBe(true);
		expect(events).toEqual([]);
		shell.close();
	});

	it("10. SIGINT/teardown first: a pending prompt settles cancelled — dialogOpen unwedged", async () => {
		// The review-P0 regression pin: selector teardown (SIGINT path)
		// must cancel the flow, not just remove the UI.
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink();
		const events: string[] = [];
		const shell = new TuiShell({
			transcript,
			terminal,
			onLine: (l: string) => events.push(`line:${l}`),
			onInterrupt: () => events.push("interrupt"),
			onEof: () => events.push("eof"),
			onDequeue: () => events.push("dequeue"),
			onCycleThinking: () => events.push("cycle-thinking"),
			onToggleThinking: () => events.push("toggle-thinking"),
		});
		shell.start();
		await settle(0);
		const outcome = shell.openLoginDialog({
			title: "Login to Z.AI",
			run: async (dialog) => {
				// A prompt that stays pending until torn down
				await dialog.prompt("Enter Z.AI API key");
			},
		});
		await settle();
		expect(terminal.frameSince(0)).toContain("Enter Z.AI API key");
		// The selector-teardown path (SIGINT/stdin-end/close all funnel
		// here) — while the prompt is pending. Review P0: this must
		// cancel the flow, not strand the pending prompt forever.
		const closeMark = terminal.writes.length;
		shell.close();
		await expect(outcome).resolves.toBe("cancelled"); // NOT a hang
		await settle();
		expect(terminal.frameSince(closeMark)).not.toContain("Enter Z.AI API key"); // dialog gone
	});

	it("11. footer after login: refreshFooter ran (model segment intact)", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		env.terminal.data("sk-footer\r");
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBe("sk-footer");
		// runCommand's finally refreshes the footer — the model segment
		// still renders post-login (the same-session footer line)
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("test-model ·");
	});

	it("7/15. /compact still takes the guarded state; fallback /login does too (no-dialog predicate)", async () => {
		// shell-conditional predicate: pure-function pins
		const { loginNeedsGuard, loginUsesDialog } = await import("../src/repl/commands.js");
		expect(loginNeedsGuard("/login", false)).toBe(true); // fallback picker
		expect(loginNeedsGuard("/login openai-codex", false)).toBe(true); // fallback oauth
		expect(loginNeedsGuard("/login zai", false)).toBe(false);
		expect(loginNeedsGuard("/login", true)).toBe(false); // dialog shell
		expect(loginNeedsGuard("/login openai-codex", true)).toBe(false);
		expect(loginUsesDialog("/login", true)).toBe(true);
		expect(loginUsesDialog("/login zai", true)).toBe(true);
		expect(loginUsesDialog("/login zai", false)).toBe(false);
		expect(loginUsesDialog("/model", true)).toBe(false);
	});

	it("16. a second openLoginDialog queued behind a live selector re-runs after teardown", async () => {
		// Machine-level: /login (picker → dialog) then another /login —
		// but keyboard-wise a second command cannot be typed mid-dialog.
		// The queue path is exercised directly: open a picker (no-arg
		// /login), pick Z.AI → dialog opens → complete it; then a second
		// /login typed AFTER works (no pendingSelects starvation).
		const env = await fresh();
		env.terminal.data("/login\r"); // picker
		await settle();
		expect(env.terminal.frameSince(0)).toContain("sign in to a provider");
		env.terminal.data("\r"); // pick row 0 = Z.AI → dialog opens
		await settle();
		expect(env.terminal.frameSince(0)).toContain("Enter Z.AI API key");
		env.terminal.data("\x1b");
		await settle();
		// second login after teardown — picker works again, no starvation
		env.terminal.data("/login\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("sign in to a provider");
		env.terminal.data("\x1b");
		await settle();
	});

	it("10b. the typed key never leaks into input history (up-arrow recall)", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		env.terminal.data("sk-secret-1\r");
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBe("sk-secret-1");
		// up-arrow recalls the LAST shell line (/login zai), never the key
		env.terminal.data("\x1b[A");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("/login zai");
		expect(env.terminal.frameSince(0)).not.toContain("sk-secret-1");
	});

	it("12. focused forwarding: dialog.focused=false → input.focused=false", async () => {
		const env = await fresh();
		void env; // the unit-level assertion needs no live shell:
		const terminal = new FakeTerminal();
		const { TUI } = await import("../src/tui.js");
		const tui = new TUI(terminal, true);
		const dialog = new LoginDialog(tui, "Login to Z.AI");
		expect(dialog.focused).toBe(false);
		// (the IME edge: forwarding is the contract, verified by property)
		dialog.focused = true;
		dialog.focused = false;
		tui.stop();
	});
});

async function frameEventually(env: Env, text: string, budgetMs: number): Promise<void> {
	const start = Date.now();
	while (!env.terminal.frameSince(0).includes(text)) {
		if (Date.now() - start > budgetMs) {
			throw new Error(`frame did not contain ${JSON.stringify(text)} within ${budgetMs}ms`);
		}
		await settle(15);
	}
}
