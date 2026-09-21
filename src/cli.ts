import { homedir } from "node:os";
import { loadMdCommands } from "./core/commands-md.js";
import { processFileArguments } from "./core/file-processor.js";
import type { ImageBlock } from "./core/messages.js";
import { listSessions } from "./core/session/manager.js";
import { effectiveSettings, loadProjectSettings, loadSettings } from "./core/settings.js";
import { buildSkillCommands, loadSkills, type Skill } from "./core/skills.js";
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
import { discoverMcpConfig } from "./mcp/config.js";
import { McpManager } from "./mcp/manager.js";
import { loadCatalogCache, refreshCatalog } from "./provider/catalog.js";
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
// M15 precedence: IMP_MODEL > global settings defaultModel > project settings
// defaultModel (ONLY when the trust store already says trusted — parse time
// precedes the interactive trust resolution, and "unknown" must be the
// conservative skip) > builtin.
const defaultModel = (argv: string[] = []): string => {
	const env = process.env.IMP_MODEL;
	if (env !== undefined) return env;
	// --no-trust refuses this directory's .imp/ resources (review P1-3): the
	// project settings file must not seed the model the flag just refused —
	// the parse-time default runs before trustDecision is known, so the flag
	// is pre-scanned from raw argv.
	if (argv.includes("--no-trust")) return loadSettings().defaultModel ?? "claude-sonnet-4-5";
	// project WINS over global (pi's scope semantics — the design table's
	// "env > project > global > default"; smoke caught the inverted order)
	const projectDefault = projectDefaultModelIfTrusted();
	if (projectDefault !== undefined) return projectDefault;
	const globalDefault = loadSettings().defaultModel;
	if (globalDefault !== undefined) return globalDefault;
	return "claude-sonnet-4-5";
};

function projectDefaultModelIfTrusted(): string | undefined {
	try {
		const home = homedir();
		const data = readTrustFile(defaultTrustStorePath(home));
		if (nearestTrustEntry(data, process.cwd())?.trusted !== true) return undefined;
		return loadProjectSettings(process.cwd(), true).defaultModel;
	} catch {
		return undefined; // corrupt store → treat as unknown → skip (conservative)
	}
}

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
	/** M13 batch 2: `@path` positionals → file attachments (print mode). */
	fileArgs: string[];
	model: string;
	/** --thinking <level> / IMP_THINKING (#thinking-levels, pi parity).
	 *  UNDEFINED when neither is set — the runner then applies the settings
	 *  default, then pi's "medium" (a defined "off" sentinel here would make
	 *  those unreachable; pi's main.ts:422 likewise only sets on --thinking). */
	thinking: import("./provider/thinking.js").ThinkingLevel | undefined;
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
	/** M12: explicit --skill paths (repeatable) — always honored. */
	skillPaths: string[];
	/** M12: skip default skill locations (user + project + settings array). */
	noSkills: boolean;
	help: boolean;
	version: boolean;
}

const HELP = `imp ${VERSION} — a small coding agent

Usage:
  imp -p "<prompt>"        Run a task in print mode (streams the response, then exits)
  imp "<prompt>"           Same as -p
  imp @file.png "prompt"   Attach files to the prompt: text files embed as
                           <file> blocks, images attach to the first message
  imp                     Start an interactive session (REPL)
  imp sessions             List saved sessions for this directory
  imp login                Log in to OpenAI (ChatGPT plan) — device-code OAuth
  imp logout               Remove the stored OpenAI (ChatGPT plan) credential;
                           keys saved by /login stay

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
      --skill <path>       Load a skill (.md file, or a skill directory / directory
                           tree; repeatable; explicit --skill paths load regardless of --no-skills)
      --no-skills          Skip skill discovery (user + project + settings) — explicit
                           --skill paths still load
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

  Z.ai GLM Coding Plan example (the official GLM path, pi parity):
    export ZAI_API_KEY=<your z.ai key>
    export IMP_MODEL=zai/glm-5.3
  (A bare glm-* id routes there unconditionally; without a credential imp
  prints a sign-in pointer — /login zai — instead of silently connecting
  elsewhere. anthropic/glm-* forces the compat endpoint explicitly.)

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
		fileArgs: [],
		model: defaultModel(argv),
		thinking: envThinking(),
		maxTokens: 16384,
		maxTurns: 40,
		noContextFiles: false,
		trustDecision: undefined,
		continueRecent: false,
		resume: undefined,
		noSession: false,
		extensionPaths: [],
		noExtensions: false,
		skillPaths: [],
		noSkills: false,
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
			case "--skill":
				opts.skillPaths.push(next());
				break;
			case "--no-skills":
				opts.noSkills = true;
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
	// M13 batch 2: @path positionals peel off BEFORE prompt assembly (pi
	// args.ts) — `imp @shot.png what is this` attaches the image and keeps
	// the question as the prompt. A bare `@file` with no message is still a
	// defined prompt (promptDefined).
	const rest: string[] = [];
	for (const arg of positional) {
		// The @ stays: processFileArguments owns the strip (single slice).
		if (arg.startsWith("@") && arg.length > 1) opts.fileArgs.push(arg);
		else rest.push(arg);
	}
	if (opts.prompt === undefined && rest.length > 0) {
		opts.prompt = rest.join(" ");
	}
	if (opts.fileArgs.length > 0 && opts.prompt === undefined) opts.prompt = "";
	return opts;
}

/** `imp login` — device-code OAuth for the OpenAI (ChatGPT plan) credential. */
async function runLogin(): Promise<void> {
	const controller = new AbortController();
	process.on("SIGINT", () => controller.abort());
	try {
		await loginCodex({
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
	// M14 (#model-catalog): the pi.dev disk cache loads BEFORE any model
	// resolution (the Runner constructor reads contextWindowFor) and after
	// .env (IMP_CATALOG_BASE_URL/IMP_CATALOG_PATH may live there). Quick-exit
	// paths below never touch the network; the stale-cache refresh kick lives
	// in the run modes.
	loadCatalogCache();
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
		promptDefined: opts.prompt !== undefined || opts.fileArgs.length > 0,
		stdinIsTty: process.stdin.isTTY === true,
	});
	// M14: the stale-cache refresh kicks once the run mode is known and is
	// ABORTED when the run ends (review P1-1) — a blackholed catalog endpoint
	// must not hold the process open after its output is done (measured 16.8s
	// without this: 4 sequential family timeouts kept the loop alive).
	const catalogAbort = new AbortController();
	void refreshCatalog({ signal: catalogAbort.signal }).catch(() => undefined);
	try {
		if (mode === "print") {
			await runPrint(opts, argv);
			return;
		}
		await runInteractive(opts, argv);
	} finally {
		catalogAbort.abort();
	}
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
	// M14: the staleness kick lives in main() (after mode resolution, aborted
	// when the run ends); /model open re-checks the window non-blocking.
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
		hideThinking: loadSettings().hideThinkingBlock ?? false, // pi's getHideThinkingBlock
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
		const skills = loadSkillSetup(opts, renderer, projectTrusted);
		// M15 (review P1-2): hideThinking reads the MERGED view once the
		// trust resolution exists — the renderer was built before the ask
		// (the ask itself renders through it), but the field is public and
		// ctrl+t already flips it live.
		const mergedHide = effectiveSettings({
			cwd: process.cwd(),
			projectAllowed: projectTrusted,
		}).hideThinkingBlock;
		if (mergedHide !== undefined) renderer.hideThinking = mergedHide;
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
		const all = [...extensions.runtime.commands, ...md.commands];
		// Skill commands register LAST (§11.1: builtins → extensions → md →
		// skills) — the skill: prefix makes collisions impossible by
		// construction; a literal clash yields to the earlier command with a
		// warning. Interactive only: print mode never dispatches commands.
		commands = [
			...all,
			...buildSkillCommands(skills.skills, {
				enabled: skills.enableSkillCommands,
				reserved: new Set(all.map((c) => c.command.name)),
				onDiagnostic: (line) => renderer.error(line),
			}),
		];
		runner = await createRunner({
			projectSettingsAllowed: projectTrusted,
			...runnerOptions(opts, argv, renderer),
			deferInit: !interactive,
			agentsProjectAllowed: projectTrusted,
			extensions: extensions.runtime,
			extensionFailures: extensions.failures,
			skills: skills.skills,
		});
	} catch (err) {
		reportStartupError(err);
		return;
	}
	// M18 MCP: manager creation lives here (not in the runner) — the runner
	// stays tool-agnostic; the manager splices into the live tools array and
	// the REPL drives its run boundaries. Skipped entirely when the settings
	// gate is off (D4) — no discovery, no spawns, /mcp reports the gate.
	const mcp = createMcpSetup(renderer, runner);
	let code: number;
	try {
		code = await runRepl({
			runner,
			commands,
			confirm,
			releaseStartupNotes,
			mcp,
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

/** M18 MCP setup (interactive + print): discovery, gate, manager, and the
 *  initial fire-and-forget connections. Returns undefined when disabled or
 *  unconfigured — callers treat that as "module inert" (D4).
 *  IMP_MCP=0 is the env escape hatch (mirrors IMP_AUTOCOMPACT) for CI and
 *  quick diagnostics. */
function createMcpSetup(renderer: Renderer, runner: Runner): McpManager | undefined {
	if (process.env.IMP_MCP === "0") return undefined;
	const settings = runner.effectiveSettings();
	if (settings.mcp?.enabled === false) return undefined;
	const discovered = discoverMcpConfig({ cwd: process.cwd() });
	for (const note of discovered.notes) renderer.note(note);
	if (discovered.servers.length === 0) return undefined;
	const manager = new McpManager({
		servers: discovered.servers,
		cwd: process.cwd(),
		version: VERSION,
		renderer,
	});
	manager.attachToolsArray(runner.tools);
	manager.connectAll();
	return manager;
}

/** M12 skills — loaded right after the trust gate resolves, mirroring the
 *  extension/md-command pipeline: diagnostics as teaching lines, one `▪`
 *  note when any loaded (queued behind the banner in interactive mode by the
 *  startup-note wrapper). Settings entries sit under --no-skills like the
 *  default locations; --skill paths outrank everything (explicit intent). */
/** Batch-1 loading + the batch-2 registration switch (enableSkillCommands). */
function loadSkillSetup(
	opts: CliOptions,
	renderer: Renderer,
	projectTrusted: boolean,
): {
	skills: Skill[];
	enableSkillCommands: boolean;
} {
	// M15 (review P2-1): skills read the MERGED view — a trusted project's
	// settings.skills participates like every other key.
	const settings = effectiveSettings({ cwd: process.cwd(), projectAllowed: projectTrusted });
	const settingsEntries = opts.noSkills ? [] : (settings.skills ?? []);
	const result = loadSkills({
		cwd: process.cwd(),
		home: homedir(),
		projectTrusted,
		noSkills: opts.noSkills,
		explicitPaths: [...opts.skillPaths, ...settingsEntries],
	});
	const max = 5;
	for (const diagnostic of result.diagnostics.slice(0, max)) {
		renderer.error(`imp: ${diagnostic.message}`);
	}
	if (result.diagnostics.length > max) {
		renderer.error(`imp: … +${result.diagnostics.length - max} more skill warnings`);
	}
	if (result.skills.length > 0) renderer.note(`▪ skills: ${result.skills.length} loaded`);
	return { skills: result.skills, enableSkillCommands: settings.enableSkillCommands !== false };
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
		(r) =>
			!(opts.noExtensions && r === ".imp/extensions") && // -ne already refuses that tier
			// --no-skills likewise (review A8: "." is the degenerate ancestor entry
			// when cwd itself sits inside a .agents/skills chain)
			!(opts.noSkills && (r === ".imp/skills" || r.endsWith(".agents/skills") || r === ".")),
	);
	if (resources.length === 0) return true; // zero friction for plain repos
	const store = defaultTrustStorePath(homedir());
	if (opts.trustDecision === "trust") {
		setTrust(store, cwd, true, true); // rebuildOnCorrupt: the recovery flag must repair
		renderer.note(dim(broadAncestorWarning(cwd, true)));
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
function broadAncestorWarning(cwd: string, trusted: boolean): string {
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
		const skills = loadSkillSetup(opts, renderer, projectTrusted);
		runner = await createRunner({
			projectSettingsAllowed: projectTrusted,
			...runnerOptions(opts, argv, renderer),
			agentsProjectAllowed: projectTrusted,
			extensions: extensions.runtime,
			extensionFailures: extensions.failures,
			skills: skills.skills, // commands stay interactive-only (§11.1)
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

	let attachImages: ImageBlock[] | undefined;
	if (opts.fileArgs.length > 0) {
		const processed = await processFileArguments(opts.fileArgs);
		if (processed.text !== "") {
			opts.prompt =
				opts.prompt === undefined || opts.prompt === ""
					? processed.text.trimEnd()
					: `${processed.text}${opts.prompt}`;
		}
		attachImages = processed.images.length > 0 ? processed.images : undefined;
		// All files empty and no typed prompt: nothing to send — a provider
		// request with an empty message list is a guaranteed 400 (review
		// cosmetic).
		if ((opts.prompt === "" || opts.prompt === undefined) && attachImages === undefined) {
			opts.prompt = undefined;
		}
	}

	try {
		// M18: print mode gets MCP too — one fire-and-forget connectAll before
		// the single run. onRunStart parks handshakes that finish mid-run (a
		// one-shot has no second run to flush them into — parking beats leaking
		// an unexecutable tool into the wire request, review P2-3); close lives
		// in finally so a failed run still kills the children (review P1-2).
		const mcp = createMcpSetup(renderer, runner);
		try {
			mcp?.onRunStart();
			const result = await runner.runTurn({
				userMessage: opts.prompt,
				userImages: attachImages,
				signal: controller.signal,
				onEvent: (event) => renderer.event(event),
			});
			mcp?.onRunEnd();
			renderer.endRun(true);
			runner.printRunStats(result);
			runner.printSessionStats();
		} finally {
			mcp?.close();
		}
	} catch (err) {
		renderer.endRun(true);
		reportStartupError(err);
	} finally {
		process.off("SIGINT", onSigint);
		runner.close();
	}
}

await main();
