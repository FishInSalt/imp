import { createAnthropicProvider } from "./provider/anthropic.js";
import type { LLMProvider } from "./provider/types.js";
import { runAgentLoop } from "./core/loop.js";
import type { AgentEvent } from "./core/loop.js";
import type { AgentMessage } from "./core/messages.js";
import { createBashTool } from "./core/tools/bash.js";
import { createReadTool } from "./core/tools/read.js";
import type { Tool } from "./core/tools/types.js";
import { buildSystemPrompt, defaultSystemPromptContext } from "./core/system-prompt.js";
import { loadDotEnv } from "./env.js";

const VERSION = "0.1.0";
// Read lazily (not at module top level) so loadDotEnv() can supply IMP_MODEL first.
const defaultModel = (): string => process.env.IMP_MODEL ?? "claude-sonnet-4-5";

interface CliOptions {
	prompt: string | undefined;
	model: string;
	maxTokens: number;
	maxTurns: number;
	help: boolean;
	version: boolean;
}

const HELP = `imp ${VERSION} — a small coding agent

Usage:
  imp -p "<prompt>"        Run a task in print mode (streams the response, then exits)
  imp "<prompt>"           Same as -p

Options:
  -p, --print <prompt>     Prompt to run
  -m, --model <id>         Model id (default: $IMP_MODEL or claude-sonnet-4-5)
      --max-tokens <n>     Max output tokens per turn (default: 16384)
      --max-turns <n>      Max agent turns per run (default: 40)
  -h, --help               Show this help
  -v, --version            Show version

Environment:
  ANTHROPIC_API_KEY          Anthropic API key
  ANTHROPIC_AUTH_TOKEN       Bearer token for Anthropic-compatible services
  ANTHROPIC_BASE_URL         Endpoint override (Anthropic-compatible services)
  IMP_MODEL                  Default model id

  Z.ai GLM Coding Plan example:
    export ANTHROPIC_AUTH_TOKEN=<your z.ai key>
    export ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
    export IMP_MODEL=glm-4.6

Examples:
  imp -p "List the .ts files here and count their total lines"
  imp -p "Read src/cli.ts and fix the bug in argument parsing"
  imp -p "..." -m glm-4.6
`;
function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		prompt: undefined,
		model: defaultModel(),
		maxTokens: 16384,
		maxTurns: 40,
		help: false,
		version: false,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		const next = (): string => {
			const value = argv[++i];
			if (value === undefined) {
				process.stderr.write(`Missing value for ${arg}\n\n${HELP}`);
				process.exit(1);
			}
			return value;
		};
		switch (arg) {
			case "-p":
			case "--print":
				opts.prompt = next();
				break;
			case "-m":
			case "--model":
				opts.model = next();
				break;
			case "--max-tokens":
				opts.maxTokens = Number.parseInt(next(), 10);
				break;
			case "--max-turns":
				opts.maxTurns = Number.parseInt(next(), 10);
				break;
			case "-h":
			case "--help":
				opts.help = true;
				break;
			case "-v":
			case "--version":
				opts.version = true;
				break;
			default:
				positional.push(arg);
		}
	}
	if (opts.prompt === undefined && positional.length > 0) {
		opts.prompt = positional.join(" ");
	}
	return opts;
}

// --- minimal ANSI helpers (no dependency) ---

const isTty = process.stdout.isTTY === true;
const dim = (s: string): string => (isTty ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string): string => (isTty ? `\x1b[31m${s}\x1b[0m` : s);

function firstLine(text: string, max = 160): string {
	const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function summarizeArgs(name: string, args: unknown): string {
	if (name === "bash") {
		const cmd = (args as { command?: string })?.command;
		return cmd !== undefined ? `$ ${cmd}` : JSON.stringify(args);
	}
	const json = JSON.stringify(args) ?? "";
	return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

function renderEvent(event: AgentEvent): void {
	switch (event.type) {
		case "text_delta":
			process.stdout.write(event.text);
			break;
		case "tool_start":
			process.stdout.write(`\n${dim(`● ${event.name} ${summarizeArgs(event.name, event.args)}`)}\n`);
			break;
		case "tool_end":
			if (event.result.isError) {
				process.stdout.write(red(`  ✗ ${firstLine(event.result.content)}`) + "\n");
			} else {
				process.stdout.write(dim(`  → ${firstLine(event.result.content)}`) + "\n");
			}
			break;
		default:
			// text/tool deltas are folded into the final message; nothing to print
			break;
	}
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

async function main(): Promise<void> {
	await loadDotEnv(); // loads .env from the imp installation root; real env wins
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || opts.prompt === undefined) {
		process.stdout.write(HELP);
		process.exit(opts.help ? 0 : 1);
	}
	if (opts.version) {
		process.stdout.write(`imp ${VERSION}\n`);
		return;
	}

	const provider: LLMProvider = createAnthropicProvider();
	const tools: Tool[] = [createBashTool(), createReadTool()];
	const history: AgentMessage[] = [];

	const controller = new AbortController();
	let sigintCount = 0;
	const onSigint = () => {
		sigintCount++;
		if (sigintCount === 1) {
			process.stdout.write(dim("\n(interrupt — press Ctrl+C again to force quit)\n"));
			controller.abort();
		} else {
			process.exit(130);
		}
	};
	process.on("SIGINT", onSigint);

	try {
		const result = await runAgentLoop({
			provider,
			model: opts.model,
			system: buildSystemPrompt(defaultSystemPromptContext()),
			tools,
			history,
			userMessage: opts.prompt,
			maxTokens: opts.maxTokens,
			maxIterations: opts.maxTurns,
			onEvent: renderEvent,
			signal: controller.signal,
		});

		process.stdout.write("\n");
		switch (result.stopReason) {
			case "aborted":
				process.stdout.write(dim("(aborted)\n"));
				break;
			case "max_iterations":
				process.stdout.write(red(`(stopped: reached max turns (${opts.maxTurns}))\n`));
				break;
			case "completed":
				break;
		}
		const cacheNote = result.usage.cacheReadTokens
			? ` · cache↓${formatTokens(result.usage.cacheReadTokens)}`
			: "";
		process.stdout.write(
			dim(`— ${opts.model} · ${result.turns} turns · in ${formatTokens(result.usage.inputTokens)} / out ${formatTokens(result.usage.outputTokens)} tokens${cacheNote}\n`),
		);
	} catch (err) {
		process.stdout.write("\n");
		process.stderr.write(red(`imp: ${err instanceof Error ? err.message : String(err)}\n`));
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

await main();
