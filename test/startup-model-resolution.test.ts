import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/format.js";
import { createRunner } from "../src/runner.js";
import {
	type CliFixture,
	collectCliOutput,
	createCliFixture,
	startRejectingProvider,
} from "./helpers/cli-fixture.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDirAsync, tempFilePath } from "./helpers/mktemp.js";

/**
 * #startup-model-resolution (design docs/design/startup-model-resolution-design.md):
 * D1 credential-source uniqueness, D2 startup resolution, D3 restore-path
 * resolution, D4 login-time selection, D5 the /settings defaultModel hint,
 * and the D6 print copy variants. Hermetic: credential env scrubbed +
 * INK_AUTH_PATH pointed at a temp file per test (fresh-install precedent).
 */

const CREDENTIAL_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"ZAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"MOONSHOT_API_KEY",
	"INK_MODEL",
] as const;

describe("#startup-model-resolution", () => {
	const saved: Record<string, string | undefined> = {};
	const fixtures: CliFixture[] = [];
	let provider: Awaited<ReturnType<typeof startRejectingProvider>>;
	function cli(): CliFixture {
		const fixture = createCliFixture({ model: null }); // startup selection is the subject under test
		fixtures.push(fixture);
		return fixture;
	}
	beforeEach(async () => {
		provider = await startRejectingProvider();
		saved.INK_AUTH_PATH = process.env.INK_AUTH_PATH;
		for (const key of CREDENTIAL_ENV) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.INK_AUTH_PATH = tempFilePath("ink-smr-auth-");
	});
	afterEach(async () => {
		await provider.close();
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
		for (const key of CREDENTIAL_ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		if (saved.INK_AUTH_PATH === undefined) delete process.env.INK_AUTH_PATH;
		else process.env.INK_AUTH_PATH = saved.INK_AUTH_PATH;
	});

	// ---- D1: credential-source uniqueness ----

	it("D1: env-only moonshot pair collapses to ambiguous (no resolution)", async () => {
		const { credentialSourceFamilies, resolveStartupModelFallback } = await import(
			"../src/provider/startup-model.js"
		);
		expect(credentialSourceFamilies()).toEqual([]);
		expect(resolveStartupModelFallback()).toBeUndefined();
		process.env.MOONSHOT_API_KEY = "k";
		expect(credentialSourceFamilies()).toEqual([]); // both families from one env var → ambiguous
		expect(resolveStartupModelFallback()).toBeUndefined();
	});

	it("D1: a stored moonshot key disambiguates the pair; both stored is ambiguous", async () => {
		const { credentialSourceFamilies, resolveStartupModelFallback } = await import(
			"../src/provider/startup-model.js"
		);
		const { saveApiKey } = await import("../src/provider/auth-store.js");
		process.env.MOONSHOT_API_KEY = "env-key";
		saveApiKey("moonshotai", "stored");
		expect(credentialSourceFamilies()).toEqual(["moonshotai"]);
		expect(resolveStartupModelFallback()).toEqual({ reference: "moonshotai/kimi-k3", family: "moonshotai" });
		saveApiKey("moonshotai-cn", "stored-cn");
		expect(credentialSourceFamilies()).toEqual([]); // both stored → ambiguous
	});

	it("D1: unique env family resolves to its switchHint; two families do not", async () => {
		const { resolveStartupModelFallback } = await import("../src/provider/startup-model.js");
		process.env.DEEPSEEK_API_KEY = "k";
		expect(resolveStartupModelFallback()).toEqual({
			reference: "deepseek/deepseek-v4-pro",
			family: "deepseek",
		});
		process.env.ZAI_API_KEY = "k";
		expect(resolveStartupModelFallback()).toBeUndefined();
	});

	// ---- D2: the decision table ----

	it("D2 decision: explicit sources, resume, blank, usable — all keep", async () => {
		const { decideStartupModel } = await import("../src/provider/startup-model.js");
		const unusable = (): boolean => false;
		// explicit -m
		expect(
			decideStartupModel({ model: "x", source: "cli", explicit: true, resuming: false, isUsable: unusable }),
		).toEqual({ kind: "keep" });
		// env / project / global sources are user configuration — never overridden
		for (const source of ["env", "project", "global"] as const) {
			expect(
				decideStartupModel({ model: "x", source, explicit: false, resuming: false, isUsable: unusable }),
			).toEqual({ kind: "keep" });
		}
		// resume without -m: D3 owns the decision
		expect(
			decideStartupModel({
				model: "x",
				source: "builtin",
				explicit: false,
				resuming: true,
				isUsable: unusable,
			}),
		).toEqual({ kind: "keep" });
		// blank ids: never resolved
		expect(
			decideStartupModel({
				model: "  ",
				source: "builtin",
				explicit: false,
				resuming: false,
				isUsable: unusable,
			}),
		).toEqual({ kind: "keep" });
		// usable model: keep
		expect(
			decideStartupModel({
				model: "x",
				source: "builtin",
				explicit: false,
				resuming: false,
				isUsable: () => true,
			}),
		).toEqual({ kind: "keep" });
	});

	it("D2 decision: builtin + unusable resolves only for a unique family", async () => {
		const { decideStartupModel } = await import("../src/provider/startup-model.js");
		const unusable = (): boolean => false;
		const input = {
			model: "claude-sonnet-4-5",
			source: "builtin" as const,
			explicit: false,
			resuming: false,
			isUsable: unusable,
		};
		expect(decideStartupModel(input)).toEqual({ kind: "unresolved" }); // zero families
		process.env.ZAI_API_KEY = "k";
		expect(decideStartupModel(input)).toEqual({
			kind: "resolve",
			fallback: { reference: "zai/glm-5.3", family: "zai" },
		});
		process.env.DEEPSEEK_API_KEY = "k";
		expect(decideStartupModel(input)).toEqual({ kind: "unresolved" }); // two families: no guess
	});

	it("D6 segments: noModelText picks /login vs /model; runner probe agrees", async () => {
		const {
			noModelText,
			NO_MODEL_SEGMENT,
			NO_MODEL_SHORT,
			NO_MODEL_SELECTED_SEGMENT,
			NO_MODEL_SELECTED_SHORT,
		} = await import("../src/runner.js");
		expect(noModelText(false)).toBe(NO_MODEL_SEGMENT);
		expect(noModelText(true)).toBe(NO_MODEL_SELECTED_SEGMENT);
		expect(noModelText(false, true)).toBe(NO_MODEL_SHORT);
		expect(noModelText(true, true)).toBe(NO_MODEL_SELECTED_SHORT);
		// zero families → hasConfiguredProviders false; two → true
		const root = await mkTempDirAsync("ink-smr-");
		const { renderer } = makeRenderer();
		const mk = () =>
			createRunner({
				cwd: path.join(root, "proj"),
				argv: [],
				model: "claude-sonnet-4-5",
				maxTokens: 1024,
				maxTurns: 3,
				noContextFiles: true,
				noSession: true,
				renderer,
			});
		const bare = await mk();
		expect(bare.hasConfiguredProviders()).toBe(false);
		process.env.ZAI_API_KEY = "k";
		process.env.DEEPSEEK_API_KEY = "k";
		const multi = await mk();
		expect(multi.hasConfiguredProviders()).toBe(true);
	});

	it("D2 interactive (pipe): the resolution note prints, no dead-model pointer", async () => {
		const { spawn } = await import("node:child_process");
		const fixture = cli();
		const home = fixture.home;
		const cwd = fixture.cwd;
		const BIN = fixture.bin;
		const child = spawn(process.execPath, [BIN], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				ZAI_API_KEY: "dummy",
				// Reject the actual call on the local fixture provider.
				ZAI_BASE_URL: provider.url,
			}),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const { stdout } = await collectCliOutput(child, "hello\n");
		expect(stdout).toContain("no startup model configured — using zai/glm-5.3");
		expect(stdout).not.toContain("no model available — run /login to connect one");
	});

	// ---- D2 end-to-end: print mode ----

	it("D2 print e2e: single family resolves silently and the runner proceeds", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const fixture = cli();
		const home = fixture.home;
		const cwd = fixture.cwd;
		const BIN = fixture.bin;
		const result: unknown = await run(process.execPath, [BIN, "-p", "hello"], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				ZAI_API_KEY: "dummy",
				// Local rejection proves that the PRE-FLIGHT did not block.
				ZAI_BASE_URL: provider.url,
			}),
			timeout: 10_000,
		}).catch((err: unknown) => err);
		const err = result as { stdout: string; stderr: string; code?: number };
		expect(err.code).toBe(1);
		expect(err.stderr).toContain("401");
		expect(provider.requests.length).toBe(1);
		expect(err.stderr).not.toContain("has no credential");
		expect(err.stderr).not.toContain("no model configured");
		expect(err.stderr).not.toContain("no startup model");
		// the runner ran: it wrote a session (fail-fast writes nothing)
		const sessionsDir = path.join(home, ".ink", "sessions");
		const files: string[] = [];
		const walk = (dir: string): void => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir)) {
				const full = path.join(dir, entry);
				if (existsSync(full) && statSync(full).isDirectory()) walk(full);
				else files.push(full);
			}
		};
		walk(sessionsDir);
		expect(files.length).toBeGreaterThan(0);
	});

	it("D6 print copy: zero families fails with the new zero text and writes nothing", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const fixture = cli();
		const home = fixture.home;
		const cwd = fixture.cwd;
		const BIN = fixture.bin;
		const result: unknown = await run(process.execPath, [BIN, "-p", "hello"], {
			cwd,
			env: fixture.env({ INK_AUTH_PATH: path.join(home, "auth.json") }),
			timeout: 10_000,
		}).catch((err: unknown) => err);
		const err = result as { stdout: string; stderr: string; code?: number };
		expect(err.code).toBe(1);
		expect(err.stderr).toContain("no model configured");
		expect(err.stderr).not.toContain("claude-sonnet-4-5 (anthropic) has no credential");
		expect(err.stdout).toBe("");
		const written: string[] = [];
		const walk = (dir: string): void => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir)) {
				const full = path.join(dir, entry);
				if (existsSync(full) && statSync(full).isDirectory()) walk(full);
				else written.push(full);
			}
		};
		walk(path.join(home, ".ink"));
		expect(written.filter((f) => f.includes("/sessions/") || f.includes("/logs/"))).toEqual([]);
	});

	it("D6 print copy: multiple families name them and the -m escape", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const fixture = cli();
		const home = fixture.home;
		const cwd = fixture.cwd;
		const BIN = fixture.bin;
		const result: unknown = await run(process.execPath, [BIN, "-p", "hello"], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				ZAI_API_KEY: "k",
				DEEPSEEK_API_KEY: "k",
			}),
			timeout: 10_000,
		}).catch((err: unknown) => err);
		const err = result as { stdout: string; stderr: string; code?: number };
		expect(err.code).toBe(1);
		expect(err.stderr).toContain("no startup model — configured: zai, deepseek");
		expect(err.stderr).toContain("-m zai/glm-5.3");
	});

	it("D6 print copy: env-only moonshot names both families (impl-review F1)", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const fixture = cli();
		const home = fixture.home;
		const cwd = fixture.cwd;
		const BIN = fixture.bin;
		const result: unknown = await run(process.execPath, [BIN, "-p", "hello"], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				MOONSHOT_API_KEY: "k",
			}),
			timeout: 10_000,
		}).catch((err: unknown) => err);
		const err = result as { stdout: string; stderr: string; code?: number };
		expect(err.code).toBe(1);
		// one credential, two families — ambiguous for RESOLUTION, but the copy
		// must still tell the truth (a provider IS configured).
		expect(err.stderr).toContain("no startup model — configured: moonshotai, moonshotai-cn");
		expect(err.stderr).not.toContain("no model configured");
	});

	// ---- D4: login-time selection ----

	it("D4: /login auto-switches when no usable model exists", async () => {
		const root = await mkTempDirAsync("ink-smr-");
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
		expect(runner.modelUsable()).toBe(false);
		const { COMMANDS } = await import("../src/repl/commands.js");
		const login = COMMANDS.find((c) => c.name === "login");
		expect(login).toBeDefined();
		const ctx = {
			runner,
			renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => false,
			replay: () => 0,
			submitPrompt: () => {},
			secret: async () => "zai-test-key",
		};
		await login?.run("zai", ctx);
		expect(runner.modelReference()).toBe("zai/glm-5.3");
		expect(output()).toContain("▪ switched to zai/glm-5.3");
		expect(output()).not.toContain("switch with /model zai/glm-5.3");
	});

	it("D4 negative: a usable model is never auto-replaced", async () => {
		process.env.ZAI_API_KEY = "env-key";
		const root = await mkTempDirAsync("ink-smr-");
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "zai/glm-4.7",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
		});
		expect(runner.modelUsable()).toBe(true);
		const { COMMANDS } = await import("../src/repl/commands.js");
		const login = COMMANDS.find((c) => c.name === "login");
		const ctx = {
			runner,
			renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => false,
			replay: () => 0,
			submitPrompt: () => {},
			secret: async () => "zai-test-key",
		};
		await login?.run("zai", ctx);
		expect(runner.modelReference()).toBe("zai/glm-4.7");
		expect(output()).not.toContain("▪ switched to");
	});

	// ---- D5: the /settings defaultModel hint ----

	it("D5: explicit /model hints once; suppressed for the resolvable switchHint", async () => {
		process.env.ZAI_API_KEY = "k";
		const root = await mkTempDirAsync("ink-smr-");
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "zai/glm-4.7",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
			projectSettingsAllowed: true,
		});
		const { COMMANDS } = await import("../src/repl/commands.js");
		const model = COMMANDS.find((c) => c.name === "model");
		const ctx = {
			runner,
			renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => false,
			replay: () => 0,
			submitPrompt: () => {},
			hintState: { defaultModelHintShown: false },
		};
		await model?.run("zai/glm-4.6", ctx);
		expect(output()).toContain("▪ /settings defaultModel zai/glm-4.6 keeps this model for new sessions");
		// second switch: hint already shown once
		await model?.run("zai/glm-4.7", ctx);
		const hits = output().split("keeps this model for new sessions").length - 1;
		expect(hits).toBe(1);
	});

	it("D5: no hint when the pick IS what D2 would resolve anyway", async () => {
		process.env.ZAI_API_KEY = "k";
		const root = await mkTempDirAsync("ink-smr-");
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "zai/glm-4.6",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
			projectSettingsAllowed: true,
		});
		const { COMMANDS } = await import("../src/repl/commands.js");
		const model = COMMANDS.find((c) => c.name === "model");
		const ctx = {
			runner,
			renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => false,
			replay: () => 0,
			submitPrompt: () => {},
			hintState: { defaultModelHintShown: false },
		};
		await model?.run("zai/glm-5.3", ctx); // the switchHint itself
		expect(output()).not.toContain("keeps this model for new sessions");
	});

	it("D5 suppression: INK_MODEL pin and gated-off project settings silence the hint", async () => {
		process.env.ZAI_API_KEY = "k";
		const root = await mkTempDirAsync("ink-smr-");
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd: path.join(root, "proj"),
			argv: [],
			model: "zai/glm-4.7",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
			projectSettingsAllowed: true,
		});
		const { COMMANDS } = await import("../src/repl/commands.js");
		const model = COMMANDS.find((c) => c.name === "model");
		const ctx = {
			runner,
			renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => false,
			replay: () => 0,
			submitPrompt: () => {},
			hintState: { defaultModelHintShown: false },
		};
		process.env.INK_MODEL = "zai/glm-4.6"; // env pins the startup default
		await model?.run("zai/glm-4.7", ctx);
		expect(output()).not.toContain("keeps this model for new sessions");
		delete process.env.INK_MODEL;
		// a project settings file exists but the directory is NOT trusted —
		// its defaultModel is invisible, so the hint must stay silent too.
		const gatedCwd = path.join(root, "gated");
		await mkdir(path.join(gatedCwd, ".ink"), { recursive: true });
		await writeFile(path.join(gatedCwd, ".ink", "settings.json"), JSON.stringify({ defaultModel: "x" }));
		const gated = await createRunner({
			cwd: gatedCwd,
			argv: [],
			model: "zai/glm-4.7",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
			projectSettingsAllowed: false,
		});
		const gatedOut = makeRenderer();
		const gatedCtx = {
			...ctx,
			runner: gated,
			renderer: gatedOut.renderer,
			hintState: { defaultModelHintShown: false },
		};
		await model?.run("zai/glm-4.6", gatedCtx);
		expect(gatedOut.output()).not.toContain("keeps this model for new sessions");
		// impl-review round-2 N1: a gated-off file WITHOUT defaultModel must NOT
		// silence the hint (the F2 fix's actual direction).
		const bareCwd = path.join(root, "gated-bare");
		await mkdir(path.join(bareCwd, ".ink"), { recursive: true });
		await writeFile(path.join(bareCwd, ".ink", "settings.json"), JSON.stringify({ autoCompact: false }));
		const bare = await createRunner({
			cwd: bareCwd,
			argv: [],
			model: "zai/glm-4.7",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: true,
			renderer,
			projectSettingsAllowed: false,
		});
		const bareOut = makeRenderer();
		await model?.run("zai/glm-4.6", {
			...ctx,
			runner: bare,
			renderer: bareOut.renderer,
			hintState: { defaultModelHintShown: false },
		});
		expect(bareOut.output()).toContain("keeps this model for new sessions");
	});

	it("D3: an explicit -m model survives an interactive /resume fallback (impl-review F3)", async () => {
		process.env.DEEPSEEK_API_KEY = "k";
		const root = await mkTempDirAsync("ink-smr-");
		const cwd = path.join(root, "proj");
		await mkdir(cwd, { recursive: true });
		const baseDir = path.join(root, "sessions");
		const { createSession } = await import("../src/core/session/manager.js");
		const session = createSession(cwd, baseDir);
		session.appendMessage({ role: "user", content: "old" }); // model-less
		const { renderer, output } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "claude-sonnet-4-5",
			modelExplicit: true,
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			renderer,
		});
		runner.resumeSession(session.header.id);
		expect(runner.modelReference()).toBe("claude-sonnet-4-5");
		expect(output()).not.toContain("using deepseek");
	});

	it("usage identity: a resolved-style reference stamps provider/modelId (impl-review F4b)", async () => {
		const root = await mkTempDirAsync("ink-smr-");
		const cwd = path.join(root, "proj");
		await mkdir(cwd, { recursive: true });
		const baseDir = path.join(root, "sessions");
		const { renderer } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "deepseek/deepseek-v4-pro",
			maxTokens: 1024,
			maxTurns: 3,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: baseDir,
			renderer,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], []),
		});
		await runner.runTurn({ userMessage: "hi" });
		const entry = runner.session
			?.getEntries()
			.find((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
		expect(entry?.type).toBe("message");
		if (entry?.type === "message" && entry.message.role === "assistant") {
			expect(entry.message.modelReference).toBe("deepseek/deepseek-v4-pro");
		}
	});

	// ---- D3: restore path ----

	it("D3: resuming a stale session resolves to the unique family; row untouched", async () => {
		process.env.DEEPSEEK_API_KEY = "k";
		const root = await mkTempDirAsync("ink-smr-");
		const cwd = path.join(root, "proj");
		await mkdir(cwd, { recursive: true });
		const baseDir = path.join(root, "sessions");
		const { createSession } = await import("../src/core/session/manager.js");
		const session = createSession(cwd, baseDir);
		session.appendMessage({ role: "user", content: "old" });
		session.setModel({ provider: "zai", modelId: "glm-4.7" }); // stale: zai unconfigured now
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
			resume: session.header.id,
			renderer,
		});
		expect(runner.modelReference()).toBe("deepseek/deepseek-v4-pro");
		expect(output()).toContain(
			"▪ restored model zai/glm-4.7 has no credential — using deepseek/deepseek-v4-pro",
		);
		expect(output()).toContain("resumed");
		// impl-review F5: the note precedes the resumed line (order pinned)
		expect(output().indexOf("has no credential — using")).toBeLessThan(output().indexOf("▪ resumed"));
		// impl-review F4a: subagents inherit the RESOLVED model
		const { resolveChildModel } = await import("../src/core/child-model.js");
		expect(resolveChildModel({ parentReference: runner.modelReference() })).toEqual({
			ok: true,
			binding: {
				providerName: "deepseek",
				wireModelId: "deepseek-v4-pro",
				reference: "deepseek/deepseek-v4-pro",
			},
		});
		// the recorded row is NOT rewritten (divergence contract)
		expect(session.getModel()).toEqual({ provider: "zai", modelId: "glm-4.7" });
	});

	it("D3 negative: a usable resumed model and explicit -m are untouched", async () => {
		process.env.ZAI_API_KEY = "k";
		const root = await mkTempDirAsync("ink-smr-");
		const cwd = path.join(root, "proj");
		await mkdir(cwd, { recursive: true });
		const baseDir = path.join(root, "sessions");
		const { createSession } = await import("../src/core/session/manager.js");
		const session = createSession(cwd, baseDir);
		session.appendMessage({ role: "user", content: "old" });
		session.setModel({ provider: "zai", modelId: "glm-4.7" });
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
			resume: session.header.id,
			renderer,
		});
		expect(runner.modelReference()).toBe("zai/glm-4.7");
		expect(output()).not.toContain("has no credential");
		expect(output()).not.toContain("using deepseek");
	});

	// ---- user-side review round (2026-09-28) ----

	it("user-review 2: -c with NO resumable session resolves (print)", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const fixture = cli();
		const home = fixture.home;
		const cwd = fixture.cwd;
		const BIN = fixture.bin;
		const result: unknown = await run(process.execPath, [BIN, "-c", "-p", "hello"], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				ZAI_API_KEY: "dummy",
				ZAI_BASE_URL: provider.url,
			}),
			timeout: 10_000,
		}).catch((err: unknown) => err);
		const err = result as { stdout: string; stderr: string; code?: number };
		expect(err.code).toBe(1);
		expect(err.stderr).toContain("401");
		expect(provider.requests.length).toBe(1);
		// the pre-flight resolved instead of skipping (-c had no session to restore)
		expect(err.stderr).not.toContain("No API key found");
		expect(err.stderr).not.toContain("ANTHROPIC_API_KEY");
		const files: string[] = [];
		const walk = (dir: string): void => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir)) {
				const full = path.join(dir, entry);
				if (existsSync(full) && statSync(full).isDirectory()) walk(full);
				else files.push(full);
			}
		};
		walk(path.join(home, ".ink", "sessions"));
		expect(files.length).toBeGreaterThan(0); // the run proceeded
	});

	it("user-review 2: -c with no session resolves in the interactive (pipe) path too", async () => {
		const { spawn } = await import("node:child_process");
		const fixture = cli();
		const home = fixture.home;
		const cwd = fixture.cwd;
		const BIN = fixture.bin;
		const child = spawn(process.execPath, [BIN, "-c"], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				ZAI_API_KEY: "dummy",
				ZAI_BASE_URL: provider.url,
			}),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const { stdout } = await collectCliOutput(child, "hello\n");
		expect(stdout).toContain("no startup model configured — using zai/glm-5.3");
		expect(stdout).not.toContain("no model available — run /login to connect one");
	});

	it("D2 e2e: a stored key (INK_AUTH_PATH) resolves like the env variant", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const fixture = cli();
		const home = fixture.home;
		const cwd = fixture.cwd;
		await writeFile(
			path.join(home, "auth.json"),
			JSON.stringify({ version: 1, apiKeys: { zai: "stored-key" } }),
		);
		const BIN = fixture.bin;
		const result: unknown = await run(process.execPath, [BIN, "-p", "hello"], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				ZAI_BASE_URL: provider.url,
			}),
			timeout: 10_000,
		}).catch((err: unknown) => err);
		const err = result as { stdout: string; stderr: string; code?: number };
		expect(err.code).toBe(1);
		expect(err.stderr).toContain("401");
		expect(provider.requests.length).toBe(1);
		expect(err.stderr).not.toContain("has no credential");
		expect(err.stderr).not.toContain("no model configured");
	});

	it("user-review 3: -c -p prints the D3 note and the resumed line (stdout pin)", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		const fixture = cli();
		const home = fixture.home;
		// realpath: the child's process.cwd() is canonical (/private/var vs /var
		// on macOS) and the session-dir slug is derived from it.
		const cwd = await realpath(fixture.cwd);
		const { createSession } = await import("../src/core/session/manager.js");
		const session = createSession(cwd, path.join(home, ".ink", "sessions"));
		session.appendMessage({ role: "user", content: "old" });
		session.setModel({ provider: "zai", modelId: "glm-4.7" });
		const BIN = fixture.bin;
		const result: unknown = await run(process.execPath, [BIN, "-c", "-p", "hello"], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				DEEPSEEK_API_KEY: "dummy",
				DEEPSEEK_BASE_URL: provider.url,
			}),
			timeout: 10_000,
		}).catch((err: unknown) => err);
		const err = result as { stdout: string; stderr: string; code?: number };
		expect(err.code).toBe(1);
		expect(err.stderr).toContain("401");
		expect(provider.requests.length).toBe(1);
		expect(err.stdout).toContain(
			"▪ restored model zai/glm-4.7 has no credential — using deepseek/deepseek-v4-pro",
		);
		expect(err.stdout).toContain("▪ resumed");
	});

	it("D6 surfaces: multi-family state shows /model on legacy /model text and /status", async () => {
		process.env.ZAI_API_KEY = "k";
		process.env.DEEPSEEK_API_KEY = "k";
		const root = await mkTempDirAsync("ink-smr-");
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
		const { COMMANDS } = await import("../src/repl/commands.js");
		const ctx = {
			runner,
			renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => false,
			replay: () => 0,
			submitPrompt: () => {},
		};
		await COMMANDS.find((c) => c.name === "model")?.run("", ctx);
		expect(output()).toContain("model: no model — /model");
		const statusOut = makeRenderer();
		await COMMANDS.find((c) => c.name === "status")?.run("", { ...ctx, renderer: statusOut.renderer });
		expect(statusOut.output()).toContain("▪ model no model — /model");
	});

	it("D6 surfaces: the banner identity line carries the /model pointer in the multi state", async () => {
		const { noModelText, NO_MODEL_SELECTED_SEGMENT } = await import("../src/runner.js");
		const { welcomeLines } = await import("../src/repl/repl.js");
		expect(noModelText(true)).toBe(NO_MODEL_SELECTED_SEGMENT);
		const lines = welcomeLines("deadbeef", noModelText(true), false);
		expect(lines[lines.length - 1]).toBe(`Ink ${VERSION} · session deadbeef · ${NO_MODEL_SELECTED_SEGMENT}`);
	});

	it("D6 surfaces: the resumed line shows the /model pointer in the multi state", async () => {
		const { spawn } = await import("node:child_process");
		const fixture = cli();
		const home = fixture.home;
		const cwd = await realpath(fixture.cwd);
		const { createSession } = await import("../src/core/session/manager.js");
		const session = createSession(cwd, path.join(home, ".ink", "sessions"));
		session.appendMessage({ role: "user", content: "old" }); // model-less
		const BIN = fixture.bin;
		const child = spawn(process.execPath, [BIN, "-c"], {
			cwd,
			env: fixture.env({
				INK_AUTH_PATH: path.join(home, "auth.json"),
				ZAI_API_KEY: "k",
				DEEPSEEK_API_KEY: "k",
			}),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const { stdout } = await collectCliOutput(child, "hello\n");
		expect(stdout).toContain("no model — /model");
		expect(stdout).not.toContain("no model — /login");
	});
});
