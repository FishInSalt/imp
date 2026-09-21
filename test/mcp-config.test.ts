import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverMcpConfig, expandEnvPlaceholders, mcpConfigPaths } from "../src/mcp/config.js";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "imp-mcp-cfg-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeGlobal(content: string): string {
	const globalDir = join(dir, ".config", "mcp");
	mkdirSync(globalDir, { recursive: true });
	const file = join(globalDir, "mcp.json");
	writeFileSync(file, content, "utf-8");
	return file;
}

function writeProject(content: string): string {
	const file = join(dir, ".mcp.json");
	writeFileSync(file, content, "utf-8");
	return file;
}

describe("mcpConfigPaths", () => {
	it("lists the five discovery paths in pi-adapter order", () => {
		const paths = mcpConfigPaths({ home: "/h", cwd: "/w" });
		expect(paths).toEqual([
			"/h/.config/mcp/mcp.json",
			"/h/.agents/mcp.json",
			"/h/.agents/mcp/mcp.json",
			"/w/.mcp.json",
			"/w/mcp.json",
		]);
	});
});

describe("expandEnvPlaceholders", () => {
	it("expands all three placeholder forms", () => {
		process.env.IMP_MCP_TEST_VAR = "yes";
		try {
			expect(expandEnvPlaceholders("${" + "IMP_MCP_TEST_VAR}")).toBe("yes");
			expect(expandEnvPlaceholders("$env:" + "IMP_MCP_TEST_VAR")).toBe("yes");
			expect(expandEnvPlaceholders("{env:" + "IMP_MCP_TEST_VAR}")).toBe("yes");
			expect(expandEnvPlaceholders("pre-${" + "IMP_MCP_TEST_VAR}-post")).toBe("pre-yes-post");
		} finally {
			delete process.env.IMP_MCP_TEST_VAR;
		}
	});
	it("expands undefined variables to the empty string", () => {
		expect(expandEnvPlaceholders("x${" + "IMP_MCP_TEST_UNDEF}y")).toBe("xy");
	});
});

describe("discoverMcpConfig", () => {
	it("returns zero servers and no notes when nothing exists", () => {
		const result = discoverMcpConfig({ home: join(dir, "empty-home"), cwd: join(dir, "empty-cwd") });
		expect(result.servers).toEqual([]);
		expect(result.notes).toEqual([]);
		expect(result.paths).toHaveLength(5);
	});

	it("reads a global server and env-expands its values", () => {
		const home = join(dir, "h1");
		const globalDir = join(home, ".config", "mcp");
		mkdirSync(globalDir, { recursive: true });
		process.env.IMP_MCP_TEST_VAR = "secret";
		try {
			writeFileSync(
				join(globalDir, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						srv: {
							command: "npx",
							args: ["-y", "pkg"],
							env: { KEY: "${" + "IMP_MCP_TEST_VAR}", OTHER: "$env:" + "IMP_MCP_TEST_VAR" },
						},
					},
				}),
				"utf-8",
			);
			const result = discoverMcpConfig({ home, cwd: join(dir, "h1-cwd") });
			expect(result.servers).toHaveLength(1);
			expect(result.servers[0]?.env).toEqual({ KEY: "secret", OTHER: "secret" });
		} finally {
			delete process.env.IMP_MCP_TEST_VAR;
		}
	});

	it("later files replace earlier entries whole-entry (project overrides global)", () => {
		writeGlobal(
			JSON.stringify({ mcpServers: { srv: { command: "global-cmd" }, other: { command: "keep-me" } } }),
		);
		writeProject(JSON.stringify({ mcpServers: { srv: { command: "project-cmd", args: ["--x"] } } }));
		const result = discoverMcpConfig({ home: dir, cwd: dir });
		// home is the dir above .config — the five paths include our global file
		const srv = result.servers.find((s) => s.name === "srv");
		const other = result.servers.find((s) => s.name === "other");
		expect(srv?.command).toBe("project-cmd");
		expect(srv?.args).toEqual(["--x"]); // whole entry: no global fields leaked in
		expect(other?.command).toBe("keep-me");
	});

	it("skips a server with disabled true but keeps it visible to /mcp", () => {
		writeProject(JSON.stringify({ mcpServers: { off: { command: "x", disabled: true } } }));
		const result = discoverMcpConfig({ home: join(dir, "no-home"), cwd: dir });
		expect(result.servers).toHaveLength(1);
		expect(result.servers[0]?.disabled).toBe(true);
	});

	it("notes and skips a malformed JSON file, keeps other paths working", () => {
		writeProject("{ not json");
		const result = discoverMcpConfig({ home: join(dir, "no-home"), cwd: dir });
		expect(result.servers).toEqual([]);
		expect(result.notes).toHaveLength(1);
		expect(result.notes[0]).toContain("not valid JSON");
	});

	it("notes and skips bad entries without failing the file", () => {
		writeProject(
			JSON.stringify({
				mcpServers: {
					noCmd: { args: ["x"] },
					badArgs: { command: "c", args: [1] },
					good: { command: "ok-cmd" },
				},
			}),
		);
		const result = discoverMcpConfig({ home: join(dir, "no-home"), cwd: dir });
		expect(result.servers.map((s) => s.name)).toEqual(["good"]);
		expect(result.notes).toHaveLength(2);
	});

	it("notes a file whose mcpServers is not an object", () => {
		writeProject(JSON.stringify({ mcpServers: ["nope"] }));
		const result = discoverMcpConfig({ home: join(dir, "no-home"), cwd: dir });
		expect(result.servers).toEqual([]);
		expect(result.notes[0]).toContain("mcpServers");
	});
});
