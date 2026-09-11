import { homedir } from "node:os";
import { loadMdCommands } from "./core/commands-md.js";
import { listSessions } from "./core/session/manager.js";
import {
	askTrustOnce,
	canonicalizeDir,
	defaultTrustStorePath,
	describeTrustResources,
	nearestTrustEntry,
	readTrustFile,
	setTrust,
	trustRequiringResources,
} from "./core/trust.js";
import { loadDotEnv } from "./env.js";
import { type LoadedExtensions, loadExtensions, printExtensionDiagnostics } from "./extensions/loader.js";
import type { ConfirmOptions, RegisteredExtensionCommand } from "./extensions/types.js";
import { bold, dim, red, VERSION } from "./format.js";
import { loginCodex, logoutCodex } from "./provider/codex-auth.js";
import { THINKING_LEVELS } from "./provider/thinking.js";
import { Renderer } from "./render.js";
import { COMMANDS } from "./repl/commands.js";
import { historyFilePath } from "./repl/history.js";
import { runRepl, TtyConfirm } from "./repl/repl.js";
import { TranscriptSink } from "./repl/transcript.js";
import { askTrustViaTui, type TrustAskAnswer } from "./repl/trust-ask.js";
import { createRunner, type Runner, type RunnerOptions, resolveRunMode } from "./runner.js";
import { resolveShell } from "./tui.js";

// The help text is a single string kept here (top of file); VERSION comes from format.ts.
// Read lazily (not at module top level) so loadDotEnv() can supply IMP_MODEL first.
const defaultModel = (): string => process.env.IMP_MODEL ?? "claude-sonnet-4-5";

/** IMP_THINKING startup level; invalid values are ignored with a notice
 *  (unlike --thinking, which errors — a typo in a shell profile should not
 *  block the session). */
function envThinking(): import("./provider/thinking.js").ThinkingLevel | undefined {
	const raw = process.env.IMP_THINKING;
	if (raw === undefined) return undefined;
	if ((THINKING_LEVELS as readonly string[]).includes(raw)) return raw as CliOptions["thinking"];
	process.stderr.write(`imp: ignoring invalid IMP_THINKING="${raw}" (not a thinking level)\n`);
	return undefined;
}

interface CliOptions {
	prompt: string | undefined;
	model: string;
	/** --thinking <level> / IMP_THINKING (#thinking-levels, pi parity). */
	thinking: import("./provider/thinking.js").ThinkingLevel;
	maxTokens: number;
	maxTurns: number;
	noContextFiles: boolean;
	/** M8 trust gate: explicit --trust / --no-trust override the ask-once flow. */
	trustDecision: "trust" | "no-trust" | undefined;
	continueRecent: boolean;
	resume: string | undefined;
	noSession: boolean;
	extensionPaths: string[];
	noExtensions: boolean;
	help: boolean;
	version: boolean;
}

const HELP = `imp ${VERSION} — a small coding agent

Usage:
  imp -p "<prompt>"        Run a task in print mode (streams the response, then exits)
  imp "<prompt>"           Same as -p
  imp                     Start an interactive session (REPL)
  imp sessions             List saved sessions for this directory
  imp login                Log in to OpenAI (ChatGPT plan) — device-code OAuth
  imp logout               Remove the stored OpenAI credential

Options:
  -p, --print <prompt>     Prompt to run
  -m, --model <id>         Model id (default: $IMP_MODEL or claude-sonnet-4-5)
      --max-tokens <n>     Max output tokens per turn (default: 16384)
      --max-turns <n>      Max agent turns per run (default: 40)
  -nc, --no-context-files  Skip AGENTS.md discovery
  -c, --continue           Continue the most recent session in this directory
  -r, --resume <id>        Resume a session by id (prefix ok) — see \`imp sessions\`
      --no-session         Do not persist this run (also disables auto-compaction)
  -e, --extension <path>   Load an extension (.mjs file, or a dir with index.mjs; repeatable;
                           explicit -e paths load regardless of the trust gate)
  -ne, --no-extensions     Skip extension discovery — explicit -e paths still load
      --trust              Trust this directory's .imp/ resources, when present, and record it
      --no-trust           Refuse this directory's .imp/ resources, when present, and record it
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

  OpenAI ChatGPT (Codex) subscription plan — OAuth login, then:
    imp login
    imp -m openai-codex/gpt-5.5

  OpenAI and OpenAI-compatible providers (model id prefix routes):
    export OPENAI_API_KEY=<key>
    export IMP_MODEL=openai/gpt-5.2
    # any compatible endpoint (DeepSeek, Kimi, OpenRouter, ...):
    export OPENAI_BASE_URL=https://api.deepseek.com/v1
    export IMP_MODEL=openai/deepseek-chat
    # Z.ai via its OpenAI-mode endpoint:
    export OPENAI_API_KEY=<your z.ai key>
    export OPENAI_BASE_URL=https://api.z.ai/api/paas/v4
    export IMP_MODEL=openai/glm-4.6

Examples:
  imp -p "List the .ts files here and count their total lines"
  imp -p "Read src/cli.ts and fix the bug in argument parsing"
  imp -p "..." -m glm-4.6 --thinking medium

Thinking levels (#thinking-levels): off, minimal, low, medium, high on
models with a thinking knob (claude budget, gpt-5*/o-series effort, GLM
on/off, codex effort). Set with --thinking <level> or IMP_THINKING, in
a session with /think <level> (bare /think or Shift+Tab cycles).
`;
function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		prompt: undefined,
		model: defaultModel(),
		thinking: envThinking() ?? "off",
		maxTokens: 16384,
		maxTurns: 40,
		noContextFiles: false,
		trustDecision: undefined,
		continueRecent: false,
		resume: undefined,
		noSession: false,
		extensionPaths: [],
		noExtensions: false,
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
			case "--thinking": {
				const raw = next();
				if (!(THINKING_LEVELS as readonly string[]).includes(raw)) {
					throw new Error(`Invalid thinking level "${raw}". Valid values: ${THINKING_LEVELS.join(", ")}`);
				}
				opts.thinking = raw as CliOptions["thinking"];
				break;
			}
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
			case "-e":
			case "--extension":
				opts.extensionPaths.push(next());
				break;
			case "-ne":
			case "--no-extensions":
				opts.noExtensions = true;
				break;
			case "--trust":
				opts.trustDecision = "trust";
				break;
			case "--no-trust":
				opts.trustDecision = "no-trust";
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

/** `imp login` — device-code OAuth for the OpenAI (ChatGPT plan) credential. */
async function runLogin(): Promise<void> {
	const controller = new AbortController();
	process.on("SIGINT", () => controller.abort());
	try {
		const credential = await loginCodex({
			signal: controller.signal,
			onDeviceCode: ({ verificationUri, userCode, intervalSeconds }) => {
				process.stdout.write(
					`OpenAI (ChatGPT plan) login\n\n` +
						`  1. open:    ${verificationUri}\n` +
						`  2. enter code: ${bold(userCode)}\n\n` +
						`Waiting for you to confirm (polls every ${intervalSeconds}s, Ctrl+C cancels)…\n`,
				);
			},
		});
		process.stdout.write(
			`Logged in. The credential is stored in ~/.imp/auth.json\n` +
				`Use OpenAI models with:  imp -m openai-codex/gpt-5.5\n`,
		);
	} catch (err) {
		process.stderr.write(red(`imp: ${err instanceof Error ? err.message : String(err)}\n`));
		process.exitCode = 1;
	}
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
	if (argv[0] === "login") {
		await runLogin();
		return;
	}
	if (argv[0] === "logout") {
		logoutCodex();
		process.stdout.write("Logged out of OpenAI (ChatGPT plan).\n");
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
 * Shared startup step for both modes (design §10): load extensions right
 * after the renderer exists and before createRunner, streaming failure
 * lines through renderer.error and then the dim `▪` banner — so extension
 * output always precedes the runner's own banners (incl. `▪ context:`).
 * `confirm` is the interactive handler (REPL only); print mode passes none,
 * so api.confirm there declines with a teaching line instead of hanging.
 */
async function loadExtensionSetup(
	opts: CliOptions,
	renderer: Renderer,
	confirm: ((message: string, detail?: string, options?: ConfirmOptions) => Promise<boolean>) | undefined,
	projectTrusted: boolean,
): Promise<LoadedExtensions> {
	const loaded = await loadExtensions({
		cwd: process.cwd(),
		cliPaths: opts.extensionPaths,
		noDiscovery: opts.noExtensions,
		projectDirAllowed: projectTrusted,
		onDiagnostic: (line) => renderer.error(line),
		confirm,
	});
	printExtensionDiagnostics(loaded.summaries, (line) => renderer.note(line));
	return loaded;
}

/**
 * Interactive/scripted REPL over one shared Runner. Graceful exits resolve a
 * code; the zero-line-pipe guard (forgot -p) resolves 1 and prints HELP here —
 * the REPL itself never imports this module's HELP.
 */
async function runInteractive(opts: CliOptions, argv: string[]): Promise<void> {
	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	// M9: interactive sessions render through the pi-tui shell — the
	// Renderer's bytes feed a TranscriptSink component instead of stdout.
	// IMP_REPL=legacy selects the pre-M9 readline path byte-for-byte.
	const shell = interactive ? resolveShell() : "legacy";
	const transcript = shell === "tui" ? new TranscriptSink() : undefined;
	const renderer = new Renderer({
		write: transcript ? transcript.feed : (text) => process.stdout.write(text),
		userSink: transcript ? (text) => transcript.feedUser(text) : undefined,
		statusSink: transcript ? (text) => transcript.feedStatus(text) : undefined,
		ansi: process.stdout.isTTY === true,
		// In-place pending tool lines only on the legacy readline shell. TUI
		// mode turns them OFF: the live activity region owns pending state
		// (M10 B) — with liveTools=false the Renderer still writes the ✓/⎿
		// completion lines, which is exactly the split we want. Pipes never
		// had them.
		liveTools: interactive && transcript === undefined,
		toolStyle: "one-line",
		markdown: interactive, // streamed markdown-lite; pipes keep verbatim text
		foldedResults: transcript !== undefined, // TUI: ⎿ preview line → expandable fold
	});
	// Extension confirm (interactive only): the host exists before extensions
	// load; runRepl binds it to the live tty prompt once the REPL starts.
	const confirm = interactive ? new TtyConfirm(renderer) : undefined;
	let releaseStartupNotes: (() => void) | undefined;
	// Startup-note deferral (interactive only): every `▪` note emitted before
	// the REPL owns the screen — extension lines, the context banner, trust
	// outcomes — queues here and prints AFTER the welcome panel/banner, so
	// the greeting tops the screen instead of drowning under environment
	// noise. Errors and interactive asks print live (they use other paths);
	// print mode doesn't wrap at all and keeps its byte contract.
	const startupNotes: string[] | null = interactive ? [] : null;
	if (startupNotes !== null) {
		const liveNote = renderer.note.bind(renderer);
		let released = false;
		renderer.note = (text: string): void => {
			if (!released) {
				startupNotes.push(text);
				return;
			}
			liveNote(text);
		};
		releaseStartupNotes = () => {
			released = true;
			for (const line of startupNotes.splice(0)) liveNote(line);
		};
	}
	let runner: Runner;
	let commands: readonly RegisteredExtensionCommand[] = [];
	try {
		const projectTrusted = await resolveProjectTrust(
			opts,
			renderer,
			interactive,
			// One-shot ask shell over the SAME transcript (debt clearance) —
			// only when the session itself will be a TUI.
			shell === "tui" && transcript !== undefined
				? (cwd, resources) => askTrustViaTui({ transcript: transcript, cwd, resources })
				: undefined,
		);
		const extensions = await loadExtensionSetup(opts, renderer, confirm?.handler, projectTrusted);
		// Markdown quick commands (M11 #6) ride the same pipeline as extension
		// commands: /help listing, conflict rules, dispatch. Project tier is
		// behind the same trust gate.
		const md = await loadMdCommands({
			cwd: process.cwd(),
			home: homedir(),
			projectAllowed: projectTrusted,
			reserved: new Set([
				...COMMANDS.map((c) => c.name),
				...extensions.runtime.commands.map((e) => e.command.name), // no silent shadowing (review)
			]),
			onDiagnostic: (line) => renderer.error(line),
		});
		commands = [...extensions.runtime.commands, ...md.commands];
		runner = await createRunner({
			...runnerOptions(opts, argv, renderer),
			deferInit: !interactive,
			agentsProjectAllowed: projectTrusted,
			extensions: extensions.runtime,
			extensionFailures: extensions.failures,
		});
	} catch (err) {
		reportStartupError(err);
		return;
	}
	let code: number;
	try {
		code = await runRepl({
			runner,
			commands,
			confirm,
			releaseStartupNotes,
			shell,
			transcript,
			inputHistoryPath: shell === "tui" ? historyFilePath(homedir()) : undefined,
		});
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
	// NOT process.exit(code): the TUI shell paints the graceful-exit frame
	// ("session … saved") on pending render timers and restores the terminal
	// ~40ms after close() — an immediate exit kills both (M9 review P1).
	// Setting the code and returning lets the loop drain naturally; the
	// force-exit paths (double Ctrl+C) keep their explicit process.exit.
	process.exitCode = code;
}

function runnerOptions(opts: CliOptions, argv: string[], renderer: Renderer): RunnerOptions {
	return {
		cwd: process.cwd(),
		argv,
		model: opts.model,
		thinking: opts.thinking,
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
/** One-question tty prompt for the trust gate (asked before the REPL's
 *  ReplInput exists — a short-lived readline, closed before the session
 *  starts). Non-interactive callers never reach this: they deny instead. */
/** Typed-ahead input between the answer line and the REPL's own readline is
 *  swallowed here (sub-second window, cosmetic loss — M8 review F9). */
function askTrustOnTty(cwd: string, resources: readonly string[]): Promise<boolean | null> {
	const described = describeTrustResources(cwd, resources);
	return askTrustOnce(
		process.stdin,
		process.stdout,
		`trust the files in ${cwd}? it wants to load: ${described} [y/N] `,
	);
}

/** Resolve the M8 project-trust gate before any project resource loads.
 *
 *  Order of authority: explicit --trust/--no-trust flag, then the recorded
 *  nearest-ancestor decision, then (interactive only) a one-time [y/N] ask
 *  that RECORDS the answer. A non-interactive undecided directory is denied
 *  for the session without recording — the teaching line says how to change
 *  it, and a later interactive open still asks. */
async function resolveProjectTrust(
	opts: CliOptions,
	renderer: Renderer,
	interactive: boolean,
	askTui?: (cwd: string, resources: readonly string[]) => Promise<TrustAskAnswer | null>,
): Promise<boolean> {
	const cwd = process.cwd();
	const resources = trustRequiringResources(cwd, homedir()).filter(
		(r) => !(opts.noExtensions && r === ".imp/extensions"), // -ne already refuses that tier
	);
	if (resources.length === 0) return true; // zero friction for plain repos
	const store = defaultTrustStorePath(homedir());
	if (opts.trustDecision === "trust") {
		setTrust(store, cwd, true, true); // rebuildOnCorrupt: the recovery flag must repair
		renderer.note(dim(broadAncestorWarning(store, cwd, true)));
		return true;
	}
	if (opts.trustDecision === "no-trust") {
		setTrust(store, cwd, false, true);
		renderer.note(dim(`▪ trust: recorded “do not trust” for ${cwd}`));
		return false;
	}
	const entry = nearestTrustEntry(readTrustFile(store), cwd);
	if (entry !== null) {
		if (!entry.trusted) {
			renderer.note(
				dim(`▪ trust: ${cwd} is not trusted (recorded at ${entry.path}) — skipping ${resources.join(", ")}`),
			);
		}
		return entry.trusted;
	}
	if (interactive) {
		// The TUI shell asks with a picker (debt clearance); the legacy shell
		// keeps the readline [y/N]. Both map onto the same recording rules.
		const answer: TrustAskAnswer | null | boolean =
			askTui !== undefined ? await askTui(cwd, resources) : await askTrustOnTty(cwd, resources);
		if (answer === null) {
			// cancelled (picker Esc/Ctrl+C, or readline EOF): deny for THIS
			// session only — a dropped terminal must not become a permanent
			// record (M8 review)
			renderer.note(
				dim(`▪ trust: no answer — skipping ${resources.join(", ")} for this session (asked again next open)`),
			);
			return false;
		}
		if (answer === "session") {
			// load now, record nothing — asked again next open
			renderer.note(dim(`▪ trust: project resources loaded for this session only (nothing recorded)`));
			return true;
		}
		const trusted = answer === true || answer === "yes";
		setTrust(store, cwd, trusted);
		if (!trusted) {
			renderer.note(
				dim(
					`▪ trust: recorded “do not trust” for ${cwd} — skipping ${resources.join(", ")} (re-enable with: imp --trust)`,
				),
			);
		}
		return trusted;
	}
	// print mode / pipes: deny without recording, with the teaching line
	process.stderr.write(
		dim(
			`imp: ${resources.join(", ")} found in an untrusted directory — not loaded. ` +
				`Review them, then run: imp --trust\n`,
		),
	);
	return false;
}

/** Recording at (or an ancestor of) the whole home tree is broad; say so
 *  once instead of silently (M8 review F6). */
function broadAncestorWarning(store: string, cwd: string, trusted: boolean): string {
	const home = homedir();
	const note = `▪ trust: recorded ${trusted ? "“trust”" : "“do not trust”"} for ${cwd}`;
	if (canonicalizeDir(cwd) === canonicalizeDir(home) || cwd === "/") {
		return `${note} — this covers every directory beneath it`;
	}
	return note;
}

async function runPrint(opts: CliOptions, argv: string[]): Promise<void> {
	const renderer = new Renderer({
		write: (text) => process.stdout.write(text),
		ansi: process.stdout.isTTY === true,
		liveTools: false,
		toolStyle: "two-line",
	});
	let runner: Runner;
	try {
		const projectTrusted = await resolveProjectTrust(opts, renderer, false);
		const extensions = await loadExtensionSetup(opts, renderer, undefined, projectTrusted);
		runner = await createRunner({
			...runnerOptions(opts, argv, renderer),
			agentsProjectAllowed: projectTrusted,
			extensions: extensions.runtime,
			extensionFailures: extensions.failures,
		});
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
			// Keep the session resumable: close any dangling tool_use before dying.
			runner.persistMissingToolResults("(force quit before this tool ran)");
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
