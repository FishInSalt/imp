import os from "node:os";
import path from "node:path";
import { type AgentRegistry, formatAgentsForPrompt, loadAgentDefinitions } from "./core/agents/registry.js";
import {
	type CompactionSettings,
	compactSession,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	isContextOverflowError,
	overflowGuidance,
	shouldCompact,
	summarizeBranchSegment,
} from "./core/compaction.js";
import { loadContextFiles } from "./core/context-files.js";
import { createRunLogger, type RunLogger } from "./core/logger.js";
import type { AgentEvent, RunAgentLoopResult } from "./core/loop.js";
import { runAgentLoop, synthesizeMissingToolResults } from "./core/loop.js";
import { type AgentMessage, contentText, type ImageBlock } from "./core/messages.js";
import type { SessionInfo } from "./core/session/manager.js";
import { createSession, listSessions, resolveSession, SessionNotFoundError } from "./core/session/manager.js";
import type { MessageEntry, SessionEntry, SessionStore } from "./core/session/store.js";
import { effectiveSettings, type ImpSettings, saveSettings, settingsFilePath } from "./core/settings.js";

/** navigateTree's success shape (batch B: named so forkSessionAt can extend
 *  it; editorTextDroppedImages flags that the re-edited user message carried
 *  image blocks — text is all that returns). */
export type NavigateTreeSuccess = {
	editorText?: string;
	editorTextDroppedImages?: boolean;
	summary: "written" | "empty" | "disabled" | "failed";
	messages: number;
};
export type NavigateTreeResult = { noop: true } | { aborted: true } | NavigateTreeSuccess;
/** forkSessionAt = navigateTree + the picked message's preview (the note). */
export type NavigateTreeForkResult =
	| { noop: true }
	| { aborted: true }
	| { editorText?: string; editorTextDroppedImages?: boolean; preview: string; messages: number };

import { escapeXml, formatSkillsForPrompt, type Skill } from "./core/skills.js";
import {
	buildSystemPrompt,
	defaultSystemPromptContext,
	mcpCatalogEntries,
	type PromptCatalogTool,
} from "./core/system-prompt.js";
import { loadSystemPromptFiles } from "./core/system-prompt-files.js";
import { createBashTool } from "./core/tools/bash.js";
import { createEditTool } from "./core/tools/edit.js";
import { createFindTool } from "./core/tools/find.js";
import { createGrepTool } from "./core/tools/grep.js";
import { createLsTool } from "./core/tools/ls.js";
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
import {
	clampThinkingLevel,
	THINKING_LEVELS,
	type ThinkingLevel,
	thinkingMetaFor,
} from "./provider/thinking.js";
import type { LLMProvider } from "./provider/types.js";
import { modelSupportsVision } from "./provider/vision.js";
import { zaiApiKey } from "./provider/zai.js";
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
	/** Startup thinking level (#thinking-levels, pi parity): --thinking /
	 *  IMP_THINKING. Clamped per model family on warmup; default "off". */
	thinking?: ThinkingLevel;
	maxTurns: number;
	noContextFiles: boolean;
	noSession: boolean;
	resume?: string;
	continueRecent?: boolean;
	sessionBaseDir?: string; // hermetic tests (passed through to the session manager)
	/** Hermetic tests: the settings file path (default ~/.imp/settings.json). */
	settingsPath?: string;
	/** M15: project settings visibility (the M8 trust gate result for the
	 *  session cwd — false keeps <cwd>/.imp/settings.json unread). */
	projectSettingsAllowed?: boolean;
	/** Hermetic tests: overrides ~/.imp/agents for the agent registry (M5c). */
	agentsHomeDir?: string;
	/** M8 trust gate: false skips `<cwd>/.imp/agents` (global agents still load). */
	agentsProjectAllowed?: boolean;
	/** #system-md: the session-resolved trust bit for project SYSTEM.md /
	 *  APPEND_SYSTEM.md. The loader must NOT re-read the trust store — the
	 *  "session" answer grants without recording (design review P1-1).
	 *  Default false (conservative when not told). */
	systemPromptProjectAllowed?: boolean;
	/** Hermetic tests: overrides ~/.imp for SYSTEM.md/APPEND_SYSTEM.md
	 *  discovery (design review P1-2 — a real global file on the dev machine
	 *  would replace the prompt and machine-break the suite). */
	systemPromptHomeDir?: string;
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
	/** M12 skills — loaded in cli.ts (like extensions), appended to the system
	 *  prompt after extension sections. `read` must be available for the block
	 *  (progressive disclosure's activation channel); imp's base set always has it. */
	skills?: readonly Skill[];
	/** Extension load failures — logged once the run logger exists (run_error,
	 *  source "extension"), so one line on screen stays debuggable on disk. */
	extensionFailures?: readonly ExtensionFailure[];
}

export interface RunTurnOptions {
	userMessage?: string; // omit ⇒ continue existing history (not used by 3a UI)
	/** M13 batch 2: @file image attachments for the opening user message. */
	userImages?: ImageBlock[];
	signal?: AbortSignal;
	/** Turn event tap. `info` is set ONLY for subagent-sourced events (the
	 *  task tool relays its child loop's events with the child's agent name
	 *  and cwd) — top-level events carry undefined and must stay the only
	 *  ones fed to the Renderer (M5's zero-rendering-visibility rule). */
	onEvent?: (event: AgentEvent, info?: AgentEventInfo) => void;
	/** Steering: queued user input injected at turn boundaries. */
	getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
	/** Follow-ups (M17): queued user input consumed when the model would
	 *  stop — the same run continues to answer them (see loop.ts). */
	getFollowUpMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
}

/** Discriminator for subagent-sourced events on RunTurnOptions.onEvent. */
export interface AgentEventInfo {
	agent?: string;
	cwd?: string;
}

export type CompactOutcome = "compacted" | "nothing-to-compact" | "no-session";

export interface Runner {
	readonly session: SessionStore | null;
	/** The assembled system prompt (test/inspection seam). */
	readonly system: string;
	/** prompt-audit P7: re-run system assembly (MCP tool-set syncs). */
	refreshSystemPrompt(): void;
	/** The live tool table (M18: the MCP manager splices bridged tools in at
	 *  run boundaries; identity stable for the loop's per-turn wire request).
	 *  readonly = do not REASSIGN; the array itself is mutated in place. */
	readonly tools: Tool[];
	/** The merged settings view (M15) — construction-time snapshot
	 *  (global ← trust-gated project). */
	effectiveSettings(): ImpSettings;
	/** M15: whether <cwd>/.imp/settings.json participates this session. */
	readonly projectSettingsAllowed: boolean;
	/** M15: the working directory the settings scopes resolve against (the
	 *  session cwd — /settings uses it instead of process.cwd()). */
	readonly runnerCwd: string;
	/** M15: the global settings file this session reads (test seam path
	 *  included) — /settings writes there, not to the bare default. */
	globalSettingsPath(): string;
	/** The live conversation array — the REPL holds this across turns. Identity is stable. */
	readonly history: AgentMessage[];
	/** Per-run model. Mutable: `/model` writes it; runTurn/compaction read it at call time. */
	model: string;
	/** Runtime model switch (#multi-provider batch 2): re-resolves the provider
	 *  from the canonical reference so /model can cross protocols mid-session,
	 *  and recomputes the compaction window to match the new model. */
	/** The protocol family serving the current model — the connection tell
	 *  (anthropic = the compat endpoint / first-party API; zai = Z.ai's
	 *  coding endpoint; modelReference() prefixes every family but anthropic). */
	readonly providerName: ProviderName;
	setModel(reference: string): void;
	/** Current thinking level (#thinking-levels, pi parity). "off" default. */
	readonly thinkingLevel: ThinkingLevel;
	/** Set the thinking level; clamps to the CURRENT model's family. Returns
	 *  the effective level (pi's clamp-to-nearest semantics). */
	setThinkingLevel(level: ThinkingLevel): ThinkingLevel;
	/** Whether the current model has a thinking knob at all (pi's
	 *  supportsThinking — drives /think and the footer segment). */
	supportsThinking(): boolean;
	/** Effective context window for the CURRENT model (registry-backed). */
	readonly contextWindow: number;
	/** Whether auto-compaction is on — the footer's "(auto)" indicator. */
	readonly autoCompactEnabled: boolean;
	/** Canonical display reference — "openai-codex/gpt-5.4" vs bare "glm-4.6". */
	modelReference(): string;
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
	forkSessionAt(entryId: string): Promise<NavigateTreeForkResult>;
	/** `/tree` navigation result: noop = target was the current position;
	 *  aborted = the summarizer was cancelled (nothing moved — abort is
	 *  abort of the whole navigation, pi parity); otherwise the summary
	 *  outcome and the rebuilt context size. */
	navigateTree(
		targetId: string,
		opts?: { summarize?: boolean; customInstructions?: string; signal?: AbortSignal },
	): Promise<
		| { noop: true }
		| { aborted: true }
		| {
				editorText?: string;
				editorTextDroppedImages?: boolean;
				summary: "written" | "empty" | "disabled" | "failed";
				messages: number;
		  }
	>;
	printRunStats(result: RunAgentLoopResult, options?: { statsLine?: boolean }): void;
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
	providerName: ProviderName; // implements Runner's public readonly tell
	/** The live tool table (M18: public — the MCP manager splices its bridged
	 *  tools in at run boundaries; the array identity is stable for the loop's
	 *  per-turn wire request while execution's toolMap is rebuilt per run). */
	readonly tools: Tool[];
	private readonly autoCompact: boolean;
	private effective: ImpSettings;

	/** Whether auto-compaction is on — the footer's "(auto)" indicator. */
	/** The merged settings view (M15) — construction-time snapshot. */
	effectiveSettings(): ImpSettings {
		return this.effective;
	}

	/** M15: whether <cwd>/.imp/settings.json participates this session (the
	 *  startup trust resolution — /settings uses the same gate for writes). */
	get projectSettingsAllowed(): boolean {
		return this.options.projectSettingsAllowed === true;
	}

	get runnerCwd(): string {
		return this.options.cwd ?? process.cwd();
	}

	globalSettingsPath(): string {
		return settingsFilePath(this.options.settingsPath);
	}

	get autoCompactEnabled(): boolean {
		return this.autoCompact;
	}
	private readonly branchSummaryEnabled: boolean;
	private settings = DEFAULT_COMPACTION_SETTINGS; // contextWindow follows the model (multi-provider)
	private systemText: string;
	/** #thinking-levels: the live level (pi's AgentState.thinkingLevel). */
	private level: ThinkingLevel = "off";
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
		this.providerName = options.provider !== undefined ? parseModelRef(options.model).provider : providerName;
		this.model = initialModel;
		// Multi-provider review P1-3: the compaction window must follow the
		// registry from construction — not only after an explicit /model switch.
		this.settings = { ...this.settings, contextWindow: contextWindowFor(options.model) };
		// M15: every runner settings read goes through the merged view (global ←
		// trust-gated project). Snapshot at construction — pi's read definitions
		// capture settings the same way (recorded in M13 batch 2).
		// The project scope resolves against the SESSION cwd (options.cwd),
		// never the process cwd — runner tests and multi-cwd callers rely on it.
		this.effective = effectiveSettings({
			cwd: this.options.cwd ?? process.cwd(),
			projectAllowed: this.options.projectSettingsAllowed === true,
			globalPath: this.options.settingsPath,
		});
		this.lastRunModel = initialModel;
		// #thinking-levels: startup level (--thinking / IMP_THINKING) > the
		// settings default (persisted by setThinkingLevel) > pi's
		// DEFAULT_THINKING_LEVEL "medium" — clamped to the startup model's
		// family (pi clamps on init the same way; knob-less models clamp to
		// "off", so the medium default only ever applies where a knob exists).
		const storedDefault = this.effectiveSettings().defaultThinkingLevel;
		this.level = clampThinkingLevel(
			thinkingMetaFor(this.providerName, this.model),
			this.options.thinking ?? storedDefault ?? "medium",
		);
		// The "test seam" tools option generalizes (design §8.1): explicit tools
		// keep their hermetic set, extension tools append after the base six. The
		// default six run under options.cwd — never process.cwd() — so the
		// runner's cwd is the one contract everywhere (and hermetic cwds stay hermetic).
		this.tools = [
			...(options.tools ?? [
				createBashTool({ cwd: options.cwd }),
				// M13: the live getter — /model can switch vision off mid-session.
				createReadTool({
					cwd: options.cwd,
					modelSupportsVision: () => modelSupportsVision(this.providerName, this.model),
					// M13 batch 2: images.autoResize, snapshotted at tool construction
					// (pi parity — its read definition captures it the same way);
					// a settings edit takes effect on the next session.
					imageProcessing: {
						autoResize: this.effectiveSettings().images?.autoResize ?? true,
					},
				}),
				createEditTool({ cwd: options.cwd }),
				createWriteTool({ cwd: options.cwd }),
				createGrepTool({ cwd: options.cwd }),
				createFindTool({ cwd: options.cwd }),
				createLsTool({ cwd: options.cwd }),
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
				getProvider: () => this.provider,
				getModel: () => this.model,
				getAutoCompact: () => this.autoCompact,
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
					createReadTool({
						cwd,
						modelSupportsVision: () => modelSupportsVision(this.providerName, this.model),
						imageProcessing: {
							autoResize: this.effectiveSettings().images?.autoResize ?? true,
						},
					}),
					createEditTool({ cwd }),
					createWriteTool({ cwd }),
					createGrepTool({ cwd }),
					createFindTool({ cwd }),
					createLsTool({ cwd }),
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
						output: contentText(result.content),
						isError: result.isError,
						subagent: true,
						agent: info.agent,
						cwd: info.cwd,
					});
				},
			}),
		);
		// M15: env override > project settings > global settings > default on
		this.autoCompact =
			process.env.IMP_AUTOCOMPACT === "0" ? false : (this.effectiveSettings().autoCompact ?? true);
		this.branchSummaryEnabled = process.env.IMP_BRANCH_SUMMARY !== "0"; // #10: /tree keeps the left branch’s lessons
		this.systemText = "";
		if (!options.deferInit) this.warmup();
	}

	warmup(): void {
		if (this.initialized) return;
		this.initialized = true;
		const options = this.options;
		// #glm-retire: bare glm-* routes to zai unconditionally now — a
		// missing credential teaches /login instead of silently falling
		// back to the (retired) anthropic-compat path.
		this.noteMissingZaiCredential(options.model, this.providerName);
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
					this.restoreThinkingFromSession(resumed); // --resume/-c restore the branch's level too
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
		this.systemText = this.assembleSystem();
	}

	get session(): SessionStore | null {
		return this.sessionStore;
	}

	get renderer(): Renderer {
		return this.options.renderer;
	}

	/** The assembled system prompt — readonly outside; rewritten by warmup,
	 *  /new, /resume and MCP tool-set syncs (refreshSystemPrompt). */
	get system(): string {
		return this.systemText;
	}

	/** Re-run system assembly (prompt-audit P7): the MCP manager calls this
	 *  whenever the tool set syncs (handshake completion, run boundaries) —
	 *  assembleSystem at warmup alone would never see late-arriving tools.
	 *  Notes are suppressed: an MCP sync is not a context event. The string
	 *  only changes when the tool set actually changed, so provider prompt
	 *  caching is unaffected. */
	refreshSystemPrompt(): void {
		this.systemText = this.assembleSystem(false);
	}

	private assembleSystem(notify = true): string {
		const catalogTools: PromptCatalogTool[] = [
			...this.tools.filter((t) => t.mcpServer === undefined),
			...mcpCatalogEntries(this.tools),
		];
		// #system-md: cwd is pinned to the session cwd, not process.cwd() —
		// in override mode it is the sole surviving machine fact (review P2-5).
		const promptFiles = loadSystemPromptFiles(
			this.options.cwd,
			this.options.systemPromptProjectAllowed ?? false,
			this.options.systemPromptHomeDir ?? os.homedir(),
		);
		let system = buildSystemPrompt({ ...defaultSystemPromptContext(), cwd: this.options.cwd }, catalogTools, {
			override: promptFiles.override?.text,
			append: promptFiles.append?.text,
		});
		if (notify) {
			const sources = [promptFiles.override, promptFiles.append]
				.filter((e): e is { text: string; path: string } => e !== undefined)
				.map((e) => path.relative(this.options.cwd, e.path) || e.path);
			if (sources.length > 0) {
				this.options.renderer.note(`▪ system: ${sources.join(", ")}`);
			}
			const rel = (p: string) => path.relative(this.options.cwd, p) || p;
			for (const file of promptFiles.supersededByGlobal) {
				this.options.renderer.note(
					`▪ global ${path.basename(file)} active — project ${rel(file)} ignored (imp --trust to enable)`,
				);
			}
			for (const file of promptFiles.unreadableProject) {
				this.options.renderer.note(`▪ could not read ${rel(file)} — skipped`);
			}
		}
		if (!this.options.noContextFiles) {
			const context = loadContextFiles(this.options.cwd);
			if (context) {
				// prompt-audit P4: XML wrappers — markdown headers can be forged
				// by file content; tags give the model a reliable boundary and
				// carry the file's provenance (pi's <project_context> shape).
				const inner = context.sections
					.map(
						(s) =>
							`<project_instructions path="${escapeXml(s.path)}">\n${s.content}\n</project_instructions>\n\n`,
					)
					.join("");
				system += `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${inner}</project_context>`;
				if (notify) {
					const display = context.files.map((f) => path.relative(this.options.cwd, f) || f).join(", ");
					this.options.renderer.note(`▪ context: ${display}`);
				}
			}
		}
		// Extension sections sit after the project-context block, in registration
		// (load) order — stable across runs (M4c design §8.3). /new re-runs
		// assembleSystem, so sections outlive sessions without re-registration.
		for (const section of this.options.extensions?.contextSections ?? []) {
			system += `\n\n# Extension context: ${section.id}\n\n${section.text}`;
		}
		// Skills (M12): the progressive-disclosure catalog is only useful once
		// a file-read tool exists to load bodies on demand.
		if (this.options.skills !== undefined && this.tools.some((t) => t.name === "read")) {
			system += formatSkillsForPrompt(this.options.skills);
		}
		// prompt-audit P8: the agent roster (capped, escaped, budgeted) —
		// task's description stays static; routing lives here.
		const agentBlock = formatAgentsForPrompt(this.agents.agents);
		if (agentBlock !== undefined) system += `\n\n${agentBlock}`;
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
		this.systemText = this.assembleSystem();
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

	/** `/fork <n>` / picker pick: branch before a user message. Batch B D6:
	 *  a thin wrapper over navigateTree(summarize:false) — ONE "move the
	 *  position + rebuild history" path (/tree's), not two that can drift.
	 *  Keeps forkSessionAt's own target validation (user message on the
	 *  current branch) as a pre-check, and adds what /fork always lacked:
	 *  the re-typed text lands back in the editor (editorText passthrough).
	 *  forkBefore (store level) stays as a public API pinned by tests; no
	 *  runner caller remains. */
	async forkSessionAt(entryId: string): Promise<NavigateTreeForkResult> {
		const store = this.sessionStore;
		if (store === null) throw new SessionNotFoundError("no session to fork (sessions disabled)");
		// Pre-check (defense kept from the old implementation): only a user
		// message ON the current branch is a fork target.
		const target = store.userForkPoints().find((entry) => entry.id === entryId);
		if (target === undefined) throw new SessionNotFoundError(`fork target ${entryId} not found`);
		const preview = shorten(userText(target.message));
		const result = await this.navigateTree(entryId, { summarize: false });
		if ("noop" in result || "aborted" in result) return result;
		return {
			...(result.editorText === undefined ? {} : { editorText: result.editorText }),
			...(result.editorTextDroppedImages === true ? { editorTextDroppedImages: true } : {}),
			preview,
			messages: result.messages,
		};
	}

	/** `/tree` navigation (#tree, replaces the tip-only switchSessionBranch
	 *  — design §3.2). pi's navigateTree semantics, ported:
	 *  - target === current leaf → noop;
	 *  - target is a USER message → the write position moves to the
	 *    message's PARENT (null before the first message) and the message
	 *    text comes back as editorText for re-editing — the next submit
	 *    re-grows the branch with the edited text (pi agent-session.ts:3264);
	 *  - otherwise the write position moves TO the target;
	 *  - the abandoned segment (everything after the TARGET on the old
	 *    path — splitBranches(targetId), exactly pi's
	 *    collectEntriesForBranchSummary set, review P1-1) may be summarized
	 *    into the new position first (branchSummary entry, disabled by
	 *    IMP_BRANCH_SUMMARY=0). Abort of the summarizer aborts the WHOLE
	 *    navigation — nothing moves (not a failure; review P1-3).
	 *  Identity guard (review P2-2): if the live session was swapped while
	 *  awaiting, the append and reload belong to whoever swapped it. */
	async navigateTree(
		targetId: string,
		opts?: { summarize?: boolean; customInstructions?: string; signal?: AbortSignal },
	): Promise<NavigateTreeResult> {
		const store = this.sessionStore;
		if (store === null) throw new SessionNotFoundError("no session to navigate (sessions disabled)");
		const target = store.getEntry(targetId);
		if (target === undefined || target.type === "label") {
			throw new SessionNotFoundError(`tree target ${targetId} not found`);
		}
		// noop only for a NON-user leaf target. A USER message that IS the
		// current leaf (an unanswered turn — aborted/errored before any
		// assistant entry landed) still navigates: newLeaf = its parent,
		// editorText = its text (batch B §4 P1 — /fork's primary case;
		// unreachable from /tree, whose surfaces short-circuit leaf picks
		// with "already at that point", matching pi).
		const leafTargetIsUser =
			target.type === "message" && target.message.role === "user" && targetId === store.getLeafId();
		if (targetId === store.getLeafId() && !leafTargetIsUser) return { noop: true };
		// The abandoned set must be computed BEFORE any mutation, keyed on the
		// TARGET (review P1-1): a user-message target stays out of the summary
		// — its text goes back to the editor instead.
		const { abandoned } = store.splitBranches(targetId);
		const isUserMessage = target.type === "message" && target.message.role === "user";
		const newLeaf = isUserMessage ? target.parentId : targetId;
		const editorText = isUserMessage ? userText(target.message) : undefined;
		// Design §7 P3: re-edit restores TEXT only — flag dropped images.
		const hadImages =
			isUserMessage &&
			target.message.role === "user" &&
			Array.isArray(target.message.content) &&
			target.message.content.some((b) => b.type === "image");

		let outcome: "written" | "empty" | "disabled" | "failed" = "disabled";
		let summary: string | undefined;
		if (opts?.summarize !== true || !this.branchSummaryEnabled) {
			// no summary wanted or IMP_BRANCH_SUMMARY=0
		} else {
			const messages = abandoned
				.filter((entry): entry is MessageEntry => entry.type === "message")
				.map((entry) => entry.message);
			if (messages.length === 0) {
				outcome = "empty"; // nothing was written beyond the target — nothing to summarize
			} else {
				try {
					summary = await summarizeBranchSegment({
						messages,
						provider: this.provider,
						model: this.model,
						thinking: this.level, // pi: the summarizer thinks at the session level
						signal: opts?.signal,
						customInstructions: opts?.customInstructions,
					});
				} catch (err) {
					// Abort is abort of the NAVIGATION (review P1-3): distinguish by
					// the signal, not the message — nothing moves, not a failure.
					if (opts?.signal?.aborted) return { aborted: true };
					this.logger.log("run_error", {
						source: "branch-summary",
						message: err instanceof Error ? err.message : String(err),
					});
					outcome = "failed";
				}
			}
		}
		// Identity guard (review P2-2): a session swap during the await owns
		// the mutation, not us.
		if (this.sessionStore !== store) return { summary: "failed", messages: this.history.length };
		// A user-message target whose parent IS the current position ("re-type
		// this message here") moves nothing — branchTo would rightly reject it.
		const positionMoves = newLeaf !== store.getLeafId();
		if (positionMoves) store.branchTo(newLeaf);
		if (summary !== undefined) {
			if (this.sessionStore !== store) return { summary: "failed", messages: this.history.length };
			store.appendBranchSummary(summary); // parentId = newLeaf — heads the new position
			outcome = "written";
		}
		// The editorText re-edit case may move nothing — history is already right.
		this.history.length = 0;
		this.history.push(...store.buildContext().messages);
		return {
			...(editorText === undefined ? {} : { editorText }),
			...(hadImages === true ? { editorTextDroppedImages: true } : {}),
			summary: outcome,
			messages: this.history.length,
		};
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
		this.restoreThinkingFromSession(store); // pi restores the branch's level on resume
		this.systemText = this.assembleSystem();
		return { id8: store.header.id.slice(0, 8), messages: this.history.length };
	}

	/** #thinking-levels: restore the branch's last recorded level (pi's
	 *  resume behavior — sdk.ts reads ThinkingLevelChangeEntry). No entry
	 *  on the branch → keep the startup level; a knob-less model clamps
	 *  to "off" via the usual setModel-style clamp. Direct write: this is
	 *  a REPLAY of an old decision, not a new one (no fresh session entry). */
	private restoreThinkingFromSession(store: SessionStore): void {
		// pi sdk.ts:222: an explicit startup level (--thinking/IMP_THINKING)
		// outranks the session entry — restore only when the flag is absent.
		if (this.options.thinking !== undefined) return;
		const change = [...store.getEntries()]
			.reverse()
			.find(
				(e): e is Extract<SessionEntry, { type: "thinkingLevelChange" }> => e.type === "thinkingLevelChange",
			);
		if (change === undefined) return;
		const restored = change.thinkingLevel as ThinkingLevel;
		if ((THINKING_LEVELS as readonly string[]).includes(restored)) {
			this.level = clampThinkingLevel(thinkingMetaFor(this.providerName, this.model), restored);
		}
	}

	get thinkingLevel(): ThinkingLevel {
		return this.level;
	}

	setThinkingLevel(level: ThinkingLevel): ThinkingLevel {
		const previous = this.level;
		this.level = clampThinkingLevel(thinkingMetaFor(this.providerName, this.model), level);
		// pi parity: only an ACTUAL change appends a session entry and
		// persists (agent-session.ts isChanging — /think on the current
		// level is a no-op, not a new thinkingLevelChange row).
		if (this.level === previous) return this.level;
		this.sessionStore?.appendThinkingLevelChange(this.level);
		// pi parity (agent-session.ts:1686): an actual CHANGE persists as the
		// cross-session default — but never "off" for a knob-less model (that
		// clamp is model-specific, not a user preference).
		if (this.level !== previous && (this.supportsThinking() || this.level !== "off")) {
			saveSettings({ defaultThinkingLevel: this.level }, this.options.settingsPath);
		}
		return this.level;
	}

	supportsThinking(): boolean {
		return thinkingMetaFor(this.providerName, this.model) !== null;
	}

	/** Credential teaching (#glm-retire): a glm model on the zai family with
	 *  NO credential gets a one-line sign-in note — the bare-id compat
	 *  fallback is retired. Explicit anthropic/glm-* (the generic compat
	 *  passthrough) stays silent — a deliberate choice needing no key here. */
	private noteMissingZaiCredential(reference: string, provider: ProviderName): void {
		if (provider !== "zai") return;
		if (reference.trim().toLowerCase().startsWith("anthropic/")) return;
		if (!reference.trim().toLowerCase().split("/").pop()?.startsWith("glm-")) return;
		if (zaiApiKey() !== null) return; // signed in (stored > env) — nothing to teach
		this.options.renderer.note(
			`▪ ${reference.trim()} is a Z.ai model — sign in with /login zai (or export ZAI_API_KEY); anthropic/${reference.trim().split("/").pop()} forces the compat endpoint`,
		);
	}

	setModel(reference: string): void {
		const ref = parseModelRef(reference);
		this.model = ref.modelId;
		this.noteMissingZaiCredential(reference, ref.provider);
		// Swap the provider INSTANCE only when the protocol family changes —
		// a same-family switch keeps the current instance (test fakes inject
		// here; in production the kept instance IS the real one).
		// The swapped instance goes through withLogging like the construction-time
		// one (review P1-4: run_log must not go silent after a cross-family switch).
		if (ref.provider !== this.providerName) {
			this.provider = withLogging(createProviderFor(ref.provider), this.logger);
			this.providerName = ref.provider;
		}
		this.settings = { ...this.settings, contextWindow: contextWindowFor(reference) };
		// pi clamps the thinking level on model switch; a model with no knob
		// drops it to "off" (kept silently — /think and the footer report it).
		this.level = clampThinkingLevel(thinkingMetaFor(this.providerName, this.model), this.level);
	}

	/** The model's canonical display reference — prefixed for non-anthropic
	 *  families so users can tell WHICH protocol a bare id switched to
	 *  (review P2-5: "gpt-5.4" alone is ambiguous across families). */
	modelReference(): string {
		return this.providerName === "anthropic" ? this.model : `${this.providerName}/${this.model}`;
	}

	get contextWindow(): number {
		return contextWindowFor(this.model);
	}

	runTurn(options: RunTurnOptions): Promise<RunAgentLoopResult> {
		const model = this.model; // captured at call entry: /model mid-run affects only later turns
		// Provider and settings snapshot for the same reason (review P1-2):
		// /model is allowedDuringRun — a mid-run family switch must not leak a
		// new provider (or window) into an in-flight turn's compaction seam,
		// where it would pair with the captured model id of the OLD family.
		const provider = this.provider;
		const settings = this.settings;
		this.lastRunModel = model;
		const session = this.sessionStore;
		return this.runTurnOrRecoverFromOverflow(options, model, provider, settings, session);
	}

	/** #overflow-grace: a live "context window exceeded" provider error gets
	 *  ONE compact-and-retry attempt (pi's overflow recovery, minus its
	 *  stale-error same-model guard — imp only catches live request errors,
	 *  never persisted ones, so that scenario cannot arise). The user message
	 *  is already in history from the failed attempt; the retry reruns with
	 *  the prompt suppressed so it is not duplicated. Any second failure
	 *  surfaces the guidance instead of a raw provider 400. */
	private async runTurnOrRecoverFromOverflow(
		options: RunTurnOptions,
		model: string,
		provider: LLMProvider,
		settings: CompactionSettings,
		session: SessionStore | null,
	): Promise<RunAgentLoopResult> {
		try {
			return await this.runTurnInner(model, provider, settings, session, options);
		} catch (err) {
			if (!isContextOverflowError(err)) throw err;
			const cause = err instanceof Error ? err.message : String(err);
			this.logger.log("run_error", { source: "overflow-recovery", message: cause });
			this.options.renderer.note("▪ context over the model's window — compacting once and retrying…");
			let compacted = false;
			try {
				compacted = await this.compactAndSplice(provider, settings, model);
			} catch (compactErr) {
				const compactCause = compactErr instanceof Error ? compactErr.message : String(compactErr);
				this.logger.log("run_error", { source: "compaction", message: compactCause });
				throw new Error(overflowGuidance(estimateContextTokens(this.history).tokens, settings, compactCause));
			}
			if (!compacted) {
				throw new Error(
					overflowGuidance(estimateContextTokens(this.history).tokens, settings, "nothing safe to compact"),
				);
			}
			// retry over the existing history (user message already appended).
			// A SECOND overflow here is terminal — surface the guidance, not the
			// raw provider 400 (one attempt, like pi's _overflowRecoveryAttempted).
			try {
				return await this.runTurnInner(model, provider, settings, session, {
					...options,
					userMessage: undefined,
				});
			} catch (retryErr) {
				if (!isContextOverflowError(retryErr)) throw retryErr;
				const retryCause = retryErr instanceof Error ? retryErr.message : String(retryErr);
				this.logger.log("run_error", { source: "overflow-recovery", message: `retry failed: ${retryCause}` });
				throw new Error(
					overflowGuidance(
						estimateContextTokens(this.history).tokens,
						settings,
						"still over the window after one compaction",
					),
				);
			}
		}
	}

	/** The live turn's onEvent tap (M10 B): the construction-time task tool
	 *  relays its child events through this holder — see runTurnInner. */
	private turnEventTap: RunTurnOptions["onEvent"] | null = null;

	private async runTurnInner(
		model: string,
		provider: LLMProvider,
		settings: CompactionSettings,
		session: SessionStore | null,
		options: RunTurnOptions,
	): Promise<RunAgentLoopResult> {
		// The task tool is built once at construction; its child-event relay
		// reaches the CURRENT turn's tap through this holder (task children run
		// strictly inside the turn, so one slot is enough; cleared in finally).
		this.turnEventTap = options.onEvent ?? null;
		try {
			const result = await runAgentLoop({
				provider,
				model,
				system: this.system,
				tools: this.tools,
				history: this.history,
				userMessage: options.userMessage,
				userImages: options.userImages,
				maxTokens: this.options.maxTokens,
				thinking: this.thinkingLevel === "off" ? undefined : this.thinkingLevel,
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
							if (!shouldCompact(est.tokens, settings)) return;
							this.options.renderer.note(`▪ context ~${formatTokens(est.tokens)} tokens — compacting…`);
							// #overflow-grace: a failed pre-prompt compaction must not surface
							// as a raw provider 400 — teach the two ways out instead (this is
							// the 1M→272k switch-down deadlock: the summarization request
							// itself can exceed the new model's input window).
							try {
								await this.compactAndSplice(provider, settings, model);
							} catch (err) {
								const cause = err instanceof Error ? err.message : String(err);
								this.logger.log("run_error", { source: "compaction", message: cause });
								throw new Error(overflowGuidance(est.tokens, settings, cause));
							}
						}
					: undefined,
				getSteeringMessages: options.getSteeringMessages,
				getFollowUpMessages: options.getFollowUpMessages,
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
							output: contentText(result.content),
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
		return (await this.compactAndSplice(this.provider, this.settings, this.model))
			? "compacted"
			: "nothing-to-compact";
	}

	private async compactAndSplice(
		provider: LLMProvider,
		settings: CompactionSettings,
		model: string,
	): Promise<boolean> {
		const session = this.sessionStore;
		if (!session) return false;
		const compacted = await compactSession({
			session,
			provider,
			model,
			settings,
			thinking: this.level, // pi: the summarizer thinks at the session level
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

	printRunStats(result: RunAgentLoopResult, options: { statsLine?: boolean } = {}): void {
		switch (result.stopReason) {
			case "aborted":
				this.options.renderer.note("(aborted)");
				break;
			case "max_iterations":
				// An uncapped interactive run can never reach this branch; an
				// explicit cap prints its number either way.
				this.options.renderer.error(`(stopped: reached max turns (${this.options.maxTurns}))`);
				break;
			case "completed":
				break;
		}
		// The per-run `— model · turns · tokens` line is print-mode output
		// (bytes frozen). The TUI footer is the single status surface there —
		// pi parity (2026-09-10): no per-run line after each answer. Stop
		// notes above ("aborted" etc.) stay in both modes.
		if (options.statsLine !== false) {
			const cacheNote = result.usage.cacheReadTokens
				? ` · cache↓${formatTokens(result.usage.cacheReadTokens)}`
				: "";
			this.options.renderer.note(
				`— ${this.lastRunModel} · ${result.turns} turns · in ${formatTokens(result.usage.inputTokens)} / out ${formatTokens(result.usage.outputTokens)} tokens${cacheNote}`,
			);
		}
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
	// User turns are strings today (M13 only produces blocks on tool
	// results), but the type allows arrays — join defensively.
	return message.role === "user" ? contentText(message.content) : "";
}
