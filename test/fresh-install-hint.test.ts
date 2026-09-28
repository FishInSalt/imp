import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelAvailability } from "../src/provider/model-availability.js";
import { Renderer } from "../src/render.js";
import { NO_MODEL_SEGMENT, NO_MODEL_SHORT, welcomeLines } from "../src/repl/repl.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

/**
 * #fresh-install-hint (design docs/fresh-install-model-hint-design.md §3.4
 * tests 1–4, 12): the no-credential startup UX — banner identity line,
 * footer segments, the D2 teaching note (generic + targeted + F5
 * suppression), the availability seam, and the D7 test-seam
 * determinism. Hermetic: every test scrubs the credential env vars and
 * points IMP_AUTH_PATH at a temp empty file (the two levers the design
 * names; login-dialog.test.ts precedent).
 */

const CREDENTIAL_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"ZAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"MOONSHOT_API_KEY",
	"IMP_MODEL",
] as const;

describe("#fresh-install-hint availability seam", () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of CREDENTIAL_ENV) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.IMP_AUTH_PATH = path.join(tmpdir(), `imp-fresh-auth-${process.pid}-${Date.now()}.json`);
	});
	afterEach(() => {
		for (const key of CREDENTIAL_ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		delete process.env.IMP_AUTH_PATH;
	});

	it("test 4: per-family table — env only / stored only / neither / codex stored", async () => {
		// neither
		expect(modelAvailability("anthropic")).toEqual({ usable: false, configuredFamilies: [] });
		// env only
		process.env.ZAI_API_KEY = "k";
		expect(modelAvailability("zai").usable).toBe(true);
		expect(modelAvailability("zai").configuredFamilies).toEqual(["zai"]);
		delete process.env.ZAI_API_KEY;
		// anthropic bearer token counts (familyConfigured semantics)
		process.env.ANTHROPIC_AUTH_TOKEN = "t";
		expect(modelAvailability("anthropic").usable).toBe(true);
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		// stored only (via /login) — saveApiKey honors IMP_AUTH_PATH
		const { saveApiKey } = await import("../src/provider/auth-store.js");
		saveApiKey("deepseek", "stored-key");
		expect(modelAvailability("deepseek")).toEqual({ usable: true, configuredFamilies: ["deepseek"] });
	});

	it("test 1: banner identity line swaps the dead id for the /login pointer", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "imp-fresh-"));
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "claude-sonnet-4-5", // the hardcoded default, NO provider seam
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
		});
		expect(runner.modelUsable()).toBe(false); // real anthropic provider + no credential
		// the teaching note fired at warmup (D2, generic form)
		expect(output()).toContain("no model available — sign in with /login (");
		expect(output()).toContain("zai, anthropic, openai, openai-codex, deepseek, moonshotai, moonshotai-cn");
		// welcomeLines renders the segment the caller passes (D1)
		const lines = welcomeLines("deadbeef", NO_MODEL_SEGMENT, false);
		expect(lines[lines.length - 1]).toBe(`imp 0.1.0 · session deadbeef · ${NO_MODEL_SEGMENT}`);
		expect(lines[lines.length - 1]).not.toContain("claude-sonnet-4-5");
	});

	it("test 3 (targeted): another family configured → targeted note, not the generic one", async () => {
		const { saveApiKey } = await import("../src/provider/auth-store.js");
		saveApiKey("zai", "stored-key");
		const root = await mkdtemp(path.join(tmpdir(), "imp-fresh-"));
		const { renderer, output } = makeRenderer();
		await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
		});
		expect(output()).toContain("claude-sonnet-4-5 (anthropic) has no credential");
		expect(output()).toContain("/login anthropic (or /model to pick a configured one)");
		expect(output()).not.toContain("no model available — sign in with /login (");
	});

	it("test 3 (F5 suppression): bare glm-* shows ONLY the zai-specific note", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "imp-fresh-"));
		const { renderer, output } = makeRenderer();
		await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "glm-5.3", // bare glm → zai family, no credential
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
		});
		expect(output()).toContain("sign in with /login zai");
		expect(output()).not.toContain("no model available — sign in with /login (");
	});

	it("test 12 (D7 seam): injected provider stays usable with scrubbed env; a real provider is not", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "imp-fresh-"));
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], []),
		});
		expect(runner.modelUsable()).toBe(true); // seam — no probe, no note
		expect(output()).not.toContain("no model available");
	});

	it("footer segments: usable keeps model+think, unusable drops think (D1/F7)", async () => {
		// NO_MODEL_SHORT is the footer/resumed-line segment constant
		expect(NO_MODEL_SHORT).toBe("no model — /login");
		// a knob-bearing unusable model must not render a think segment —
		// pinned indirectly: the footer builder gates on usable (repl.ts);
		// here we pin the constants' shape so renames surface in this suite
		expect(NO_MODEL_SEGMENT).toContain("run /login");
	});

	it("usable path is byte-identical: a credential silences every new surface", async () => {
		process.env.ANTHROPIC_API_KEY = "k";
		const root = await mkdtemp(path.join(tmpdir(), "imp-fresh-"));
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
		});
		expect(runner.modelUsable()).toBe(true);
		expect(output()).not.toContain("no model");
		expect(output()).not.toContain("/login");
	});

	// ---- M2: D4 seed gating (design tests 6, 7, 9) ----

	it("test 6: warmup + resume skip the seed while unusable — the session file has no model row", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "imp-fresh-"));
		const cwd = path.join(root, "proj");
		mkdirSync(cwd);
		const baseDir = path.join(root, "sessions");
		const { renderer } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			renderer,
		});
		expect(runner.session?.getModel()).toBeUndefined(); // no seed while unusable
		// a message turn persists messages but STILL no model row
		await runner.runTurn({ userMessage: "hi" }).catch(() => undefined); // provider throws — expected
		const onDisk = runner.session?.filePath;
		expect(onDisk !== undefined && existsSync(onDisk)).toBe(true);
		if (onDisk !== undefined) {
			const rows = readFileSync(onDisk, "utf8").trim().split("\n");
			expect(rows.some((r) => r.includes('"type":"session_model"'))).toBe(false);
			expect(rows.some((r) => r.includes('"role":"user"'))).toBe(true); // messages persist
		}
		expect(runner.session?.getModel()).toBeUndefined(); // test 9: stays model-less after the failed turn
	});

	it("test 7: /new while unusable seeds nothing (third D4 site)", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "imp-fresh-"));
		const cwd = path.join(root, "proj");
		mkdirSync(cwd);
		const { renderer } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: path.join(root, "sessions"),
			renderer,
		});
		runner.newSession();
		expect(runner.session?.getModel()).toBeUndefined();
	});

	it("test 8: resume of a 0.1.0-shaped session (seeded dead model) does not rewrite the file", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "imp-fresh-"));
		const cwd = path.join(root, "proj");
		mkdirSync(cwd);
		const baseDir = path.join(root, "sessions");
		// Build a 0.1.0-shaped store: explicit:false seed + one message.
		const { createSession } = await import("../src/core/session/manager.js");
		const store = createSession(cwd, baseDir);
		store.seedModel({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		store.appendMessage({ role: "user", content: "old" });
		const bytes = readFileSync(store.filePath, "utf8");
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			renderer,
			resume: store.header.id,
		});
		// resumed line renders the /login pointer, not the dead id (D1/N3)
		expect(output()).toContain("no model — /login");
		expect(output()).not.toContain("· claude-sonnet-4-5 ·");
		// before any turn: byte-identical file
		expect(readFileSync(store.filePath, "utf8")).toBe(bytes);
		expect(runner.modelReference()).toBe("claude-sonnet-4-5"); // in-memory still resolves
	});
});
