import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentDefinitions, parseAgentFile } from "../src/core/agents/registry.js";

function tempProject(): { cwd: string; home: string; projectDir: string; homeDir: string } {
	const root = mkdtempSync(path.join(tmpdir(), "imp-agents-"));
	const cwd = path.join(root, "proj");
	const home = path.join(root, "home");
	const projectDir = path.join(cwd, ".imp", "agents");
	const homeDir = path.join(home, ".imp", "agents");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	return { cwd, home, projectDir, homeDir };
}

function agentFile(dir: string, name: string, content: string): string {
	const filePath = path.join(dir, `${name}.md`);
	writeFileSync(filePath, content, "utf8");
	return filePath;
}

const SCOUT = `---
name: scout
description: Explores a codebase to answer research questions
tools: read, grep , find
model: glm-5.3
timeout: 300
---

You are a code scout. Go broad before deep.
`;

describe("parseAgentFile", () => {
	it("parses full frontmatter: tools trimmed, timeout seconds → ms, body kept", () => {
		const parsed = parseAgentFile(SCOUT, "/x/scout.md");
		expect(parsed).not.toHaveProperty("warnings");
		if (typeof parsed === "string") throw new Error(parsed);
		expect(parsed.name).toBe("scout");
		expect(parsed.description).toBe("Explores a codebase to answer research questions");
		expect(parsed.tools).toEqual(["read", "grep", "find"]); // inner spaces trimmed
		expect(parsed.model).toBe("glm-5.3");
		expect(parsed.timeoutMs).toBe(300_000);
		expect(parsed.system).toBe("You are a code scout. Go broad before deep."); // trimmed
		expect(parsed.source).toBe("/x/scout.md");
	});

	it("minimal file: only name + description required", () => {
		const parsed = parseAgentFile("---\nname: a\ndescription: b\n---\nbody", "/x/a.md");
		if (typeof parsed === "string") throw new Error(parsed);
		expect(parsed.tools).toBeUndefined();
		expect(parsed.model).toBeUndefined();
		expect(parsed.timeoutMs).toBeUndefined();
		expect(parsed.system).toBe("body");
	});

	it("teaching diagnostics: missing name, missing description, no frontmatter, unterminated, bad timeout", () => {
		expect(parseAgentFile("---\ndescription: x\n---\n", "/x/1.md")).toBe('/x/1.md: missing required field "name"');
		expect(parseAgentFile("---\nname: x\n---\n", "/x/2.md")).toBe(
			'/x/2.md: missing required field "description"',
		);
		expect(parseAgentFile("just body\n", "/x/3.md")).toBe('/x/3.md: no frontmatter — start the file with a "---" line');
		expect(parseAgentFile("---\nname: x\ndescription: y\n", "/x/4.md")).toBe(
			'/x/4.md: unterminated frontmatter — close it with a "---" line',
		);
		expect(parseAgentFile("---\nname: x\ndescription: y\ntimeout: -5\n---\n", "/x/5.md")).toBe(
			'/x/5.md: invalid "timeout" "-5" — use positive seconds (e.g. timeout: 300)',
		);
		expect(parseAgentFile("---\nname: x\ndescription: y\ntimeout: soon\n---\n", "/x/6.md")).toContain(
			'invalid "timeout" "soon"',
		);
	});
});

describe("loadAgentDefinitions", () => {
	it("discovers user + project agents, alphabetical; project wins on collision", () => {
		const t = tempProject();
		agentFile(t.homeDir, "zz-user", '---\nname: zz-user\ndescription: from home\n---\nH');
		agentFile(t.projectDir, "scout", '---\nname: scout\ndescription: from project\n---\nP');
		agentFile(t.homeDir, "scout", '---\nname: scout\ndescription: from home\n---\nH');
		const { agents, warnings } = loadAgentDefinitions(t.cwd, t.home);
		expect(warnings).toEqual([]);
		expect(agents.map((a) => a.name)).toEqual(["scout", "zz-user"]); // alphabetical
		const scout = agents.find((a) => a.name === "scout");
		expect(scout?.description).toBe("from project"); // project wins
		expect(scout?.system).toBe("P");
	});

	it("invalid files warn and are skipped; valid ones still load", () => {
		const t = tempProject();
		agentFile(t.projectDir, "bad", "---\nname: bad\n---\n");
		agentFile(t.projectDir, "good", '---\nname: good\ndescription: fine\n---\nok');
		const { agents, warnings } = loadAgentDefinitions(t.cwd, t.home);
		expect(agents.map((a) => a.name)).toEqual(["good"]);
		expect(warnings).toEqual(['agent file skipped: ' + path.join(t.projectDir, "bad.md") + ': missing required field "description"']);
	});

	it("missing directories → empty registry, no warnings; non-.md files ignored", () => {
		const t = tempProject();
		agentFile(t.projectDir, "notes", "not an agent");
		writeFileSync(path.join(t.projectDir, "roster.json"), "{}", "utf8");
		const { agents, warnings } = loadAgentDefinitions(t.cwd, t.home);
		expect(agents).toEqual([]);
		expect(warnings).toHaveLength(1); // the .md without frontmatter
		expect(warnings[0]).toContain("no frontmatter");
	});
});
