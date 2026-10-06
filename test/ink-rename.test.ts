import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentDefinitions } from "../src/core/agents/registry.js";
import { parseChildLaunch } from "../src/core/child-launch.js";
import { loadMdCommands } from "../src/core/commands-md.js";
import { loadContextFiles } from "../src/core/context-files.js";
import { healthEnabled } from "../src/core/health.js";
import { createSession, listSessions, resolveSession, sessionsDirFor } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import {
	effectiveSettings,
	loadProjectSettings,
	loadSettings,
	settingsFilePath,
} from "../src/core/settings.js";
import { loadSkills } from "../src/core/skills.js";
import { loadSystemPromptFiles } from "../src/core/system-prompt-files.js";
import { createBashTool } from "../src/core/tools/bash.js";
import { createTaskTool } from "../src/core/tools/task.js";
import type { ToolExecuteResult } from "../src/core/tools/types.js";
import {
	defaultTrustStorePath,
	nearestTrustEntry,
	readTrustFile,
	setTrust,
	trustRequiringResources,
} from "../src/core/trust.js";
import { createChildWorktree, listChildWorktrees, resolveRepoState } from "../src/core/worktree.js";
import { loadExtensions } from "../src/extensions/loader.js";
import { VERSION } from "../src/format.js";
import { authFilePath, loadApiKey } from "../src/provider/auth-store.js";
import { catalogPath } from "../src/provider/catalog.js";
import { contextWindowFor } from "../src/provider/models.js";
import type { LLMRequest } from "../src/provider/types.js";
import { historyFilePath } from "../src/repl/history.js";
import { resolveShell } from "../src/tui.js";
import { assistant, scriptedProvider, user } from "./helpers/fakes.js";

// Keep the real filesystem, but observe trust's gate-before-read contract.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let root: string;
let home: string;
let cwd: string;

function write(file: string, content: string | Buffer): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function resource(base: string, stateRoot: ".ink" | ".imp", relative: string): string {
	return path.join(base, stateRoot, relative);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(tmpdir(), "ink-rename-"));
	home = path.join(root, "home");
	cwd = path.join(root, "project");
	fs.mkdirSync(home);
	fs.mkdirSync(cwd);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	for (const suffix of ["AUTH_PATH", "SETTINGS_PATH", "CATALOG_PATH", "CONTEXT_WINDOW", "REPL", "HEALTH"])
		vi.stubEnv(`INK_${suffix}`, undefined);
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
	vi.stubEnv("INK_CHILD_SESSIONS", "1");
	vi.mocked(fs.readFileSync).mockClear();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden in Ink rename compatibility tests");
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	fs.rmSync(root, { recursive: true, force: true });
});

const skillText = "---\nname: fixture\ndescription: Isolated test skill\n---\nFixture body\n";
const agentText = "---\nname: fixture\ndescription: Isolated test agent\n---\nFixture body\n";
const extensionText = 'export default (api) => { api.registerContext("fixture", "fixture"); };';

function seedResources(base: string, stateRoot: ".ink" | ".imp"): void {
	const name = stateRoot === ".imp" ? "obsolete" : "fixture";
	write(resource(base, stateRoot, "settings.json"), JSON.stringify({ defaultModel: `openai/${name}` }));
	write(resource(base, stateRoot, "SYSTEM.md"), `${name} custom prompt mentioning imp`);
	write(resource(base, stateRoot, "APPEND_SYSTEM.md"), `${name} append`);
	write(resource(base, stateRoot, "AGENTS.md"), `${name} global context`);
	write(resource(base, stateRoot, `agents/${name}.md`), agentText.replace("name: fixture", `name: ${name}`));
	write(resource(base, stateRoot, `commands/${name}.md`), `${name} command body`);
	write(
		resource(base, stateRoot, `skills/${name}/SKILL.md`),
		skillText.replace("name: fixture", `name: ${name}`),
	);
	write(resource(base, stateRoot, `extensions/${name}.mjs`), extensionText);
}

async function discovered(projectAllowed: boolean) {
	return {
		agents: loadAgentDefinitions(cwd, home, projectAllowed).agents,
		commands: (await loadMdCommands({ cwd, home, projectAllowed, reserved: new Set() })).commands,
		skills: loadSkills({
			cwd,
			home,
			projectTrusted: projectAllowed,
			noSkills: false,
			explicitPaths: [],
		}).skills,
		extensions: await loadExtensions({ cwd, home, projectDirAllowed: projectAllowed, cliPaths: [] }),
	};
}

describe("Ink single-name configuration", () => {
	it("ignores old-only .imp resources rather than implicitly discovering them", async () => {
		seedResources(home, ".imp");
		seedResources(cwd, ".imp");
		write(resource(home, ".imp", "auth.json"), '{"version":1,"apiKeys":{"openai":"old-only"}}');
		write(resource(home, ".imp", "trust.json"), JSON.stringify({ [fs.realpathSync(cwd)]: true }));
		const legacy = createSession(cwd, resource(home, ".imp", "sessions"));
		legacy.appendMessage(user("Historical imp session"));
		const original = fs.readFileSync(legacy.filePath);

		expect(settingsFilePath()).toBe(resource(home, ".ink", "settings.json"));
		expect(authFilePath()).toBe(resource(home, ".ink", "auth.json"));
		expect(catalogPath()).toBe(resource(home, ".ink", "models-catalog.json"));
		expect(historyFilePath(home)).toBe(resource(home, ".ink", "history.jsonl"));
		expect(sessionsDirFor(cwd)).toBe(sessionsDirFor(cwd, resource(home, ".ink", "sessions")));
		expect(loadSettings()).toEqual({});
		expect(loadProjectSettings(cwd, true)).toEqual({});
		expect(loadApiKey("openai", resource(home, ".imp", "auth.json"))).toBe("old-only");
		expect(loadApiKey("openai")).toBeNull();
		expect(readTrustFile(defaultTrustStorePath(home))).toEqual({});
		expect(trustRequiringResources(cwd, home)).toEqual([]);
		expect(loadContextFiles(cwd, home)).toBeNull();
		expect(loadSystemPromptFiles(cwd, true, home).override).toBeUndefined();
		expect(loadSystemPromptFiles(cwd, true, home).append).toBeUndefined();
		expect(listSessions(cwd)).toEqual([]);
		expect(resolveSession(cwd, { continueRecent: true })).toBeNull();
		const loaded = await discovered(true);
		expect(loaded.agents).toEqual([]);
		expect(loaded.commands).toEqual([]);
		expect(loaded.skills).toEqual([]);
		expect(loaded.extensions.summaries).toEqual([]);
		expect(fs.readFileSync(legacy.filePath)).toEqual(original);
	});

	it("discovers only .ink when old and new roots coexist, without merging old resources", async () => {
		for (const base of [home, cwd]) {
			seedResources(base, ".imp");
			seedResources(base, ".ink");
		}
		expect(effectiveSettings({ cwd, projectAllowed: true }).defaultModel).toBe("openai/fixture");
		expect(loadContextFiles(cwd, home)?.sections.map((section) => section.content)).toEqual([
			"fixture global context",
		]);
		expect(loadSystemPromptFiles(cwd, true, home).override?.text).toBe(
			"fixture custom prompt mentioning imp",
		);
		expect(loadSystemPromptFiles(cwd, true, home).append?.text).toBe("fixture append");
		const loaded = await discovered(true);
		expect(loaded.agents.map((agent) => agent.name)).toEqual(["fixture"]);
		expect(loaded.commands.map((entry) => entry.command.name)).toEqual(["fixture"]);
		expect(loaded.skills.map((skill) => skill.name)).toEqual(["fixture"]);
		expect(loaded.extensions.summaries.map((extension) => extension.name)).toEqual(["fixture", "fixture"]);
		expect(loaded.extensions.failures).toEqual([]);
	});

	it("ignores harness-specific IMP_* overrides, then honors conflicting INK_* values", () => {
		for (const suffix of ["AUTH_PATH", "SETTINGS_PATH", "CATALOG_PATH"])
			vi.stubEnv(`IMP_${suffix}`, path.join(root, `old-${suffix}.json`));
		write(path.join(root, "old-AUTH_PATH.json"), '{"version":1,"apiKeys":{"openai":"old-only"}}');
		write(path.join(root, "old-SETTINGS_PATH.json"), '{"defaultModel":"openai/old-only"}');
		vi.stubEnv("IMP_CONTEXT_WINDOW", "123");
		vi.stubEnv("IMP_REPL", "legacy");
		vi.stubEnv("IMP_HEALTH", "0");
		expect(authFilePath()).toBe(resource(home, ".ink", "auth.json"));
		expect(settingsFilePath()).toBe(resource(home, ".ink", "settings.json"));
		expect(catalogPath()).toBe(resource(home, ".ink", "models-catalog.json"));
		expect(loadApiKey("openai")).toBeNull();
		expect(loadSettings()).toEqual({});
		expect(contextWindowFor("anthropic/claude-sonnet-4-6")).not.toBe(123);
		expect(resolveShell()).toBe("tui");
		expect(healthEnabled()).toBe(true);
		for (const suffix of ["AUTH_PATH", "SETTINGS_PATH", "CATALOG_PATH"])
			vi.stubEnv(`INK_${suffix}`, path.join(root, `new-${suffix}.json`));
		write(path.join(root, "new-AUTH_PATH.json"), '{"version":1,"apiKeys":{"openai":"new-only"}}');
		write(path.join(root, "new-SETTINGS_PATH.json"), '{"defaultModel":"openai/new-only"}');
		vi.stubEnv("INK_CONTEXT_WINDOW", "456");
		vi.stubEnv("INK_REPL", "legacy");
		vi.stubEnv("INK_HEALTH", "0");
		expect(authFilePath()).toBe(path.join(root, "new-AUTH_PATH.json"));
		expect(settingsFilePath()).toBe(path.join(root, "new-SETTINGS_PATH.json"));
		expect(catalogPath()).toBe(path.join(root, "new-CATALOG_PATH.json"));
		expect(loadApiKey("openai")).toBe("new-only");
		expect(loadSettings().defaultModel).toBe("openai/new-only");
		expect(contextWindowFor("anthropic/claude-sonnet-4-6")).toBe(456);
		expect(resolveShell()).toBe("legacy");
		expect(healthEnabled()).toBe(false);
	});

	it.each([undefined, "caller-owned arbitrary value"])(
		"bash injects INK=1 without synthesizing or replacing inherited IMP=%j",
		async (inherited) => {
			vi.stubEnv("IMP", inherited);
			vi.stubEnv("INK", "caller-value-to-replace");
			vi.stubEnv("IMP_ARBITRARY", "unchanged");
			const result = await createBashTool({ cwd }).execute(
				{
					command:
						// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not JavaScript interpolation
						'printf "INK=%s|IMP_PRESENT=%s|IMP=%s|OTHER=%s" "$INK" "${IMP+x}" "${IMP-}" "$IMP_ARBITRARY"',
				},
				new AbortController().signal,
			);
			expect(result.isError ?? false).toBe(false);
			expect(result.output).toContain(
				`INK=1|IMP_PRESENT=${inherited === undefined ? "" : "x"}|IMP=${inherited ?? ""}|OTHER=unchanged`,
			);
			expect(process.env.INK).toBe("caller-value-to-replace");
			expect(process.env.IMP).toBe(inherited);
		},
	);
});

const resourceCases = [
	["settings.json", '{"defaultModel":"openai/project-only"}'],
	["commands/fixture.md", "Project-only prompt"],
	["skills/fixture/SKILL.md", skillText],
	["SYSTEM.md", "Unchanged custom prompt mentioning imp"],
	["APPEND_SYSTEM.md", "Project-only append"],
	["agents/fixture.md", agentText],
	["extensions/fixture.mjs", extensionText],
] as const;

describe("resource-only .ink project trust", () => {
	it.each(resourceCases)("%s requires trust and is unread until admitted", async (relative, content) => {
		const file = resource(cwd, ".ink", relative);
		write(file, content);
		const expected = relative.includes("/") ? `.ink/${relative.split("/")[0]}` : `.ink/${relative}`;
		expect(trustRequiringResources(cwd, home)).toEqual([expected]);
		const storePath = defaultTrustStorePath(home);

		for (const decision of [undefined, false, true]) {
			if (decision !== undefined) setTrust(storePath, cwd, decision);
			const allowed = nearestTrustEntry(readTrustFile(storePath), cwd)?.trusted === true;
			expect(allowed).toBe(decision === true);
			vi.mocked(fs.readFileSync).mockClear();
			const settings = effectiveSettings({ cwd, projectAllowed: allowed });
			const prompts = loadSystemPromptFiles(cwd, allowed, home);
			const loaded = await discovered(allowed);
			const reads = vi.mocked(fs.readFileSync).mock.calls.map(([target]) => String(target));
			if (!allowed) {
				expect(reads).not.toContain(file);
				expect(settings).toEqual({});
				expect(prompts.override).toBeUndefined();
				expect(prompts.append).toBeUndefined();
				expect(loaded.agents).toEqual([]);
				expect(loaded.commands).toEqual([]);
				expect(loaded.skills).toEqual([]);
				expect(loaded.extensions.summaries).toEqual([]);
			} else {
				if (!relative.startsWith("extensions/")) expect(reads).toContain(file);
				if (relative === "settings.json") expect(settings.defaultModel).toBe("openai/project-only");
				if (relative === "SYSTEM.md") expect(prompts.override?.text).toBe(content);
				if (relative === "APPEND_SYSTEM.md") expect(prompts.append?.text).toBe(content);
				if (relative.startsWith("agents/")) expect(loaded.agents).toHaveLength(1);
				if (relative.startsWith("commands/")) expect(loaded.commands).toHaveLength(1);
				if (relative.startsWith("skills/")) expect(loaded.skills).toHaveLength(1);
				if (relative.startsWith("extensions/")) {
					expect(loaded.extensions.failures).toEqual([]);
					expect(loaded.extensions.summaries).toHaveLength(1);
				}
			}
		}
	});
});

// A custom prompt is deliberately byte-identical across the version change.
const CUSTOM_SYSTEM = "Custom SYSTEM.md persona mentioning imp; no branded default prompt";
function childTask(
	parent: SessionStore,
	version: string,
	scripts: ReturnType<typeof assistant>[],
	onLease?: () => void,
) {
	const sink: LLMRequest[] = [];
	const provider = scriptedProvider(scripts, sink, "anthropic");
	const task = createTaskTool({
		cwd,
		sessionBaseDir: path.dirname(path.dirname(parent.filePath)),
		getProvider: () => provider,
		getModel: () => "claude-sonnet-4-6",
		getModelReference: () => "anthropic/claude-sonnet-4-6",
		getSystem: () => CUSTOM_SYSTEM,
		getTools: () => [],
		getSession: () => parent,
		childSessions: true,
		getLaunchEnvironment: () => ({
			impVersion: version,
			systemText: CUSTOM_SYSTEM,
			contextFiles: [],
			promptFiles: [],
			extensionContexts: [],
			extensions: [],
		}),
		...(onLease === undefined ? {} : { onBeforeResumeLease: onLease }),
	});
	return { task, sink };
}
function persistTask(parent: SessionStore, result: ToolExecuteResult): void {
	parent.appendMessage({
		role: "toolResult",
		results: [
			{
				toolCallId: "task-1",
				toolName: "task",
				content: result.output,
				isError: result.isError ?? false,
				taskRecord: result.taskRecord,
			},
		],
	});
}

describe("child v1 version compatibility", () => {
	it("inspects an old 0.1.0 child, but refuses before lease, torn-tail repair, mutation or provider calls", async () => {
		expect(VERSION).toBe("0.2.1");
		const oldBase = resource(home, ".imp", "sessions");
		const parent = createSession(cwd, oldBase);
		const launch = childTask(parent, "0.1.0", [assistant([{ type: "text", text: "Old child answer" }])]);
		const first = await launch.task.execute({ prompt: "Old task" }, new AbortController().signal, {
			toolCallId: "task-1",
		});
		persistTask(parent, first);
		const transcript = first.taskRecord?.transcript;
		if (transcript?.present !== true) throw new Error("Expected historical child transcript");
		// A crash fragment makes attempted repair observable in bytes/mtime.
		fs.appendFileSync(transcript.path, '{"type":"mess');
		const newBase = resource(home, ".ink", "sessions");
		fs.cpSync(oldBase, newBase, { recursive: true, preserveTimestamps: true });
		const copiedParent = SessionStore.open(path.join(newBase, path.relative(oldBase, parent.filePath)));
		const childPath = path.join(newBase, path.relative(oldBase, transcript.path));
		const historical = SessionStore.open(childPath);
		expect(historical.header.launch?.version).toBe(1);
		expect(historical.header.launch?.impVersion).toBe("0.1.0");
		expect(parseChildLaunch(historical.header.launch).ok).toBe(true);
		expect(historical.tornFinalLine).toBe(true);
		const before = fs.readFileSync(childPath);
		const sourceBefore = fs.readFileSync(transcript.path);
		const sourceParentBefore = fs.readFileSync(parent.filePath);
		const copiedParentBefore = fs.readFileSync(copiedParent.filePath);
		const mtime = fs.statSync(childPath).mtimeMs;
		const childrenBefore = fs.readdirSync(path.dirname(childPath)).sort();
		const beforeLease = vi.fn();
		const ink = childTask(copiedParent, VERSION, [], beforeLease);
		const result = await ink.task.execute(
			{ resume: historical.header.id, prompt: "Continue old child" },
			new AbortController().signal,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("version-drift");
		expect(result.output).toContain("0.1.0");
		expect(result.output).toContain("0.2.1");
		expect(result.output).not.toContain("system-drift");
		expect(result.taskRecord?.launched).toBe(false);
		expect(beforeLease).not.toHaveBeenCalled();
		expect(ink.sink).toHaveLength(0);
		expect(fs.existsSync(`${childPath}.lease`)).toBe(false);
		expect(fs.existsSync(path.join(path.dirname(childPath), ".imp-machine-id"))).toBe(false);
		expect(fs.readdirSync(path.dirname(childPath)).sort()).toEqual(childrenBefore);
		expect(fs.readFileSync(childPath)).toEqual(before);
		expect(fs.statSync(childPath).mtimeMs).toBe(mtime);
		expect(fs.readFileSync(transcript.path)).toEqual(sourceBefore);
		expect(fs.readFileSync(parent.filePath)).toEqual(sourceParentBefore);
		expect(fs.readFileSync(copiedParent.filePath)).toEqual(copiedParentBefore);
		expect(launch.sink).toHaveLength(1);
	});

	it("creates and continues a new 0.2.1 child, preserving the v1 impVersion and machine-id protocol", async () => {
		expect(VERSION).toBe("0.2.1");
		const parent = createSession(cwd);
		const firstHost = childTask(parent, VERSION, [assistant([{ type: "text", text: "Ink child answer" }])]);
		const first = await firstHost.task.execute({ prompt: "Ink task" }, new AbortController().signal, {
			toolCallId: "task-1",
		});
		persistTask(parent, first);
		const transcript = first.taskRecord?.transcript;
		if (transcript?.present !== true) throw new Error("Expected Ink child transcript");
		const child = SessionStore.open(transcript.path);
		expect(child.header.launch?.version).toBe(1);
		expect(child.header.launch?.impVersion).toBe("0.2.1");
		expect(child.header.launch).not.toHaveProperty("inkVersion");
		expect(transcript.path).toContain(`${path.sep}.ink${path.sep}`);
		const machinePath = path.join(path.dirname(transcript.path), ".imp-machine-id");
		const machineBytes = "retained-historical-machine-id\n";
		write(machinePath, machineBytes);
		const beforeLease = vi.fn();
		const secondHost = childTask(
			parent,
			VERSION,
			[assistant([{ type: "text", text: "Continued Ink child" }])],
			beforeLease,
		);
		const resumed = await secondHost.task.execute(
			{ resume: child.header.id, prompt: "Continue Ink child" },
			new AbortController().signal,
		);
		expect(resumed.isError ?? false).toBe(false);
		expect(resumed.taskRecord?.launched).toBe(true);
		expect(resumed.taskRecord?.childId).toBe(child.header.id);
		expect(resumed.taskRecord?.transcript).toEqual(first.taskRecord?.transcript);
		expect(resumed.output).toContain("Continued Ink child");
		expect(beforeLease).toHaveBeenCalledTimes(1);
		expect(firstHost.sink).toHaveLength(1);
		expect(secondHost.sink).toHaveLength(1);
		expect(JSON.stringify(secondHost.sink[0]?.messages)).toContain("Ink child answer");
		const messages = SessionStore.open(transcript.path).buildContext().messages;
		expect(
			messages.filter((message) => message.role === "user" && message.content === "Continue Ink child"),
		).toHaveLength(1);
		expect(fs.readFileSync(machinePath, "utf8")).toBe(machineBytes);
		expect(fs.existsSync(path.join(path.dirname(transcript.path), ".ink-machine-id"))).toBe(false);
		expect(fs.readdirSync(`${transcript.path}.lease`)).toEqual([]);
	});
});

describe("historical and current worktree recognition", () => {
	it("lists old imp and new Ink children, creates only Ink names, and leaves all retained work untouched", async () => {
		const repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
		git(["init", "-q", "-b", "main"]);
		git(["config", "user.name", "Ink fixture"]);
		git(["config", "user.email", "ink-fixture@example.invalid"]);
		write(path.join(repo, "seed.txt"), "Fixture seed\n");
		git(["add", "."]);
		git(["commit", "-qm", "Fixture seed"]);
		const oldPath = path.join(root, "imp-worktree-historical");
		git(["worktree", "add", "-q", oldPath, "-b", "imp/task-historical"]);
		write(path.join(oldPath, "retained.txt"), "Historical work\n");
		const state = await resolveRepoState(repo);
		vi.stubEnv("IMP_WORKTREE_DIR", path.join(root, "old-override-must-not-be-used"));
		vi.stubEnv("INK_WORKTREE_DIR", root);
		const current = await createChildWorktree(state, "rename-fixture");
		expect(path.basename(current.path)).toBe("ink-worktree-rename-fixture");
		expect(current.branch).toBe("ink/task-rename-fixture");
		expect(fs.realpathSync(path.dirname(current.path))).toBe(fs.realpathSync(root));
		expect(fs.existsSync(path.join(root, "old-override-must-not-be-used"))).toBe(false);
		write(path.join(current.path, "new.txt"), "New work\n");
		const otherPath = path.join(root, "unrelated-worktree");
		git(["worktree", "add", "-q", otherPath, "-b", "unrelated"]);
		const listed = await listChildWorktrees(state);
		expect(listed.map((entry) => entry.branch).sort()).toEqual(
			["imp/task-historical", current.branch].sort(),
		);
		expect(listed.map((entry) => entry.path).sort()).toEqual(
			[fs.realpathSync(oldPath), fs.realpathSync(current.path)].sort(),
		);
		expect(listed.find((entry) => entry.branch === "imp/task-historical")?.stat).toContain("retained.txt");
		expect(listed.find((entry) => entry.branch === current.branch)?.stat).toContain("new.txt");
		expect(fs.readFileSync(path.join(oldPath, "retained.txt"), "utf8")).toBe("Historical work\n");
		expect(fs.readFileSync(path.join(current.path, "new.txt"), "utf8")).toBe("New work\n");
		expect(fs.existsSync(otherPath)).toBe(true);
	});
});
