import path from "node:path";
import {
	compactSession,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	shouldCompact,
} from "./core/compaction.js";
import { loadContextFiles } from "./core/context-files.js";
import { createRunLogger, type RunLogger } from "./core/logger.js";
import type { AgentEvent, RunAgentLoopResult } from "./core/loop.js";
import { runAgentLoop, synthesizeMissingToolResults } from "./core/loop.js";
import type { AgentMessage } from "./core/messages.js";
import { createSession, resolveSession } from "./core/session/manager.js";
import type { SessionStore } from "./core/session/store.js";
import { buildSystemPrompt, defaultSystemPromptContext } from "./core/system-prompt.js";
import { createBashTool } from "./core/tools/bash.js";
import { createEditTool } from "./core/tools/edit.js";
import { createFindTool } from "./core/tools/find.js";
import { createGrepTool } from "./core/tools/grep.js";
import { createReadTool } from "./core/tools/read.js";
import type { Tool } from "./core/tools/types.js";
import { createWriteTool } from "./core/tools/write.js";
import type { ExtensionRegistry } from "./extensions/registry.js";
import type { ExtensionFailure } from "./extensions/types.js";
import { formatTokens } from "./format.js";
import { createAnthropicProvider } from "./provider/anthropic.js";
import { withLogging } from "./provider/logging.js";
import type { LLMProvider } from "./provider/types.js";
import type { Renderer } from "./repl/render.js";

export type RunMode = "print" | "repl";

/**
 * Print mode keeps today's behavior (a -p/positional prompt was given). Without
 * a prompt, imp runs the REPL — piped stdin included (scripted mode), because
 * the readline REPL degrades naturally. Only a zero-line stdin degenerates to
 * HELP + exit 1 (detected by the REPL when EOF arrives before any line).
 * `stdinIsTty` is part of the dispatch question on purpose: a pipe is a
 * feature, not a demotion.
 */
export function resolveRunMode(args: { promptDefined: boolean; stdinIsTty: boolean }): RunMode {
	return args.promptDefined ? "print" : "repl";
}

export interface RunnerOptions {
	cwd: string;
	argv: string[]; // for the run logger
	model: string;
	maxTokens: number;
	maxTurns: number;
	noContextFiles: boolean;
	noSession: boolean;
	resume?: string;
	continueRecent?: boolean;
	sessionBaseDir?: string; // hermetic tests (passed through to the session manager)
	/** Defer session creation and startup banners until the first warmup()
	 *  call. Scripted (piped) mode uses this so a zero-line pipe — the "forgot
	 *  -p" case — exits with HELP and no side effects (no banners, no empty
	 *  session file). Interactive/print modes init eagerly as before. */
	deferInit?: boolean;
	renderer: Renderer; // ALL status output flows through this
	/** Test seam: scripted provider instead of the real Anthropic one. */
	provider?: LLMProvider;
	/** Test seam: tool set (defaults to the fixed six tools). */
	tools?: Tool[];
	/** Extension runtime: its tools append after the base set (M4a); commands
	 *  dispatch from the REPL (M4b, via ReplOptions.commands); context and
	 *  event emission are stored and wire up in M4c. */
	extensions?: ExtensionRegistry;
	/** Extension load failures — logged once the run logger exists (run_error,
	 *  source "extension"), so one line on screen stays debuggable on disk. */
	extensionFailures?: readonly ExtensionFailure[];
}

export interface RunTurnOptions {
	userMessage?: string; // omit ⇒ continue existing history (not used by 3a UI)
	signal?: AbortSignal;
	onEvent?: (event: AgentEvent) => void;
	/** Steering: queued user input injected at turn boundaries. */
	getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
}

export type CompactOutcome = "compacted" | "nothing-to-compact" | "no-session";

export interface Runner {
	readonly session: SessionStore | null;
	/** The live conversation array — the REPL holds this across turns. Identity is stable. */
	readonly history: AgentMessage[];
	/** Per-run model. Mutable: `/model` writes it; runTurn/compaction read it at call time. */
	model: string;
	/** The renderer all status output flows through (shared with the REPL). */
	readonly renderer: Renderer;
	runTurn(options: RunTurnOptions): Promise<RunAgentLoopResult>;
	/** Manual compaction for /compact (same code path as the auto hook, minus the gate). */
	compactNow(signal?: AbortSignal): Promise<CompactOutcome>;
	/** `/new`: fresh session store, empty history, re-assembled system prompt. */
	newSession(): void;
	printRunStats(result: RunAgentLoopResult): void;
	printSessionStats(): void;
	/** Idempotent one-time init (session wiring + banners + system prompt).
	 *  Eager unless deferInit was set; the scripted REPL calls it on the first
	 *  accepted line. */
	warmup(): void;
	/** Before a force quit: close dangling tool_use in the persisted session so
	 *  it stays resumable. Returns the number of synthesized results. */
	persistMissingToolResults(reason: string): number;
	close(): void; // logger.close()
}

/**
 * Everything print mode and the REPL share: env setup, session wiring,
 * system-prompt assembly, the agent loop with persistence and auto-compaction,
 * and the stats printers. `createRunner` does everything up to (but not
 * including) the first LLM call.
 */
export async function createRunner(options: RunnerOptions): Promise<Runner> {
	const logger = await createRunLogger({ cwd: options.cwd, argv: options.argv });
	for (const failure of options.extensionFailures ?? []) {
		// Already shown on screen by cli.ts at load time; this persists the full
		// error (design §7.3: one line on screen, debuggable on disk).
		logger.log("run_error", {
			source: "extension",
			path: failure.path,
			message: failure.detail,
		});
	}
	const provider = withLogging(options.provider ?? createAnthropicProvider(), logger);
	return new RunnerImpl(options, logger, provider);
}

class RunnerImpl implements Runner {
	readonly history: AgentMessage[] = [];
	model: string;
	private readonly options: RunnerOptions;
	private readonly logger: RunLogger;
	private readonly provider: LLMProvider; // wrapped with logging once, reused everywhere
	private readonly tools: Tool[];
	private readonly autoCompact: boolean;
	private readonly settings = DEFAULT_COMPACTION_SETTINGS;
	private system: string;
	private sessionStore: SessionStore | null = null;
	private initialized = false;
	private lastRunModel: string;

	constructor(options: RunnerOptions, logger: RunLogger, provider: LLMProvider) {
		this.options = options;
		this.logger = logger;
		this.provider = provider;
		this.model = options.model;
		this.lastRunModel = options.model;
		// The "test seam" tools option generalizes (design §8.1): explicit tools
		// keep their hermetic set, extension tools append after the base six.
		this.tools = [
			...(options.tools ?? [
				createBashTool(),
				createReadTool(),
				createEditTool(),
				createWriteTool(),
				createGrepTool(),
				createFindTool(),
			]),
			...(options.extensions?.tools ?? []),
		];
		this.autoCompact = process.env.IMP_AUTOCOMPACT !== "0";
		this.system = "";
		if (!options.deferInit) this.warmup();
	}

	warmup(): void {
		if (this.initialized) return;
		this.initialized = true;
		const options = this.options;
		if (!options.noSession) {
			if (options.resume !== undefined || options.continueRecent === true) {
				const resumed = resolveSession(options.cwd, {
					resume: options.resume,
					continueRecent: options.continueRecent,
					baseDir: options.sessionBaseDir,
				});
				if (resumed) {
					this.sessionStore = resumed;
					const loaded = resumed.buildContext();
					this.history.push(...loaded.messages);
					const stats = resumed.stats();
					const est = estimateContextTokens(this.history);
					options.renderer.note(
						`▪ resumed ${resumed.header.id.slice(0, 8)} · ${stats.messageCount} msgs · ~${formatTokens(est.tokens)} tokens${loaded.compacted ? " (compacted)" : ""}`,
					);
				} else {
					options.renderer.note("▪ no previous session, starting fresh");
				}
			}
			this.sessionStore ??= createSession(options.cwd, options.sessionBaseDir);
		}
		this.system = this.assembleSystem();
	}

	get session(): SessionStore | null {
		return this.sessionStore;
	}

	get renderer(): Renderer {
		return this.options.renderer;
	}

	private assembleSystem(): string {
		let system = buildSystemPrompt(defaultSystemPromptContext());
		if (!this.options.noContextFiles) {
			const context = loadContextFiles(this.options.cwd);
			if (context) {
				system += `\n\n# Project context (AGENTS.md)\n\n${context.text}`;
				const display = context.files.map((f) => path.relative(this.options.cwd, f) || f).join(", ");
				this.options.renderer.note(`▪ context: ${display}`);
			}
		}
		return system;
	}

	newSession(): void {
		const previous = this.sessionStore;
		if (previous) {
			this.sessionStore = createSession(this.options.cwd, this.options.sessionBaseDir);
			const id8 = this.sessionStore.header.id.slice(0, 8);
			const old8 = previous.header.id.slice(0, 8);
			this.options.renderer.note(`▪ new session ${id8} — previous ${old8} saved (imp -r ${old8})`);
		} else {
			this.options.renderer.note("▪ new conversation (sessions disabled)");
		}
		this.history.length = 0;
		this.system = this.assembleSystem();
	}

	runTurn(options: RunTurnOptions): Promise<RunAgentLoopResult> {
		const model = this.model; // captured at call entry: /model mid-run affects only later turns
		this.lastRunModel = model;
		const session = this.sessionStore;
		return this.runTurnInner(model, session, options);
	}

	private async runTurnInner(
		model: string,
		session: SessionStore | null,
		options: RunTurnOptions,
	): Promise<RunAgentLoopResult> {
		try {
			return await runAgentLoop({
				provider: this.provider,
				model,
				system: this.system,
				tools: this.tools,
				history: this.history,
				userMessage: options.userMessage,
				maxTokens: this.options.maxTokens,
				maxIterations: this.options.maxTurns,
				onMessage: (message) => this.sessionStore?.appendMessage(message),
				onBeforeTurn: session
					? async (history) => {
							if (!this.autoCompact) return;
							const est = estimateContextTokens(history);
							if (!shouldCompact(est.tokens, this.settings)) return;
							this.options.renderer.note(`▪ context ~${formatTokens(est.tokens)} tokens — compacting…`);
							await this.compactAndSplice(model);
						}
					: undefined,
				getSteeringMessages: options.getSteeringMessages,
				onEvent: options.onEvent,
				signal: options.signal,
			});
		} catch (err) {
			this.logger.log("run_error", { message: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	}

	async compactNow(_signal?: AbortSignal): Promise<CompactOutcome> {
		// The signal is deliberately NOT forwarded: aborting mid-summary would
		// persist a truncated checkpoint (design §7.4). Ctrl+C twice force-exits.
		if (!this.sessionStore) return "no-session";
		return (await this.compactAndSplice(this.model)) ? "compacted" : "nothing-to-compact";
	}

	private async compactAndSplice(model: string): Promise<boolean> {
		const session = this.sessionStore;
		if (!session) return false;
		const compacted = await compactSession({
			session,
			provider: this.provider,
			model,
			settings: this.settings,
		});
		if (compacted) {
			this.history.splice(0, this.history.length, ...session.buildContext().messages);
			this.options.renderer.note(
				`▪ compacted: ~${formatTokens(compacted.tokensBefore)} → ~${formatTokens(compacted.tokensAfter)} tokens (${compacted.retainedCount} msgs kept verbatim)`,
			);
		} else {
			// Estimate said full, but the retained-tail window already covers everything.
			this.options.renderer.note("▪ nothing safe to compact yet — continuing");
		}
		return compacted !== null;
	}

	printRunStats(result: RunAgentLoopResult): void {
		switch (result.stopReason) {
			case "aborted":
				this.options.renderer.note("(aborted)");
				break;
			case "max_iterations":
				this.options.renderer.error(`(stopped: reached max turns (${this.options.maxTurns}))`);
				break;
			case "completed":
				break;
		}
		const cacheNote = result.usage.cacheReadTokens
			? ` · cache↓${formatTokens(result.usage.cacheReadTokens)}`
			: "";
		this.options.renderer.note(
			`— ${this.lastRunModel} · ${result.turns} turns · in ${formatTokens(result.usage.inputTokens)} / out ${formatTokens(result.usage.outputTokens)} tokens${cacheNote}`,
		);
		this.logger.log("run_end", { stopReason: result.stopReason, turns: result.turns, usage: result.usage });
	}

	printSessionStats(): void {
		const session = this.sessionStore;
		if (!session) return;
		const stats = session.stats();
		this.options.renderer.note(
			`— session ${session.header.id.slice(0, 8)} · ${stats.messageCount} msgs total · in ${formatTokens(stats.inputTokens)} / out ${formatTokens(stats.outputTokens)} cumulative`,
		);
	}

	persistMissingToolResults(reason: string): number {
		if (this.sessionStore === null) return 0;
		// The persisted branch mirrors the live history (onMessage appends every
		// message); synthesize against it and append the closers. Store appends
		// are synchronous, so this is safe inside a SIGINT force-exit path.
		const messages = this.sessionStore.buildContext().messages;
		const extra = synthesizeMissingToolResults(messages, reason);
		let count = 0;
		for (const message of extra) {
			this.sessionStore.appendMessage(message);
			if (message.role === "toolResult") count += message.results.length;
		}
		return count;
	}

	close(): void {
		this.logger.close();
	}
}
