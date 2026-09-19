/**
 * M12 skills batch 1 — loader, discovery, validation, trust wiring, and
 * system-prompt injection. The /skill:name command surface is batch 2.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/core/settings.js";
import {
	ancestorAgentsSkillDirs,
	formatSkillsForPrompt,
	loadSkills,
	parseSkillFile,
	type Skill,
} from "../src/core/skills.js";
import { trustRequiringResources } from "../src/core/trust.js";

function tmp(name: string): string {
	return mkdtempSync(join(tmpdir(), `imp-skills-${name}-`));
}

function writeSkill(
	dir: string,
	frontmatter = "description: d\n",
	body = "instructions",
	file = "SKILL.md",
): string {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, file);
	writeFileSync(filePath, `---\n${frontmatter}---\n${body}\n`, "utf8");
	return filePath;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseSkillFile", () => {
	it("splits frontmatter and body, tolerating BOM and CRLF", () => {
		const { frontmatter, body } = parseSkillFile(
			"\uFEFF---\r\nname: x\r\ndescription: y\r\n---\r\nhello\r\n",
		);
		expect(frontmatter.name).toBe("x");
		expect(frontmatter.description).toBe("y");
		expect(body).toBe("hello");
	});
	it("parses real-world YAML: folded descriptions and quoted colons", () => {
		const { frontmatter } = parseSkillFile(
			'---\nname: pdf\ndescription: >\n  Extracts text and tables from PDF files. Use when the user says "pdf: forms".\nmeta: "a: b"\n---\nbody\n',
		);
		expect(frontmatter.name).toBe("pdf");
		expect(frontmatter.description).toContain("Extracts text and tables");
		expect(frontmatter.description).toContain('"pdf: forms"');
	});
	it("no frontmatter → empty map, whole content is the body (pi-exact: untrimmed)", () => {
		const { frontmatter, body } = parseSkillFile("# just markdown\n");
		expect(frontmatter).toEqual({});
		expect(body).toBe("# just markdown\n");
	});
	it("unterminated frontmatter degrades to plain markdown", () => {
		const { frontmatter, body } = parseSkillFile("---\nname: x\nno closer");
		expect(frontmatter).toEqual({});
		expect(body).toContain("name: x");
	});
	it("malformed YAML throws (callers decide the diagnostics)", () => {
		expect(() => parseSkillFile("---\nname: [unclosed\n---\nbody\n")).toThrow();
	});
});

describe("loadSkills — discovery", () => {
	it("a directory with SKILL.md is ONE skill — no recursion below it", () => {
		const root = tmp("root");
		writeSkill(join(root, "outer"));
		writeSkill(join(root, "outer", "inner")); // must NOT be discovered
		const result = loadSkills({
			cwd: root,
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills.map((s) => s.name)).toEqual(["outer"]);
	});

	it("bare .md at an imp-style root is a skill; at an agents-style root it is ignored, nested grouping .md is found", () => {
		const home = tmp("home");
		// user tiers: ~/.imp/skills (imp mode) + ~/.agents/skills (agents mode).
		// (mkdirSync returns the FIRST directory it created under recursive —
		// never join() off that return value; build paths explicitly.)
		const impRoot = join(home, ".imp", "skills");
		mkdirSync(impRoot, { recursive: true });
		writeFileSync(join(impRoot, "loose.md"), "---\nname: loose\ndescription: root md\n---\nbody\n");
		const agentsRoot = join(home, ".agents", "skills");
		mkdirSync(agentsRoot, { recursive: true });
		writeFileSync(
			join(agentsRoot, "root-md.md"),
			"---\nname: rootmd\ndescription: ignored at agents root\n---\nbody\n",
		);
		mkdirSync(join(agentsRoot, "grouping"), { recursive: true });
		writeFileSync(
			join(agentsRoot, "grouping", "nested.md"),
			"---\nname: nested\ndescription: nested md counts\n---\nbody\n",
		);
		const result = loadSkills({
			cwd: tmp("cwd"),
			home,
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [],
		});
		expect(result.skills.map((s) => s.name).sort()).toEqual(["loose", "nested"]);
		expect(result.skills.find((s) => s.name === "loose")?.source).toBe("user");
	});

	it("dot-entries and node_modules are skipped", () => {
		const root = tmp("root");
		writeSkill(join(root, ".hidden"));
		writeSkill(join(root, "node_modules", "pkg"));
		writeSkill(join(root, "real"));
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills.map((s) => s.name)).toEqual(["real"]);
	});

	it("a symlinked skill file is deduplicated by realpath", () => {
		const root = tmp("root");
		const real = writeSkill(join(root, "real"));
		mkdirSync(join(root, "link"), { recursive: true });
		symlinkSync(real, join(root, "link", "SKILL.md"));
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills).toHaveLength(1);
	});

	it("name collisions: first loaded wins with a warning", () => {
		const root = tmp("root");
		writeSkill(join(root, "a"), "name: dup\ndescription: first\n");
		writeSkill(join(root, "b"), "name: dup\ndescription: second\n");
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills).toHaveLength(1);
		expect(result.skills[0]?.description).toBe("first");
		expect(
			result.diagnostics.some(
				(d) => d.message.includes('collision: "dup"') && d.message.includes("loses to"),
			),
		).toBe(true);
	});

	it("precedence: explicit paths > project > user (first-wins)", () => {
		const home = tmp("home");
		const cwd = tmp("cwd");
		writeSkill(join(home, ".imp", "skills", "dup"), "name: dup\ndescription: user\n");
		writeSkill(join(cwd, ".imp", "skills", "dup"), "name: dup\ndescription: project\n");
		const explicitDir = tmp("explicit");
		writeSkill(join(explicitDir, "dup"), "name: dup\ndescription: explicit\n");
		const result = loadSkills({
			cwd,
			home,
			projectTrusted: true,
			noSkills: false,
			explicitPaths: [explicitDir],
		});
		expect(result.skills.find((s) => s.name === "dup")?.description).toBe("explicit");
	});

	it("untrusted project: project tiers skipped entirely, user tiers still load", () => {
		const home = tmp("home");
		const cwd = tmp("cwd");
		writeSkill(join(home, ".imp", "skills", "global"));
		writeSkill(join(cwd, ".imp", "skills", "local"));
		const untrusted = loadSkills({ cwd, home, projectTrusted: false, noSkills: false, explicitPaths: [] });
		expect(untrusted.skills.map((s) => s.name)).toEqual(["global"]);
		const trusted = loadSkills({ cwd, home, projectTrusted: true, noSkills: false, explicitPaths: [] });
		expect(trusted.skills.map((s) => s.name)).toEqual(["local", "global"]);
	});

	it("--no-skills skips every default location; explicit paths still load", () => {
		const home = tmp("home");
		const cwd = tmp("cwd");
		writeSkill(join(home, ".imp", "skills", "global"));
		writeSkill(join(cwd, ".imp", "skills", "local"));
		const explicitDir = tmp("explicit2");
		writeSkill(join(explicitDir, "kept"));
		const result = loadSkills({
			cwd,
			home,
			projectTrusted: true,
			noSkills: true,
			explicitPaths: [explicitDir],
		});
		expect(result.skills.map((s) => s.name)).toEqual(["kept"]);
	});

	it("explicit file entries: .md loads, anything else warns and is skipped", () => {
		const dir = tmp("files");
		const md = join(dir, "one.md");
		writeFileSync(md, "---\nname: one\ndescription: d\n---\nb\n");
		const txt = join(dir, "two.txt");
		writeFileSync(txt, "not a skill\n");
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: true,
			explicitPaths: [md, txt, join(dir, "missing")],
		});
		expect(result.skills.map((s) => s.name)).toEqual(["one"]);
		expect(result.diagnostics.some((d) => d.message.includes("is not a markdown file"))).toBe(true);
		expect(result.diagnostics.some((d) => d.message.includes("does not exist"))).toBe(true);
	});
});

describe("loadSkills — validation (warn-not-block)", () => {
	it("missing name falls back to the parent directory name", () => {
		const root = tmp("noname");
		writeSkill(join(root, "pdf-tools"), "description: d\n");
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills[0]?.name).toBe("pdf-tools");
		expect(result.diagnostics).toHaveLength(0);
	});
	it("invalid names warn but still load; missing description skips with a warning", () => {
		const root = tmp("bad");
		writeSkill(join(root, "a"), "name: UPPER\ndescription: d\n");
		writeSkill(join(root, "b"), "name: x-double--dash\ndescription: d\n");
		writeSkill(join(root, "c"), "name: lead-\ndescription: d\n");
		const long = "x".repeat(65);
		writeSkill(join(root, "d"), `name: ${long}\ndescription: d\n`);
		writeSkill(join(root, "e"), "name: nodesc\n"); // no description
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills.map((s) => s.name)).toEqual(["UPPER", "x-double--dash", "lead-", long]);
		const nameWarnings = result.diagnostics.filter((d) => d.message.includes("invalid: must be 1-64 chars"));
		expect(nameWarnings).toHaveLength(4);
		const descWarning = result.diagnostics.find((d) =>
			d.message.includes("ignored — description is required"),
		);
		expect(descWarning?.path).toContain(join(root, "e", "SKILL.md"));
	});
	it("a 65-char valid name is fine; 1025-char description warns but loads", () => {
		const root = tmp("limits");
		writeSkill(join(root, "ok-name"), "name: ok-name\ndescription: d\n");
		writeSkill(join(root, "long-desc"), `name: long-desc\ndescription: ${"d".repeat(1025)}\n`);
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills).toHaveLength(2);
		expect(result.diagnostics.some((d) => d.message.includes("exceeds 1024 characters (1025)"))).toBe(true);
	});
	it("malformed YAML in SKILL.md warns and skips; bare .md without description is silent", () => {
		const root = tmp("yaml");
		mkdirSync(join(root, "broken"), { recursive: true });
		writeFileSync(join(root, "broken", "SKILL.md"), "---\nname: [unclosed\n---\nbody\n");
		writeFileSync(join(root, "quiet.md"), "---\nname: quiet\n---\nno description\n");
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills).toHaveLength(0);
		expect(result.diagnostics.some((d) => d.message.includes("failed to parse"))).toBe(true);
		expect(result.diagnostics).toHaveLength(1); // the bare .md produced nothing
	});
	it("disable-model-invocation parses through", () => {
		const root = tmp("dmi");
		writeSkill(join(root, "hidden"), "name: hidden\ndescription: d\ndisable-model-invocation: true\n");
		const result = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		});
		expect(result.skills[0]?.disableModelInvocation).toBe(true);
	});
});

describe("ancestorAgentsSkillDirs", () => {
	it("walks cwd up to the git root, cwd first; ~/.agents/skills itself is carved out", () => {
		const base = tmp("git");
		const repo = join(base, "repo");
		const deep = join(repo, "a", "b");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(deep, { recursive: true });
		const home = tmp("home2");
		mkdirSync(join(home, ".agents", "skills"), { recursive: true });
		const dirs = ancestorAgentsSkillDirs(deep, home);
		// deep, a, repo — stopping AT the repo root; then filtered user-global
		expect(dirs).toEqual([
			join(deep, ".agents", "skills"),
			join(repo, "a", ".agents", "skills"),
			join(repo, ".agents", "skills"),
		]);
		// cwd under $HOME with no git root: the walk climbs toward the fs root,
		// but the entry exactly equal to the user-global dir is carved out (pi parity)
		const underHome = ancestorAgentsSkillDirs(join(home, "code"), home);
		expect(underHome[0]).toBe(join(home, "code", ".agents", "skills"));
		expect(underHome).not.toContain(join(home, ".agents", "skills"));
	});
	it("without a git root the walk climbs to the filesystem root", () => {
		const base = tmp("nogit");
		const dirs = ancestorAgentsSkillDirs(join(base, "x"), tmp("home3"));
		expect(dirs[0]).toBe(join(base, "x", ".agents", "skills"));
		// platform-independent: the LAST entry is the filesystem root's
		// .agents/skills — the walk did not stop early (macOS tmpdir is deep,
		// Linux /tmp is shallow; length alone is not portable)
		expect(dirs.at(-1)).toBe(join("/", ".agents", "skills"));
		expect(dirs.length).toBeGreaterThanOrEqual(3);
	});
});

describe("trustRequiringResources — skills additions (M12)", () => {
	it(".imp/skills in cwd gates", () => {
		const dir = tmp("t1");
		const elsewhere = tmp("t1home");
		mkdirSync(join(dir, ".imp", "skills"), { recursive: true });
		expect(trustRequiringResources(dir, elsewhere)).toEqual([".imp/skills"]);
	});
	it(".agents/skills in cwd gates, relative to cwd", () => {
		const dir = tmp("t2");
		const elsewhere = tmp("t2home");
		mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
		expect(trustRequiringResources(dir, elsewhere)).toEqual([".agents/skills"]);
	});
	it("an ancestor .agents/skills gates (up to the git root)", () => {
		const base = tmp("t3");
		const repo = join(base, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
		const sub = join(repo, "pkg", "lib");
		mkdirSync(sub, { recursive: true });
		expect(trustRequiringResources(sub, tmp("t3home"))).toEqual(["../../.agents/skills"]);
	});
	it("the user-global ~/.agents/skills never gates", () => {
		const home = tmp("t4home");
		const proj = join(home, "code", "proj");
		mkdirSync(proj, { recursive: true });
		// home's own .agents/skills is the user-global dir — carved out
		mkdirSync(join(home, ".agents", "skills"), { recursive: true });
		expect(trustRequiringResources(proj, home)).toEqual([]);
	});
});

describe("formatSkillsForPrompt", () => {
	const skills: Skill[] = [
		{
			name: "pdf",
			description: 'Handles <PDFs> & "forms"',
			filePath: "/s/pdf/SKILL.md",
			baseDir: "/s/pdf",
			source: "path",
			disableModelInvocation: false,
		},
		{
			name: "hidden",
			description: "user-only",
			filePath: "/s/h/SKILL.md",
			baseDir: "/s/h",
			source: "path",
			disableModelInvocation: true,
		},
	];
	it("emits the exact XML catalog, escaping name/description/location, excluding disable-model-invocation", () => {
		const block = formatSkillsForPrompt(skills);
		expect(block).toBe(
			"\n\nThe following skills provide specialized instructions for specific tasks.\n" +
				"Use the read tool to load a skill's file when the task matches its description.\n" +
				"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n" +
				"\n" +
				"<available_skills>\n" +
				"  <skill>\n" +
				"    <name>pdf</name>\n" +
				"    <description>Handles &lt;PDFs&gt; &amp; &quot;forms&quot;</description>\n" +
				"    <location>/s/pdf/SKILL.md</location>\n" +
				"  </skill>\n" +
				"</available_skills>",
		);
	});
	it("empty (or all-hidden) skill lists produce no block at all", () => {
		expect(formatSkillsForPrompt([])).toBe("");
		const hidden = skills[1];
		if (hidden === undefined) throw new Error("fixture missing");
		expect(formatSkillsForPrompt([hidden])).toBe("");
	});
	it("bash fallback wording when read is unavailable", () => {
		expect(formatSkillsForPrompt(skills, "bash")).toContain("Use bash to load a skill's file");
	});
});

describe("settings — skills keys (M12)", () => {
	it("skills accepts a bare string or array; non-strings drop; enableSkillCommands parses", async () => {
		const { writeFileSync: wf } = await import("node:fs");
		const dir = tmp("settings");
		const file = join(dir, "settings.json");
		wf(file, JSON.stringify({ skills: "~/shared", enableSkillCommands: false }), "utf8");
		expect(loadSettings(file)).toEqual({ skills: ["~/shared"], enableSkillCommands: false });
		wf(file, JSON.stringify({ skills: ["a", 3, "b"] }), "utf8");
		expect(loadSettings(file)).toEqual({ skills: ["a", "b"] });
		wf(file, JSON.stringify({ skills: [3, null] }), "utf8");
		expect(loadSettings(file)).toEqual({ skills: [] });
	});
});

describe("system prompt injection (runner)", () => {
	it("skills append to the system prompt and survive /new", async () => {
		const { createRunner } = await import("../src/runner.js");
		const { assistant, makeRenderer, scriptedProvider } = await import("./helpers/fakes.js");
		const { mkdtemp } = await import("node:fs/promises");
		const baseDir = await mkdtemp(join(tmpdir(), "imp-skills-run-"));
		const requests: unknown[] = [];
		const runner = await createRunner({
			cwd: join(baseDir, "proj"),
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 5,
			noContextFiles: true,
			noSession: true,
			settingsPath: join(baseDir, "settings.json"), // hermetic
			agentsHomeDir: baseDir, // hermetic
			sessionBaseDir: baseDir,
			renderer: makeRenderer().renderer,
			provider: scriptedProvider(
				[assistant([{ type: "text", text: "one" }]), assistant([{ type: "text", text: "two" }])],
				requests as never,
			),
			skills: [
				{
					name: "pdf",
					description: "pdf work",
					filePath: "/s/pdf/SKILL.md",
					baseDir: "/s/pdf",
					source: "path",
					disableModelInvocation: false,
				},
			],
		});
		await runner.runTurn({ userMessage: "go", signal: new AbortController().signal });
		const first = (requests[0] as { system: string }).system;
		expect(first).toContain("<available_skills>");
		expect(first.indexOf("<available_skills>")).toBeGreaterThan(first.indexOf("coding agent")); // after the base prompt
		runner.newSession();
		await runner.runTurn({ userMessage: "again", signal: new AbortController().signal });
		const second = (requests[1] as { system: string }).system;
		expect(second).toContain("<available_skills>");
		expect(second).toContain("<name>pdf</name>");
	});
});
