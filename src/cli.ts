import { listSessions } from "./core/session/manager.js";
import { loadDotEnv } from "./env.js";
import { dim, red, VERSION } from "./format.js";
import { Renderer } from "./repl/render.js";
import { runRepl } from "./repl/repl.js";
import { createRunner, type Runner, type RunnerOptions, resolveRunMode } from "./runner.js";

// The help text is a single string kept here (top of file); VERSION comes from format.ts.
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
  imp                     Start an interactive session (REPL)
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
	if (opts.help) {
		process.stdout.write(HELP);
		process.exit(0);
	}

	const mode = resolveRunMode({
		promptDefined: opts.prompt !== undefined,
		stdinIsTty: process.stdin.isTTY === true,
	});
	if (mode === "print") {
		await runPrint(opts, argv);
		return;
	}
	await runInteractive(opts, argv);
}

/**
 * Interactive/scripted REPL over one shared Runner. Graceful exits resolve a
 * code; the zero-line-pipe guard (forgot -p) resolves 1 and prints HELP here —
 * the REPL itself never imports this module's HELP.
 */
async function runInteractive(opts: CliOptions, argv: string[]): Promise<void> {
	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	const renderer = new Renderer({
		write: (text) => process.stdout.write(text),
		ansi: process.stdout.isTTY === true,
		liveTools: interactive, // no in-place pending tool lines on a pipe
		toolStyle: "one-line",
	});
	let runner: Runner;
	try {
		runner = await createRunner({ ...runnerOptions(opts, argv, renderer), deferInit: !interactive });
	} catch (err) {
		reportStartupError(err);
		return;
	}
	let code: number;
	try {
		code = await runRepl({ runner });
	} catch (err) {
		reportStartupError(err);
		runner.close();
		return;
	}
	runner.close();
	if (code === 1) {
		// zero-line piped stdin — preserves the old "forgot -p" HELP guard
		process.stdout.write(HELP);
	}
	process.exit(code);
}

function runnerOptions(opts: CliOptions, argv: string[], renderer: Renderer): RunnerOptions {
	return {
		cwd: process.cwd(),
		argv,
		model: opts.model,
		maxTokens: opts.maxTokens,
		maxTurns: opts.maxTurns,
		noContextFiles: opts.noContextFiles,
		noSession: opts.noSession,
		resume: opts.resume,
		continueRecent: opts.continueRecent,
		renderer,
	};
}

function reportStartupError(err: unknown): void {
	process.stderr.write(red(`imp: ${err instanceof Error ? err.message : String(err)}\n`));
	process.exitCode = 1;
}

/** Print mode: one runTurn over a fresh Runner, byte-identical to the pre-runner output. */
async function runPrint(opts: CliOptions, argv: string[]): Promise<void> {
	const renderer = new Renderer({
		write: (text) => process.stdout.write(text),
		ansi: process.stdout.isTTY === true,
		liveTools: false,
		toolStyle: "two-line",
	});
	let runner: Runner;
	try {
		runner = await createRunner(runnerOptions(opts, argv, renderer));
	} catch (err) {
		reportStartupError(err);
		return;
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
		const result = await runner.runTurn({
			userMessage: opts.prompt,
			signal: controller.signal,
			onEvent: (event) => renderer.event(event),
		});
		renderer.endRun(true);
		runner.printRunStats(result);
		runner.printSessionStats();
	} catch (err) {
		renderer.endRun(true);
		reportStartupError(err);
	} finally {
		process.off("SIGINT", onSigint);
		runner.close();
	}
}

await main();
