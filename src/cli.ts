import path from "node:path";
import {
	compactSession,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	shouldCompact,
} from "./core/compaction.js";
import { loadContextFiles } from "./core/context-files.js";
import { createRunLogger, type RunLogger } from "./core/logger.js";
import type { AgentEvent } from "./core/loop.js";
import { runAgentLoop } from "./core/loop.js";
import type { AgentMessage } from "./core/messages.js";
import { createSession, listSessions, resolveSession } from "./core/session/manager.js";
import type { SessionStore } from "./core/session/store.js";
import { buildSystemPrompt, defaultSystemPromptContext } from "./core/system-prompt.js";
import { createBashTool } from "./core/tools/bash.js";
import { createEditTool } from "./core/tools/edit.js";
import { createFindTool } from "./core/tools/find.js";
import { createGrepTool } from "./core/tools/grep.js";
import { createReadTool } from "./core/tools/read.js";
import type { Tool } from "./core/tools/types.js";
import { createWriteTool } from "./core/tools/write.js";
import { loadDotEnv } from "./env.js";
import { createAnthropicProvider } from "./provider/anthropic.js";
import { withLogging } from "./provider/logging.js";
import type { LLMProvider } from "./provider/types.js";

const VERSION = "0.1.0";
// Read lazily (not at module top level) so loadDotEnv() can supply IMP_MODEL first.
const defaultModel = (): string => process.env.IMP_MODEL ?? "claude-sonnet-4-5";

interface CliOptions {
	prompt: string | undefined;
	model: string;
	maxTokens: number;
	maxTurns: number;
	noContextFiles: boolean;
	continueRecent: boolean;
	resume: string | undefined;
	noSession: boolean;
	help: boolean;
	version: boolean;
}

const HELP = `imp ${VERSION} — a small coding agent

Usage:
  imp -p "<prompt>"        Run a task in print mode (streams the response, then exits)
  imp "<prompt>"           Same as -p
  imp sessions             List saved sessions for this directory

Options:
  -p, --print <prompt>     Prompt to run
  -m, --model <id>         Model id (default: $IMP_MODEL or claude-sonnet-4-5)
      --max-tokens <n>     Max output tokens per turn (default: 16384)
      --max-turns <n>      Max agent turns per run (default: 40)
  -nc, --no-context-files  Skip AGENTS.md discovery
  -c, --continue           Continue the most recent session in this directory
  -r, --resume <id>        Resume a session by id (prefix ok) — see \`imp sessions\`
      --no-session         Do not persist this run (also disables auto-compaction)
  -h, --help               Show this help
  -v, --version            Show version

Environment:
  ANTHROPIC_API_KEY          Anthropic API key
  ANTHROPIC_AUTH_TOKEN       Bearer token for Anthropic-compatible services
  ANTHROPIC_BASE_URL         Endpoint override (Anthropic-compatible services)
  IMP_MODEL                  Default model id
  IMP_CONTEXT_WINDOW         Model context window for auto-compaction (default: 131072)
  IMP_AUTOCOMPACT=0          Disable auto-compaction

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
		noContextFiles: false,
		continueRecent: false,
		resume: undefined,
		noSession: false,
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
			case "-nc":
			case "--no-context-files":
				opts.noContextFiles = true;
				break;
			case "-c":
			case "--continue":
				opts.continueRecent = true;
				break;
			case "-r":
			case "--resume":
				opts.resume = next();
				break;
			case "--no-session":
				opts.noSession = true;
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
				process.stdout.write(`${red(`  ✗ ${firstLine(event.result.content)}`)}\n`);
			} else {
				process.stdout.write(`${dim(`  → ${firstLine(event.result.content)}`)}\n`);
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

/** `imp sessions` — list saved sessions for this directory. */
function printSessionList(): void {
	const sessions = listSessions(process.cwd());
	if (sessions.length === 0) {
		process.stdout.write(dim("No saved sessions for this directory yet.\n"));
		return;
	}
	for (const s of sessions) {
		const date = s.modified.toISOString().slice(0, 16).replace("T", " ");
		process.stdout.write(
			`${dim(date)}  ${s.id.slice(0, 8)}  ${dim(`${s.messageCount} msgs · ${s.turnCount} turns`)}  ${s.title}\n`,
		);
	}
	process.stdout.write(
		dim(`\nResume with: imp -c            (most recent)\n             imp -r <id>       (specific)\n`),
	);
}

async function main(): Promise<void> {
	await loadDotEnv(); // loads .env from the imp installation root; real env wins
	const argv = process.argv.slice(2);
	if (argv[0] === "sessions") {
		printSessionList();
		return;
	}
	const opts = parseArgs(argv);
	if (opts.version) {
		process.stdout.write(`imp ${VERSION}\n`);
		return;
	}
	if (opts.help || opts.prompt === undefined) {
		process.stdout.write(HELP);
		process.exit(opts.help ? 0 : 1);
	}

	const provider: LLMProvider = createAnthropicProvider();
	const logger: RunLogger = await createRunLogger({ cwd: process.cwd(), argv: process.argv.slice(2) });
	const tools: Tool[] = [
		createBashTool(),
		createReadTool(),
		createEditTool(),
		createWriteTool(),
		createGrepTool(),
		createFindTool(),
	];
	const history: AgentMessage[] = [];

	// --- session: create, resume, or skip ---
	let session: SessionStore | null = null;
	if (opts.noSession) {
		// --no-session: stateless run (also no compaction — there is no session to compact)
	} else {
		try {
			if (opts.resume !== undefined || opts.continueRecent) {
				session = resolveSession(process.cwd(), {
					resume: opts.resume,
					continueRecent: opts.continueRecent,
				});
				if (session) {
					const loaded = session.buildContext();
					history.push(...loaded.messages);
					const stats = session.stats();
					const est = estimateContextTokens(history);
					process.stdout.write(
						dim(
							`▪ resumed ${session.header.id.slice(0, 8)} · ${stats.messageCount} msgs · ~${formatTokens(est.tokens)} tokens${loaded.compacted ? " (compacted)" : ""}\n`,
						),
					);
				} else {
					process.stdout.write(dim("▪ no previous session, starting fresh\n"));
				}
			}
			if (!session) session = createSession(process.cwd());
		} catch (err) {
			process.stderr.write(red(`imp: ${err instanceof Error ? err.message : String(err)}\n`));
			process.exitCode = 1;
			return;
		}
	}
	// const capture: narrowing survives into the closures below
	const activeSession = session;

	let system = buildSystemPrompt(defaultSystemPromptContext());
	if (!opts.noContextFiles) {
		const context = loadContextFiles(process.cwd());
		if (context) {
			system += `\n\n# Project context (AGENTS.md)\n\n${context.text}`;
			const display = context.files.map((f) => path.relative(process.cwd(), f) || f).join(", ");
			process.stdout.write(dim(`▪ context: ${display}\n`));
		}
	}

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
		const autoCompact = process.env.IMP_AUTOCOMPACT !== "0";
		const settings = DEFAULT_COMPACTION_SETTINGS;
		const result = await runAgentLoop({
			provider: withLogging(provider, logger),
			model: opts.model,
			system,
			tools,
			history,
			userMessage: opts.prompt,
			maxTokens: opts.maxTokens,
			maxIterations: opts.maxTurns,
			onMessage: (message) => activeSession?.appendMessage(message),
			onBeforeTurn: activeSession
				? async (h) => {
						if (!autoCompact) return;
						const est = estimateContextTokens(h);
						if (!shouldCompact(est.tokens, settings)) return;
						process.stdout.write(dim(`\n▪ context ~${formatTokens(est.tokens)} tokens — compacting…\n`));
						const compacted = await compactSession({
							session: activeSession,
							provider: withLogging(provider, logger),
							model: opts.model,
							settings,
						});
						if (compacted) {
							h.splice(0, h.length, ...activeSession.buildContext().messages);
							process.stdout.write(
								dim(
									`▪ compacted: ~${formatTokens(compacted.tokensBefore)} → ~${formatTokens(compacted.tokensAfter)} tokens (${compacted.retainedCount} msgs kept verbatim)\n`,
								),
							);
						} else {
							// Estimate said full, but the retained-tail window already covers everything
							// (typical right after resume — the usage anchor is still pre-compaction).
							process.stdout.write(dim("▪ nothing safe to compact yet — continuing\n"));
						}
					}
				: undefined,
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
			dim(
				`— ${opts.model} · ${result.turns} turns · in ${formatTokens(result.usage.inputTokens)} / out ${formatTokens(result.usage.outputTokens)} tokens${cacheNote}\n`,
			),
		);
		logger.log("run_end", { stopReason: result.stopReason, turns: result.turns, usage: result.usage });
		if (activeSession) {
			const stats = activeSession.stats();
			process.stdout.write(
				dim(
					`— session ${activeSession.header.id.slice(0, 8)} · ${stats.messageCount} msgs total · in ${formatTokens(stats.inputTokens)} / out ${formatTokens(stats.outputTokens)} cumulative\n`,
				),
			);
		}
	} catch (err) {
		process.stdout.write("\n");
		process.stderr.write(red(`imp: ${err instanceof Error ? err.message : String(err)}\n`));
		logger.log("run_error", { message: err instanceof Error ? err.message : String(err) });
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onSigint);
		logger.close();
	}
}

await main();
