import path from "node:path";
import { type AgentRegistry, loadAgentDefinitions } from "./core/agents/registry.js";
import {
	compactSession,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	shouldCompact,
	summarizeBranchSegment,
} from "./core/compaction.js";
import { loadContextFiles } from "./core/context-files.js";
import { createRunLogger, type RunLogger } from "./core/logger.js";
import type { AgentEvent, RunAgentLoopResult } from "./core/loop.js";
import { runAgentLoop, synthesizeMissingToolResults } from "./core/loop.js";
import type { AgentMessage } from "./core/messages.js";
import type { SessionInfo } from "./core/session/manager.js";
import { createSession, listSessions, resolveSession, SessionNotFoundError } from "./core/session/manager.js";
import type { MessageEntry, SessionStore } from "./core/session/store.js";
import { buildSystemPrompt, defaultSystemPromptContext } from "./core/system-prompt.js";
import { createBashTool } from "./core/tools/bash.js";
import { createEditTool } from "./core/tools/edit.js";
import { createFindTool } from "./core/tools/find.js";
import { createGrepTool } from "./core/tools/grep.js";
import { createReadTool } from "./core/tools/read.js";
import { createTaskTool } from "./core/tools/task.js";
import type { Tool } from "./core/tools/types.js";
import { createWriteTool } from "./core/tools/write.js";
import type { ExtensionRegistry } from "./extensions/registry.js";
import type { ExtensionFailure } from "./extensions/types.js";
import { formatTokens, shorten } from "./format.js";
import { withLogging } from "./provider/logging.js";
import { contextWindowFor } from "./provider/models.js";
import { createProviderFor, type ProviderName, parseModelRef, resolveModel } from "./provider/resolve.js";
import type { LLMProvider } from "./provider/types.js";
import type { Renderer } from "./render.js";

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
	/** Hermetic tests: overrides ~/.imp/agents for the agent registry (M5c). */
	agentsHomeDir?: string;
	/** M8 trust gate: false skips `<cwd>/.imp/agents` (global agents still load). */
	agentsProjectAllowed?: boolean;
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
	 *  dispatch from the REPL (M4b, via ReplOptions.commands); context sections
	 *  inject into the system prompt and loop/turn events emit (M4c). */
	extensions?: ExtensionRegistry;
	/** Extension load failures — logged once the run logger exists (run_error,
	 *  source "extension"), so one line on screen stays debuggable on disk. */
	extensionFailures?: readonly ExtensionFailure[];
}

export interface RunTurnOptions {
	userMessage?: string; // omit ⇒ continue existing history (not used by 3a UI)
	signal?: AbortSignal;
	/** Turn event tap. `info` is set ONLY for subagent-sourced events (the
	 *  task tool relays its child loop's events with the child's agent name
	 *  and cwd) — top-level events carry undefined and must stay the only
	 *  ones fed to the Renderer (M5's zero-rendering-visibility rule). */
	onEvent?: (event: AgentEvent, info?: AgentEventInfo) => void;
	/** Steering: queued user input injected at turn boundaries. */
	getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
}

/** Discriminator for subagent-sourced events on RunTurnOptions.onEvent. */
export interface AgentEventInfo {
	agent?: string;
	cwd?: string;
}

export type CompactOutcome = "compacted" | "nothing-to-compact" | "no-session";

export interface Runner {
	readonly session: SessionStore | null;
	/** The live conversation array — the REPL holds this across turns. Identity is stable. */
	readonly history: AgentMessage[];
	/** Per-run model. Mutable: `/model` writes it; runTurn/compaction read it at call time. */
	model: string;
	/** Runtime model switch (#multi-provider batch 2): re-resolves the provider
	 *  from the canonical reference so /model can cross protocols mid-session,
	 *  and recomputes the compaction window to match the new model. */
	setModel(reference: string): void;
	/** Effective context window for the CURRENT model (registry-backed). */
	readonly contextWindow: number;
	/** The renderer all status output flows through (shared with the REPL). */
	readonly renderer: Renderer;
	runTurn(options: RunTurnOptions): Promise<RunAgentLoopResult>;
	/** Manual compaction for /compact (same code path as the auto hook, minus the gate). */
	compactNow(signal?: AbortSignal): Promise<CompactOutcome>;
	/** `/new`: fresh session store, empty history, re-assembled system prompt. */
	newSession(): void;
	/** `/sessions`: sessions saved for this cwd, newest first. */
	listSessions(): SessionInfo[];
	/** `/resume <id>`: swap the live session to a saved one (history reloads;
	 *  the old session stays on disk untouched). Throws SessionNotFoundError. */
	resumeSession(id: string): { id8: string; messages: number };
	/** `/fork` candidates: user messages on the current branch with
	 *  previews (#10 batch 1). Empty when sessions are disabled. */
	forkPoints(): { id: string; preview: string }[];
	/** Branch before a user message: the store's leaf moves, history
	 *  reloads from the new path (same wiring as resumeSession). */
	forkSessionAt(entryId: string): { retained: number; abandoned: number; preview: string };
	/** `/tree` candidates: other branch tips with previews and message
	 *  counts (#10 batch 2). */
	branchTips(): { id: string; label: string; count: number }[];
	/** Switch to another branch tip — summarizing the left branch into the
	 *  new one's context unless IMP_BRANCH_SUMMARY=0 (#10 batch 2).
	 *  `summary` reports why the context did or did not gain a frame. */
	switchSessionBranch(tipId: string): Promise<{
		summary: "written" | "empty" | "disabled" | "failed";
		messages: number;
	}>;
	printRunStats(result: RunAgentLoopResult): void;
	printSessionStats(): void;
	/** Idempotent one-time init (session wiring + banners + system prompt).
	 *  Eager unless deferInit was set; the scripted REPL calls it on the first
	 *  accepted line. */
	warmup(): void;
	/** Before a force quit: close dangling tool_use in the persisted session so
	 *  it stays resumable. Returns the number of synthesized results. */
	persistMissingToolResults(reason: string): number;
	/** Look up a tool in this runner's tool set by name (the REPL's !
	 *  passthrough executes the bash tool directly; tests reach their
	 *  createRunner-injected fakes through here). */
	getTool(name: string): Tool | undefined;
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
	// #multi-provider: a bare model id keeps the anthropic default (byte-identical
	// for every existing config); "openai/<id>" routes to the Chat Completions
	// protocol. Runtime /model switching across providers arrives with the
	// registry batch; construction-time resolution covers subagents too.
	const resolved = resolveModel(options.model);
	const provider = withLogging(options.provider ?? resolved.provider, logger);
	const initialModel = resolved.modelId;
	return new RunnerImpl(options, logger, provider, initialModel, parseModelRef(options.model).provider);
}

class RunnerImpl implements Runner {
	readonly history: AgentMessage[] = [];
	model: string;
	private readonly options: RunnerOptions;
	private readonly logger: RunLogger;
	private provider: LLMProvider; // wrapped with logging once; /model may swap it (multi-provider)
	private providerName: ProviderName;
	private readonly tools: Tool[];
	private readonly autoCompact: boolean;
	private readonly branchSummaryEnabled: boolean;
	private settings = DEFAULT_COMPACTION_SETTINGS; // contextWindow follows the model (multi-provider)
	private system: string;
	private sessionStore: SessionStore | null = null;
	private readonly agents: AgentRegistry;
	private initialized = false;
	private lastRunModel: string;

	constructor(
		options: RunnerOptions,
		logger: RunLogger,
		provider: LLMProvider,
		initialModel: string,
		providerName: ProviderName,
	) {
		this.options = options;
		this.logger = logger;
		this.provider = provider;
		this.providerName = options.provider !== undefined ? "anthropic" : providerName;
		this.model = initialModel;
		this.lastRunModel = initialModel;
		// The "test seam" tools option generalizes (design §8.1): explicit tools
		// keep their hermetic set, extension tools append after the base six. The
		// default six run under options.cwd — never process.cwd() — so the
		// runner's cwd is the one contract everywhere (and hermetic cwds stay hermetic).
		this.tools = [
			...(options.tools ?? [
				createBashTool({ cwd: options.cwd }),
				createReadTool({ cwd: options.cwd }),
				createEditTool({ cwd: options.cwd }),
				createWriteTool({ cwd: options.cwd }),
				createGrepTool({ cwd: options.cwd }),
				createFindTool({ cwd: options.cwd }),
			]),
			...(options.extensions?.tools ?? []),
		];
		// The task tool (M5): delegates to in-process subagents. Getters keep the
		// spawn-time reads live — /model, /new, /resume all change what children
		// should see. It references this.tools (name-filtered at spawn), so push
		// after the array is built. Agents load once from disk (M5c) — new agent
		// files need a restart, like extension changes.
		this.agents = loadAgentDefinitions(options.cwd, options.agentsHomeDir, options.agentsProjectAllowed);
		this.tools.push(
			createTaskTool({
				provider: this.provider,
				getModel: () => this.model,
				getSystem: () => this.system,
				getTools: () => this.tools,
				getSession: () => this.sessionStore,
				sessionBaseDir: options.sessionBaseDir,
				agents: this.agents.agents,
				agentsProjectGated: this.agents.projectGated,
				cwd: options.cwd,
				// Worktree children (M6b): builtins rebuilt at the worktree
				// path. Extension tools are excluded by construction here —
				// their api.cwd cannot move (design D5), and a pool split
				// across two trees would fail silently.
				getToolsForCwd: (cwd) => [
					createBashTool({ cwd }),
					createReadTool({ cwd }),
					createEditTool({ cwd }),
					createWriteTool({ cwd }),
					createGrepTool({ cwd }),
					createFindTool({ cwd }),
				],
				// Same registry gate as the main loop, but events are marked
				// subagent-sourced so "tool_call" handlers can tell children
				// apart (M6a — closes the M5 design Q3 gap). cwd is the child's
				// own working directory — the worktree path under isolation (M6b).
				onToolCall: (call, info) =>
					this.options.extensions?.emitToolCall({
						type: "tool_call",
						...call,
						subagent: true,
						agent: info.agent,
						cwd: info.cwd,
					}),
				// Child tool_end feeds extension observers (audit trails) with
				// the same discriminator. M10: child events ALSO flow to the live
				// turn's onEvent tap (this.turnEventTap) with their info — the REPL
				// machine routes them to the TUI activity region and keeps the
				// Renderer on top-level events only (M5's rule, enforced at the tap).
				onEvent: (event, info) => {
					this.turnEventTap?.(event, info);
					if (event.type !== "tool_end") return;
					const { result } = event;
					this.options.extensions?.emitToolEnd({
						type: "tool_end",
						toolCallId: result.toolCallId,
						name: result.toolName,
						output: result.content,
						isError: result.isError,
						subagent: true,
						agent: info.agent,
						cwd: info.cwd,
					});
				},
			}),
		);
		this.autoCompact = process.env.IMP_AUTOCOMPACT !== "0";
		this.branchSummaryEnabled = process.env.IMP_BRANCH_SUMMARY !== "0"; // #10: /tree keeps the left branch’s lessons
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
		for (const warning of this.agents.warnings) {
			options.renderer.error(`imp: ${warning}`);
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
		// Extension sections sit after the AGENTS.md block, in registration
		// (load) order — stable across runs (M4c design §8.3). /new re-runs
		// assembleSystem, so sections outlive sessions without re-registration.
		for (const section of this.options.extensions?.contextSections ?? []) {
			system += `\n\n# Extension context: ${section.id}\n\n${section.text}`;
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

	listSessions(): SessionInfo[] {
		return listSessions(this.options.cwd, this.options.sessionBaseDir);
	}

	/** `/fork` candidates: user messages on the current branch with previews
	 *  (#10 batch 1). Empty when sessions are disabled or the branch has no
	 *  earlier user messages. */
	forkPoints(): { id: string; preview: string }[] {
		if (this.sessionStore === null) return [];
		return this.sessionStore.userForkPoints().map((entry) => ({
			id: entry.id,
			preview: shorten(userText(entry.message)),
		}));
	}

	/** `/fork <n>` / picker pick: branch before a user message — the store's
	 *  leaf moves, the in-memory history reloads from the new path (same
	 *  wiring as resumeSession). The abandoned tail stays on disk. */
	forkSessionAt(entryId: string): { retained: number; abandoned: number; preview: string } {
		const store = this.sessionStore;
		if (store === null) throw new SessionNotFoundError("no session to fork (sessions disabled)");
		const target = store.userForkPoints().find((entry) => entry.id === entryId);
		if (target === undefined) throw new SessionNotFoundError(`fork target ${entryId} not found`);
		const preview = shorten(userText(target.message));
		const { retained, abandoned } = store.forkBefore(entryId);
		this.history.length = 0;
		this.history.push(...store.buildContext().messages); // same wiring as warmup()/resumeSession()
		return { retained, abandoned, preview };
	}

	/** `/tree` candidates (#10 batch 2): other tips as the picker sees them. */
	branchTips(): { id: string; label: string; count: number }[] {
		if (this.sessionStore === null) return [];
		return this.sessionStore.otherBranchTips().map((tip) => ({
			id: tip.id,
			label: shorten(tip.label),
			count: tip.count,
		}));
	}

	/** `/tree` switch (#10 batch 2): move to another tip; unless disabled,
	 *  summarize the abandoned segment (pi's BranchSummaryEntry) so the new
	 *  branch keeps the lessons of the left one. Best-effort: a summarizer
	 *  failure still switches, just without the summary. */
	async switchSessionBranch(tipId: string): Promise<{
		summary: "written" | "empty" | "disabled" | "failed";
		messages: number;
	}> {
		const store = this.sessionStore;
		if (store === null) throw new SessionNotFoundError("no session to switch (sessions disabled)");
		const { abandoned } = store.splitBranches(tipId); // BEFORE the switch
		store.switchBranch(tipId);
		let outcome: "written" | "empty" | "disabled" | "failed" = "disabled";
		if (!this.branchSummaryEnabled) {
			// outcome stays "disabled"
		} else {
			const messages = abandoned
				.filter((entry): entry is MessageEntry => entry.type === "message")
				.map((entry) => entry.message);
			if (messages.length === 0) {
				outcome = "empty"; // forked, never wrote, switched back — nothing to summarize
			} else {
				try {
					const summary = await summarizeBranchSegment({
						messages,
						provider: this.provider,
						model: this.model,
					});
					// Identity guard (review P1-1 defense-in-depth): if the live
					// session was swapped while we awaited, the append and the
					// history reload belong to whoever swapped it — not us.
					if (this.sessionStore !== store) return { summary: "failed", messages: this.history.length };
					store.appendBranchSummary(summary);
					outcome = "written";
				} catch (err) {
					// best-effort by contract — but never silently: the run log
					// carries the reason (review P2-2)
					this.logger.log("run_error", {
						source: "branch-summary",
						message: err instanceof Error ? err.message : String(err),
					});
					outcome = "failed";
				}
			}
		}
		if (this.sessionStore !== store) return { summary: "failed", messages: this.history.length };
		this.history.length = 0;
		this.history.push(...store.buildContext().messages);
		return { summary: outcome, messages: this.history.length };
	}

	resumeSession(id: string): { id8: string; messages: number } {
		// Same matching as --resume: UUID, unique prefix, or file name.
		const store = resolveSession(this.options.cwd, {
			resume: id,
			baseDir: this.options.sessionBaseDir,
		});
		if (store === null) {
			throw new SessionNotFoundError(`no session matching "${id}" — run /sessions to list them`);
		}
		this.sessionStore = store;
		this.history.length = 0;
		this.history.push(...store.buildContext().messages); // same wiring as warmup()
		this.system = this.assembleSystem();
		return { id8: store.header.id.slice(0, 8), messages: this.history.length };
	}

	setModel(reference: string): void {
		const ref = parseModelRef(reference);
		this.model = ref.modelId;
		// Swap the provider INSTANCE only when the protocol family changes —
		// a same-family switch keeps the current instance (test fakes inject
		// here; in production the kept instance IS the real one).
		if (ref.provider !== this.providerName) {
			this.provider = createProviderFor(ref.provider);
			this.providerName = ref.provider;
		}
		this.settings = { ...this.settings, contextWindow: contextWindowFor(reference) };
	}

	get contextWindow(): number {
		return contextWindowFor(this.model);
	}

	runTurn(options: RunTurnOptions): Promise<RunAgentLoopResult> {
		const model = this.model; // captured at call entry: /model mid-run affects only later turns
		this.lastRunModel = model;
		const session = this.sessionStore;
		return this.runTurnInner(model, session, options);
	}

	/** The live turn's onEvent tap (M10 B): the construction-time task tool
	 *  relays its child events through this holder — see runTurnInner. */
	private turnEventTap: RunTurnOptions["onEvent"] | null = null;

	private async runTurnInner(
		model: string,
		session: SessionStore | null,
		options: RunTurnOptions,
	): Promise<RunAgentLoopResult> {
		// The task tool is built once at construction; its child-event relay
		// reaches the CURRENT turn's tap through this holder (task children run
		// strictly inside the turn, so one slot is enough; cleared in finally).
		this.turnEventTap = options.onEvent ?? null;
		try {
			const result = await runAgentLoop({
				provider: this.provider,
				model,
				system: this.system,
				tools: this.tools,
				history: this.history,
				userMessage: options.userMessage,
				maxTokens: this.options.maxTokens,
				maxIterations: this.options.maxTurns,
				// Assistant messages entering history also reach "message_end"
				// observers (M4c design §8.3) — after persistence, like everything
				// else the wrapper does.
				onMessage: (message) => {
					this.sessionStore?.appendMessage(message);
					if (message.role === "assistant") {
						this.options.extensions?.emitMessageEnd({ type: "message_end", message });
					}
				},
				// The gate seam: the registry chains "tool_call" handlers in load
				// order and fails safe on a throwing handler (E9) — the loop only
				// knows the generic { block, reason } decision. Events carry the
				// runner's cwd so gates resolve relative paths against the loop
				// that is about to execute them (M6b).
				onToolCall: (call) =>
					this.options.extensions?.emitToolCall({ type: "tool_call", ...call, cwd: this.options.cwd }),
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
				// Wrapped once (M4c design §8.3): forward to the renderer as before,
				// and tap tool_end for observers — fire-and-forget, isolated by the
				// registry (E10), never blocking the loop.
				onEvent: (event) => {
					options.onEvent?.(event);
					if (event.type === "tool_end") {
						const { result } = event;
						this.options.extensions?.emitToolEnd({
							type: "tool_end",
							toolCallId: result.toolCallId,
							name: result.toolName,
							output: result.content,
							isError: result.isError,
							cwd: this.options.cwd,
						});
					}
				},
				signal: options.signal,
			});
			// run_end means a run that ended — including an aborted one — not one
			// that crashed: a provider throw skips this emit entirely (its error
			// path already reports).
			this.options.extensions?.emitRunEnd({
				type: "run_end",
				stopReason: result.stopReason,
				turns: result.turns,
				usage: result.usage,
			});
			return result;
		} catch (err) {
			this.logger.log("run_error", { message: err instanceof Error ? err.message : String(err) });
			throw err;
		} finally {
			this.turnEventTap = null; // the holder is turn-scoped
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

	getTool(name: string): Tool | undefined {
		return this.tools.find((tool) => tool.name === name);
	}

	close(): void {
		this.logger.close();
	}
}

/** User-message text for fork previews: plain string, or the joined text
 *  blocks of a block-content message (steering frames, extensions). */
function userText(message: AgentMessage): string {
	// imp's UserMessage.content is always a string (slim format — no block
	// content on user turns).
	return message.role === "user" ? message.content : "";
}
