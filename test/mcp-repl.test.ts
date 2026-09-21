import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import type { CommandContext } from "../src/repl/commands.js";
import { dispatchCommand } from "../src/repl/commands.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

const SERVER = join(import.meta.dirname, "helpers", "mcp-fake-server.mjs");

let tmp: string;
beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "imp-mcp-repl-"));
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

interface Env {
	ctx: CommandContext;
	output: () => string;
	requests: LLMRequest[];
}

async function makeEnv(provider?: LLMProvider): Promise<Env> {
	const baseDir = join(tmp, `env-${Math.random().toString(36).slice(2)}`);
	const requests: LLMRequest[] = [];
	const { renderer, output } = makeRenderer();
	const runner = await createRunner({
		cwd: baseDir,
		argv: [],
		settingsPath: join(baseDir, "settings.json"),
		model: "claude-sonnet-4-5",
		maxTokens: 1024,
		maxTurns: 5,
		noContextFiles: true,
		noSession: true,
		renderer,
		provider: provider ?? scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests),
	});
	const banner = output();
	return {
		ctx: {
			runner,
			renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => false,
			replay: () => 0,
			submitPrompt: () => {},
		},
		output: () => output().slice(banner.length),
		requests,
	};
}

describe("/mcp command", () => {
	it("without a manager it teaches where imp looked (read-only, allowed mid-run)", async () => {
		const env = await makeEnv();
		await dispatchCommand("/mcp", env.ctx);
		expect(env.output()).toContain("no MCP servers configured (looked in:");
		expect(env.output()).toContain(".config/mcp/mcp.json");
	});

	it("renders connected / failed / disabled states", async () => {
		const env = await makeEnv();
		const manager = new McpManager({
			servers: [
				{
					name: "up",
					command: process.execPath,
					args: [SERVER, "ok"],
					env: {},
					disabled: false,
				},
				{
					name: "down",
					command: process.execPath,
					args: [SERVER, "neverinit"],
					env: {},
					disabled: false,
				},
				{ name: "off", command: "x", args: [], env: {}, disabled: true },
			],
			cwd: tmp,
			version: "test",
			renderer: { note: (t) => notes.push(t), error: (t) => notes.push(t) } as never,
			connectTimeoutMs: 150,
			callTimeoutMs: 150,
		});
		const ctx = { ...env.ctx, mcp: manager } as CommandContext;
		await dispatchCommand("/mcp", ctx);
		const text = env.output();
		expect(text).toContain("up: connecting");
		expect(text).toContain("down: connecting");
		expect(text).toContain("off: disabled");
		manager.close();
	});

	it("reports the settings gate when mcp.enabled is false", async () => {
		// effectiveSettings comes from the runner's construction-time view; the
		// gate text is checked through a settings file in a fresh env.
		const baseDir = join(tmp, "gated");
		const { writeFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(baseDir, { recursive: true });
		writeFileSync(join(baseDir, "settings.json"), JSON.stringify({ mcp: { enabled: false } }), "utf-8");
		const requests: LLMRequest[] = [];
		const { renderer, output } = makeRenderer();
		const { createRunner: freshRunner } = await import("../src/runner.js");
		const runner = await freshRunner({
			cwd: baseDir,
			argv: [],
			settingsPath: join(baseDir, "settings.json"),
			model: "claude-sonnet-4-5",
			maxTokens: 1024,
			maxTurns: 5,
			noContextFiles: true,
			noSession: true,
			renderer,
			provider: scriptedProvider([assistant([{ type: "text", text: "ok" }])], requests),
		});
		const banner = output();
		const gatedCtx: CommandContext = {
			runner,
			renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => false,
			replay: () => 0,
			submitPrompt: () => {},
		};
		await dispatchCommand("/mcp", gatedCtx);
		expect(output().slice(banner.length)).toContain("mcp disabled in settings");
	});
});

describe("e2e: the model calls a bridged MCP tool through the real loop", () => {
	it("runs a full turn whose assistant script calls fake_echo", async () => {
		const requests: LLMRequest[] = [];
		const script: LLMProvider = {
			name: "fake",
			stream: async function* (request) {
				requests.push(request);
				if (requests.length === 1) {
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							blocks: [{ type: "toolCall", id: "t1", name: "fake_echo", arguments: { proof: "live" } }],
							usage: { inputTokens: 1, outputTokens: 1 },
							stopReason: "tool_use",
						},
					} as never;
				} else {
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							blocks: [{ type: "text", text: "done" }],
							usage: { inputTokens: 1, outputTokens: 1 },
							stopReason: "end_turn",
						},
					} as never;
				}
			},
		};
		const env = await makeEnv(script);
		const runner = env.ctx.runner;
		const manager = new McpManager({
			servers: [
				{
					name: "fake",
					command: process.execPath,
					args: [SERVER, "ok"],
					env: {},
					disabled: false,
				} satisfies McpServerConfig,
			],
			cwd: tmp,
			version: "test",
			renderer: { note: () => {}, error: () => {} } as never,
			connectTimeoutMs: 2000,
			callTimeoutMs: 2000,
		});
		manager.attachToolsArray(runner.tools);
		manager.connectAll();
		// Wait for the bridge to land (idle → immediate registration).
		await new Promise<void>((resolve, reject) => {
			const start = Date.now();
			const tick = () => {
				if (runner.tools.some((t) => t.name === "fake_echo")) resolve();
				else if (Date.now() - start > 4000) reject(new Error("bridge did not land"));
				else setTimeout(tick, 25);
			};
			tick();
		});
		const result = await runner.runTurn({ userMessage: "call the echo tool" });
		expect(result.stopReason).toBe("completed");
		// The model's second request carries the tool result with the echoed args.
		const second = requests[1];
		expect(second).toBeDefined();
		const toolResult = second?.messages.find((m) => m.role === "toolResult");
		const serialized = JSON.stringify(toolResult);
		expect(serialized).toContain("fake_echo");
		// The fake server echoes the arguments back: content is the string
		// `{"proof":"live"}` (escaped inside the outer serialization).
		expect(serialized).toContain('{\\"proof\\":\\"live\\"}');
		manager.close();
	});
});
