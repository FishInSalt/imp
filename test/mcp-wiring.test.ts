import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpManager } from "../src/mcp/manager.js";
import type { LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { runRepl } from "../src/repl/repl.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeConsole, scriptedProvider, waitUntil } from "./helpers/fakes.js";

const SERVER = path.join(import.meta.dirname, "helpers", "mcp-fake-server.mjs");

// Full-path pin for the runRepl → ReplMachine wiring (review P1-1): the
// manager must actually reach the machine, or /mcp lies and graceful exit
// leaves every MCP child (and its ref'd pipes) holding the process open.
describe("runRepl wiring (review P1-1)", () => {
	let baseDir = "";
	let notes: string[] = [];

	beforeEach(async () => {
		baseDir = await mkdtemp(path.join(tmpdir(), "imp-mcp-wire-"));
		notes = [];
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("/mcp renders live servers and /exit closes the MCP children", async () => {
		const pidFile = path.join(baseDir, "fake.pid");
		const requests: LLMRequest[] = [];
		const fake = makeConsole({ tty: true });
		const renderer = new Renderer({
			write: (t) => fake.stdout.write(t),
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
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests),
		});
		const manager = new McpManager({
			servers: [
				{
					name: "fake",
					command: process.execPath,
					args: [SERVER, "ok"],
					env: { FAKE_MCP_PIDFILE: pidFile },
					disabled: false,
				},
			],
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
			input: fake.stdin,
			output: fake.stdout,
			interactive: true,
			shell: "legacy",
			exit: (code) => {
				throw new Error(`force-exit:${code}`);
			},
			mcp: manager, // the seam P1-1 forgot
		});

		// Server connects and its tools land.
		await waitUntil(() => runner.tools.some((t) => t.name === "fake_echo"), 8000);
		fake.send("/mcp\n");
		await waitUntil(() => fake.output().includes("fake: connected"), 5000);
		expect(fake.output()).not.toContain("no MCP servers configured");

		fake.send("/exit\n");
		const code = await Promise.race([
			replPromise,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runRepl did not settle")), 15000)),
		]);
		expect(code).toBe(0);
		expect(existsSync(pidFile)).toBe(true);
		const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
		// gracefulExit → mcp.close() must actually kill the child (the hang P1-1
		// proved with a live pty): stdin.end lets the server exit by itself.
		await waitUntil(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		}, 8000);
	});
});
