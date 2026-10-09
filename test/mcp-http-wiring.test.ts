// M19 wiring: runRepl renders an http server's status and /exit delivers the
// DELETE (manager.close → client.close → transport.close). Mirrors
// test/mcp-wiring.test.ts but with the http fixture — no child process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpManager } from "../src/mcp/manager.js";
import { Renderer } from "../src/render.js";
import { runRepl } from "../src/repl/repl.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeConsole, scriptedProvider, waitUntil } from "./helpers/fakes.js";
import { startFakeMcpHttpServer } from "./helpers/mcp-fake-http-server.js";
import { mkTempDir } from "./helpers/mktemp.js";

describe("runRepl wiring over http (M19)", () => {
	it("/mcp renders the http server and /exit sends DELETE", async () => {
		const baseDir = mkTempDir("ink-mcp-http-wire-");
		const fake = await startFakeMcpHttpServer();
		try {
			const notes: string[] = [];
			const fakeConsole = makeConsole({ tty: true });
			const renderer = new Renderer({
				write: (t) => fakeConsole.stdout.write(t),
				ansi: false,
				liveTools: false,
				toolStyle: "one-line",
			});
			const runner = await createRunner({
				cwd: baseDir,
				argv: [],
				model: "test-model",
				maxTokens: 1024,
				maxTurns: 5,
				noContextFiles: true,
				noSession: true,
				sessionBaseDir: baseDir,
				renderer,
				provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], []),
			});
			const manager = new McpManager({
				servers: [{ kind: "http", name: "fake", url: fake.url, headers: {}, disabled: false }],
				cwd: baseDir,
				version: "test",
				renderer: { note: (t: string) => notes.push(t), error: (t: string) => notes.push(t) } as never,
				connectTimeoutMs: 5000,
				callTimeoutMs: 5000,
			});
			manager.attachToolsArray(runner.tools);
			manager.connectAll();

			const replPromise = runRepl({
				runner,
				input: fakeConsole.stdin,
				output: fakeConsole.stdout,
				interactive: true,
				shell: "legacy",
				exit: (code) => {
					throw new Error(`force-exit:${code}`);
				},
				mcp: manager,
			});

			await waitUntil(() => runner.tools.some((t) => t.name === "fake_echo"), 8000);
			fakeConsole.send("/mcp\n");
			await waitUntil(() => fakeConsole.output().includes("fake: connected"), 5000);
			expect(fakeConsole.output()).not.toContain("no MCP servers configured");

			fakeConsole.send("/exit\n");
			const code = await Promise.race([
				replPromise,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("runRepl did not settle")), 15000),
				),
			]);
			expect(code).toBe(0);
			// gracefulExit launches close() (batch D makes it awaited); the DELETE
			// must still land once its promise runs (waitUntil throws on timeout).
			await waitUntil(() => fake.state.deleted >= 1, 8000);
			expect(fake.state.deleted).toBeGreaterThanOrEqual(1);
		} finally {
			await fake.close();
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
