import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	discoverMcpConfig,
	expandEnvPlaceholders,
	type McpServerConfig,
	type McpStdioServerConfig,
	mcpConfigPaths,
} from "../src/mcp/config.js";

/** Narrow helper — the schema is a union since M19 (kind: stdio | http). */
function stdioServer(server: McpServerConfig | undefined): McpStdioServerConfig {
	if (server === undefined || server.kind !== "stdio") throw new Error("expected a stdio server");
	return server;
}

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
		const result = discoverMcpConfig({
			home: join(dir, "empty-home"),
			cwd: join(dir, "empty-cwd"),
			projectAllowed: true,
		});
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
			const result = discoverMcpConfig({ home, cwd: join(dir, "h1-cwd"), projectAllowed: true });
			expect(result.servers).toHaveLength(1);
			expect(stdioServer(result.servers[0]).env).toEqual({ KEY: "secret", OTHER: "secret" });
		} finally {
			delete process.env.IMP_MCP_TEST_VAR;
		}
	});

	it("later files replace earlier entries whole-entry (project overrides global)", () => {
		writeGlobal(
			JSON.stringify({ mcpServers: { srv: { command: "global-cmd" }, other: { command: "keep-me" } } }),
		);
		writeProject(JSON.stringify({ mcpServers: { srv: { command: "project-cmd", args: ["--x"] } } }));
		const result = discoverMcpConfig({ home: dir, cwd: dir, projectAllowed: true });
		// home is the dir above .config — the five paths include our global file
		const srv = result.servers.find((s) => s.name === "srv");
		const other = result.servers.find((s) => s.name === "other");
		expect(stdioServer(srv).command).toBe("project-cmd");
		expect(stdioServer(srv).args).toEqual(["--x"]); // whole entry: no global fields leaked in
		expect(stdioServer(other).command).toBe("keep-me");
	});

	it("skips a server with disabled true but keeps it visible to /mcp", () => {
		writeProject(JSON.stringify({ mcpServers: { off: { command: "x", disabled: true } } }));
		const result = discoverMcpConfig({ home: join(dir, "no-home"), cwd: dir, projectAllowed: true });
		expect(result.servers).toHaveLength(1);
		expect(result.servers[0]?.disabled).toBe(true);
	});

	it("notes and skips a malformed JSON file, keeps other paths working", () => {
		writeProject("{ not json");
		const result = discoverMcpConfig({ home: join(dir, "no-home"), cwd: dir, projectAllowed: true });
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
		const result = discoverMcpConfig({ home: join(dir, "no-home"), cwd: dir, projectAllowed: true });
		expect(result.servers.map((s) => s.name)).toEqual(["good"]);
		expect(result.notes).toHaveLength(2);
	});

	it("notes a file whose mcpServers is not an object", () => {
		writeProject(JSON.stringify({ mcpServers: ["nope"] }));
		const result = discoverMcpConfig({ home: join(dir, "no-home"), cwd: dir, projectAllowed: true });
		expect(result.servers).toEqual([]);
		expect(result.notes[0]).toContain("mcpServers");
	});

	it("#mcp-trust: projectAllowed=false skips both project files and teaches once (global still read)", () => {
		const home = join(dir, "trust-home");
		const cwd = join(dir, "trust-cwd");
		mkdirSync(join(home, ".config", "mcp"), { recursive: true });
		writeFileSync(
			join(home, ".config", "mcp", "mcp.json"),
			JSON.stringify({ mcpServers: { g: { command: "g-cmd" } } }),
			"utf-8",
		);
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { p: { command: "p-cmd" } } }),
			"utf-8",
		);
		writeFileSync(
			join(cwd, "mcp.json"),
			JSON.stringify({ mcpServers: { q: { command: "q-cmd" } } }),
			"utf-8",
		);

		const blocked = discoverMcpConfig({ home, cwd, projectAllowed: false });
		expect(blocked.servers.map((s) => s.name)).toEqual(["g"]);
		expect(blocked.notes).toEqual([
			"mcp: project config skipped — directory not trusted (--trust to enable)",
		]);
		expect(blocked.paths).toHaveLength(5);

		const allowed = discoverMcpConfig({ home, cwd, projectAllowed: true });
		expect(allowed.servers.map((s) => s.name)).toEqual(["g", "p", "q"]);
		expect(allowed.notes).toEqual([]);
	});

	it("#mcp-trust: projectAllowed=false stays silent when no project file exists", () => {
		const home = join(dir, "trust-home-quiet");
		const cwd = join(dir, "trust-cwd-quiet");
		mkdirSync(cwd, { recursive: true });
		const result = discoverMcpConfig({ home, cwd, projectAllowed: false });
		expect(result.servers).toEqual([]);
		expect(result.notes).toEqual([]); // no skipped file → no noise (D4's zero-cost stance)
	});
});

describe("discoverMcpConfig http shape (M19 D2)", () => {
	function writeMcp(cwd: string, servers: Record<string, unknown>): void {
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: servers }), "utf-8");
	}

	it("parses a url server (streamableHttp alias) with env-expanded url + headers", () => {
		const cwd = join(dir, "http-a");
		process.env.IMP_MCP_HTTP_TOKEN = "tok-123";
		try {
			// biome noTemplateCurlyInString: build the placeholder by concatenation
			// (the same trick the stdio env-expansion case uses above)
			const placeholder = "${" + "IMP_MCP_HTTP_TOKEN}";
			writeMcp(cwd, {
				remote: {
					type: "streamableHttp",
					url: `https://mcp.example.com/token=${placeholder}`,
					headers: { Authorization: `Bearer ${placeholder}` },
				},
			});
			const result = discoverMcpConfig({ home: join(dir, "http-a-home"), cwd, projectAllowed: true });
			expect(result.notes).toEqual([]);
			const server = result.servers[0];
			expect(server?.kind).toBe("http");
			if (server?.kind === "http") {
				expect(server.url).toBe("https://mcp.example.com/token=tok-123");
				expect(server.headers).toEqual({ Authorization: "Bearer tok-123" });
				expect(server.disabled).toBe(false);
			}
		} finally {
			delete process.env.IMP_MCP_HTTP_TOKEN;
		}
	});

	it("url alone infers http; command+url and neither are skipped with a note", () => {
		const cwd = join(dir, "http-shapes");
		writeMcp(cwd, {
			urlOnly: { url: "https://a.example.com/mcp" },
			both: { command: "x", url: "https://b.example.com/mcp" },
			neither: { args: ["x"] },
		});
		const result = discoverMcpConfig({ home: join(dir, "http-shapes-home"), cwd, projectAllowed: true });
		expect(result.servers.map((s) => s.name)).toEqual(["urlOnly"]);
		expect(result.servers[0]?.kind).toBe("http");
		expect(result.notes).toHaveLength(2);
	});

	it("type conflicts, unknown types and sse teach one line each", () => {
		const cwd = join(dir, "http-types");
		writeMcp(cwd, {
			httpNoUrl: { type: "http", command: "x" },
			stdioNoCmd: { type: "stdio", url: "https://x.example.com/mcp" },
			sseRefused: { type: "sse", url: "https://s.example.com/mcp" },
			unknown: { type: "ws", url: "https://w.example.com/mcp" },
			httpOk: { type: "http", url: "https://ok.example.com/mcp" },
		});
		const result = discoverMcpConfig({ home: join(dir, "http-types-home"), cwd, projectAllowed: true });
		expect(result.servers.map((s) => s.name)).toEqual(["httpOk"]);
		expect(result.notes).toHaveLength(4);
		expect(result.notes.join("\n")).toContain("sse");
	});

	it("url validation: https anywhere, plain http only for loopback", () => {
		const cwd = join(dir, "http-urls");
		writeMcp(cwd, {
			https: { url: "https://a.example.com/mcp" },
			loopbackV4: { url: "http://127.0.0.1:1234/mcp" },
			loopbackV6: { url: "http://[::1]:1/mcp" },
			loopbackName: { url: "http://localhost:9/mcp" },
			remoteHttp: { url: "http://evil.example.com/mcp" },
			garbage: { url: "not a url" },
			ftp: { url: "ftp://host/mcp" },
		});
		const result = discoverMcpConfig({ home: join(dir, "http-urls-home"), cwd, projectAllowed: true });
		expect(result.servers.map((s) => s.name)).toEqual(["https", "loopbackV4", "loopbackV6", "loopbackName"]);
		expect(result.notes).toHaveLength(3);
	});

	it("header validation: bad names, non-string values and CRLF are refused", () => {
		const cwd = join(dir, "http-headers");
		writeMcp(cwd, {
			badName: { url: "https://a.example.com/mcp", headers: { "Bad Name": "x" } },
			nonString: { url: "https://b.example.com/mcp", headers: { "X-Key": 7 } },
			crlf: { url: "https://c.example.com/mcp", headers: { "X-Key": "a\r\nb" } },
			good: { url: "https://d.example.com/mcp", headers: { "X-Key": "ok" } },
		});
		const result = discoverMcpConfig({ home: join(dir, "http-headers-home"), cwd, projectAllowed: true });
		expect(result.servers.map((s) => s.name)).toEqual(["good"]);
		expect(result.notes).toHaveLength(3);
	});

	it("ignored fields teach but never reject: http ignores stdio fields, stdio ignores headers", () => {
		const cwd = join(dir, "http-ignored");
		writeMcp(cwd, {
			http: { url: "https://a.example.com/mcp", args: ["x"], env: { K: "v" }, cwd: "/tmp" },
			stdio: { command: "cmd", headers: { "X-K": "v" } },
		});
		const result = discoverMcpConfig({ home: join(dir, "http-ignored-home"), cwd, projectAllowed: true });
		expect(result.servers.map((s) => s.name)).toEqual(["http", "stdio"]);
		expect(result.notes).toHaveLength(4);
		expect(result.notes.join("\n")).toContain('"args" but a url');
	});

	it("disabled applies to http entries", () => {
		const cwd = join(dir, "http-disabled");
		writeMcp(cwd, { off: { url: "https://a.example.com/mcp", disabled: true } });
		const result = discoverMcpConfig({ home: join(dir, "http-disabled-home"), cwd, projectAllowed: true });
		expect(result.servers[0]?.disabled).toBe(true);
	});

	it("whole-entry replacement works across kinds (global http → project stdio)", () => {
		const home = join(dir, "http-switch-home");
		const cwd = join(dir, "http-switch-cwd");
		mkdirSync(join(home, ".config", "mcp"), { recursive: true });
		writeFileSync(
			join(home, ".config", "mcp", "mcp.json"),
			JSON.stringify({ mcpServers: { srv: { url: "https://g.example.com/mcp" } } }),
			"utf-8",
		);
		writeMcp(cwd, { srv: { command: "local-cmd" } });
		const result = discoverMcpConfig({ home, cwd, projectAllowed: true });
		const server = result.servers[0];
		expect(server?.kind).toBe("stdio");
		if (server?.kind === "stdio") expect(server.command).toBe("local-cmd");
	});
});
