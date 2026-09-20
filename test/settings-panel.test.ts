/**
 * M15 #settings-panel — two-scope settings with deep merge, trust gating,
 * and the /settings command. Mirrors docs/m15-settings-design.md §4.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	effectiveSettings,
	loadProjectSettings,
	loadSettings,
	projectSettingsPath,
	saveSettings,
} from "../src/core/settings.js";
import { trustRequiringResources } from "../src/core/trust.js";
import type { LLMRequest } from "../src/provider/types.js";
import type { CommandContext } from "../src/repl/commands.js";
import { COMMANDS } from "../src/repl/commands.js";
import type { Runner } from "../src/runner.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

const settingsCommand = COMMANDS.find((c) => c.name === "settings");
if (settingsCommand === undefined) throw new Error("settings command missing");

interface Boot {
	baseDir: string;
	cwd: string;
	globalPath: string;
	runner: Runner;
	ctx: CommandContext;
	output: () => string;
	requests: LLMRequest[];
}

/** Boot a runner + command ctx the way repl-commands tests do. */
async function boot(options?: {
	projectAllowed?: boolean;
	project?: unknown;
	global?: unknown;
}): Promise<Boot> {
	const baseDir = mkdtempSync(join(tmpdir(), "imp-settings-test-"));
	const cwd = join(baseDir, "proj");
	mkdirSync(cwd, { recursive: true });
	const globalPath = join(baseDir, "settings.json");
	if (options?.global !== undefined) {
		writeFileSync(globalPath, JSON.stringify(options.global), "utf-8");
	}
	if (options?.project !== undefined) {
		mkdirSync(join(cwd, ".imp"), { recursive: true });
		writeFileSync(join(cwd, ".imp", "settings.json"), JSON.stringify(options.project), "utf-8");
	}
	const requests: LLMRequest[] = [];
	const { renderer, output } = makeRenderer();
	const runner = await createRunner({
		cwd,
		argv: [],
		settingsPath: globalPath,
		projectSettingsAllowed: options?.projectAllowed === true,
		model: "claude-sonnet-4-5",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: true,
		renderer,
		provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests),
	});
	const banner = output();
	const ctx: CommandContext = {
		runner,
		renderer,
		isActive: () => false,
		requestExit: () => undefined,
		abortActive: () => false,
		replay: () => 0,
		submitPrompt: () => undefined,
	};
	return { baseDir, cwd, globalPath, runner, ctx, output: () => output().slice(banner.length), requests };
}

async function runSettings(args: string, ctx: CommandContext): Promise<string> {
	expect(settingsCommand).toBeDefined();
	const result = await settingsCommand!.run(args, ctx);
	expect(result).toBe("handled");
	return "";
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("M15 two-scope merge", () => {
	it("project wins; nested objects merge by key (siblings survive)", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "imp-merge-"));
		const globalPath = join(globalDir, "settings.json");
		const projDir = mkdtempSync(join(tmpdir(), "imp-merge-proj-"));
		writeFileSync(
			globalPath,
			JSON.stringify({ defaultModel: "zai/glm-5.3", images: { autoResize: false } }),
			"utf-8",
		);
		writeFileSync(
			join(projDir, "settings.json"),
			JSON.stringify({ defaultThinkingLevel: "high", images: {} }),
			"utf-8",
		);
		const merged = effectiveSettings({
			cwd: projDir,
			projectAllowed: true,
			globalPath,
			projectPath: join(projDir, "settings.json"),
		});
		expect(merged.defaultModel).toBe("zai/glm-5.3"); // global survives
		expect(merged.defaultThinkingLevel).toBe("high"); // project adds
		expect(merged.images?.autoResize).toBe(false); // sibling key survives images:{} patch
	});

	it("arrays replace, never concatenate (pi semantics)", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "imp-arr-"));
		const projDir = mkdtempSync(join(tmpdir(), "imp-arr-proj-"));
		writeFileSync(join(globalDir, "settings.json"), JSON.stringify({ skills: ["a.md"] }), "utf-8");
		writeFileSync(join(projDir, "settings.json"), JSON.stringify({ skills: ["b.md"] }), "utf-8");
		const merged = effectiveSettings({
			cwd: projDir,
			projectAllowed: true,
			globalPath: join(globalDir, "settings.json"),
			projectPath: join(projDir, "settings.json"),
		});
		expect(merged.skills).toEqual(["b.md"]);
	});

	it("untrusted project settings are invisible (trust gate)", () => {
		const projDir = mkdtempSync(join(tmpdir(), "imp-untrusted-"));
		mkdirSync(join(projDir, ".imp"), { recursive: true });
		writeFileSync(
			join(projDir, ".imp", "settings.json"),
			JSON.stringify({ defaultModel: "attacker/model" }),
			"utf-8",
		);
		const merged = effectiveSettings({ cwd: projDir, projectAllowed: false });
		expect(merged.defaultModel).toBeUndefined();
		expect(loadProjectSettings(projDir, false)).toEqual({});
		// the file still exists — the gate hides, it does not require deletion
		expect(loadProjectSettings(projDir, true).defaultModel).toBe("attacker/model");
	});

	it(".imp/settings.json presence triggers the trust gate", () => {
		const projDir = mkdtempSync(join(tmpdir(), "imp-gate-"));
		expect(trustRequiringResources(projDir, homedir())).not.toContain(".imp/settings.json");
		mkdirSync(join(projDir, ".imp"), { recursive: true });
		writeFileSync(join(projDir, ".imp", "settings.json"), "{}", "utf-8");
		expect(trustRequiringResources(projDir, homedir())).toContain(".imp/settings.json");
	});

	it("unknown keys survive a read-modify-write (forward compat)", () => {
		const dir = mkdtempSync(join(tmpdir(), "imp-unknown-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ futureKey: { nested: 1 }, autoCompact: true }), "utf-8");
		saveSettings({ autoCompact: false }, file);
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		expect(raw.futureKey).toEqual({ nested: 1 });
		expect(raw.autoCompact).toBe(false);
	});

	it("nested patch merges into the raw tree without clobbering siblings", () => {
		const dir = mkdtempSync(join(tmpdir(), "imp-nested-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ images: { autoResize: true, other: 2 } }), "utf-8");
		saveSettings({ images: { autoResize: false } }, file);
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		expect(raw.images).toEqual({ autoResize: false, other: 2 });
	});
});

describe("M15 consumers", () => {
	it("autoCompact: project settings stop auto-compaction; env=0 wins over everything", async () => {
		const withProject = await boot({ projectAllowed: true, project: { autoCompact: false } });
		expect(withProject.runner.autoCompactEnabled).toBe(false);

		const globalOnly = await boot({ global: { autoCompact: false } });
		expect(globalOnly.runner.autoCompactEnabled).toBe(false);

		vi.stubEnv("IMP_AUTOCOMPACT", "0");
		const envWins = await boot({
			projectAllowed: true,
			project: { autoCompact: true },
			global: { autoCompact: true },
		});
		expect(envWins.runner.autoCompactEnabled).toBe(false);
	});

	it("images.autoResize and defaultThinkingLevel read the merged view", async () => {
		const booted = await boot({
			projectAllowed: true,
			project: { defaultThinkingLevel: "high", images: { autoResize: false } },
		});
		expect(booted.runner.effectiveSettings().defaultThinkingLevel).toBe("high");
		expect(booted.runner.effectiveSettings().images?.autoResize).toBe(false);
		// projectSettingsAllowed mirrors the startup trust resolution
		expect(booted.runner.projectSettingsAllowed).toBe(true);
	});
});

describe("M15 /settings command", () => {
	it("no-arg prints the table + paths when no picker exists (legacy)", async () => {
		const booted = await boot({ projectAllowed: false });
		await runSettings("", booted.ctx);
		const text = booted.output();
		expect(text).toContain("defaultModel = ");
		expect(text).toContain("autoCompact = true");
		expect(text).toContain(booted.globalPath);
		expect(text).toContain("(untrusted — inactive)");
	});

	it("/settings <key> shows the value + teaches the write form", async () => {
		const booted = await boot();
		await runSettings("autoCompact", booted.ctx);
		const text = booted.output();
		expect(text).toContain("autoCompact = true");
		expect(text).toContain("/settings autoCompact <value>");
	});

	it("/settings <key> <value> writes global and echoes old → new", async () => {
		const booted = await boot();
		await runSettings("autoCompact false", booted.ctx);
		expect(booted.output()).toContain("settings: autoCompact true → false (global, next session)");
		expect(loadSettings(booted.globalPath).autoCompact).toBe(false);
	});

	it("nested keys write the images object", async () => {
		const booted = await boot();
		await runSettings("images.autoResize false", booted.ctx);
		expect(loadSettings(booted.globalPath).images?.autoResize).toBe(false);
	});

	it("unknown key teaches the key list; bad value teaches the form", async () => {
		const booted = await boot();
		await runSettings("bogus 1", booted.ctx);
		expect(booted.output()).toContain("unknown setting");
		expect(booted.output()).toContain("defaultModel");

		const booted2 = await boot();
		await runSettings("autoCompact yes", booted2.ctx);
		expect(booted2.output()).toContain("must be true or false");
	});

	it("project scope: refused when untrusted, written when trusted", async () => {
		const untrusted = await boot({ projectAllowed: false, project: {} });
		await runSettings("autoCompact false project", untrusted.ctx);
		expect(untrusted.output()).toContain("trusted");

		const trusted = await boot({ projectAllowed: true, project: {} });
		await runSettings("autoCompact false project", trusted.ctx);
		expect(trusted.output()).toContain("(project, next session)");
		const raw = JSON.parse(readFileSync(projectSettingsPath(trusted.cwd), "utf-8"));
		expect(raw.autoCompact).toBe(false);
		expect(loadSettings(trusted.globalPath).autoCompact).toBeUndefined(); // global untouched
	});

	it("thinking level validates against the ladder", async () => {
		const booted = await boot();
		await runSettings("defaultThinkingLevel mega", booted.ctx);
		expect(booted.output()).toContain("off, minimal, low");
		await runSettings("defaultThinkingLevel high", booted.ctx);
		expect(loadSettings(booted.globalPath).defaultThinkingLevel).toBe("high");
	});

	it("env shadows show in the table (env wins)", async () => {
		vi.stubEnv("IMP_MODEL", "zai/glm-5.3");
		const booted = await boot();
		await runSettings("", booted.ctx);
		expect(booted.output()).toContain("defaultModel = zai/glm-5.3");
		expect(booted.output()).toContain("env IMP_MODEL wins");
	});

	it("TUI picker: cycle a boolean, pick the scope (injected select)", async () => {
		const booted = await boot({ projectAllowed: true, project: {} });
		const picks: number[] = [3, 1]; // row 3 = autoCompact; scope 1 = project
		let ask = 0;
		booted.ctx.select = async () => {
			const pick = picks[ask];
			ask++;
			return pick === undefined ? null : (pick as number);
		};
		await runSettings("", booted.ctx);
		expect(booted.output()).toContain("settings: autoCompact true → false (project, next session)");
		expect(JSON.parse(readFileSync(projectSettingsPath(booted.cwd), "utf-8")).autoCompact).toBe(false);
	});

	it("TUI picker: defaultModel asks for text (secret seam, readline echoes)", async () => {
		const booted = await boot();
		const picks: number[] = [0]; // row 0 = defaultModel
		let ask = 0;
		booted.ctx.select = async () => (ask++ < picks.length ? (picks[ask - 1] as number) : null);
		booted.ctx.secret = async () => "zai/glm-5.3";
		await runSettings("", booted.ctx);
		expect(booted.output()).toContain("settings: defaultModel");
		expect(loadSettings(booted.globalPath).defaultModel).toBe("zai/glm-5.3");
	});
});

describe("M15 review round pins", () => {
	it("P1-1: /settings shows its own write immediately; a second write echoes the real before", async () => {
		const booted = await boot();
		await runSettings("autoCompact", booted.ctx);
		expect(booted.output()).toContain("autoCompact = true");
		await runSettings("autoCompact false", booted.ctx);
		await runSettings("autoCompact", booted.ctx);
		expect(booted.output()).toContain("autoCompact = false"); // live, not the snapshot
		await runSettings("autoCompact true", booted.ctx);
		expect(booted.output()).toContain("autoCompact false → true"); // real before, not the stale true
	});

	it("P2-2: a failed write reports instead of echoing success", async () => {
		const booted = await boot();
		// make the global path unwritable by pointing it at a DIRECTORY
		const dirAsFile = join(booted.baseDir, "blocker");
		mkdirSync(dirAsFile);
		// the command writes through the runner's globalSettingsPath — patch it
		(booted.runner as unknown as { globalSettingsPath: () => string }).globalSettingsPath = () => dirAsFile;
		await runSettings("autoCompact false", booted.ctx);
		expect(booted.output()).toContain("changes NOT saved");
	});

	it("P2-3: the table shows the per-key source", async () => {
		const booted = await boot({ projectAllowed: true, project: { autoCompact: false } });
		await runSettings("", booted.ctx);
		const text = booted.output();
		expect(text).toContain("autoCompact = false [project]");
		expect(text).toContain("images.autoResize = true [default]");
	});

	it("P2-4: TUI defaultModel input is validated (trailing space trimmed)", async () => {
		const booted = await boot();
		const picks: number[] = [0];
		let ask = 0;
		booted.ctx.select = async () => (ask++ < picks.length ? (picks[ask - 1] as number) : null);
		booted.ctx.secret = async () => "  zai/glm-5.3  ";
		await runSettings("", booted.ctx);
		expect(loadSettings(booted.globalPath).defaultModel).toBe("zai/glm-5.3"); // trimmed
	});
});

describe("M15 startup default model", () => {
	it("global settings defaultModel is honored (subprocess-free check of the read chain)", async () => {
		// The cli chain (IMP_MODEL > global > trusted-project > builtin) is
		// exercised end-to-end in the dist smoke; here: the pieces.
		const dir = mkdtempSync(join(tmpdir(), "imp-dm-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ defaultModel: "openai-codex/gpt-5.5" }), "utf-8");
		expect(loadSettings(file).defaultModel).toBe("openai-codex/gpt-5.5");
	});
});
