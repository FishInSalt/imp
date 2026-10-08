import { Value } from "typebox/value";
import type { LLMEvent, LLMProvider } from "../provider/types.js";
import { ABORT_GRACE_MS, MAX_CONCURRENT_SAFE_CALLS } from "./constants.js";
import type { HealthSignal } from "./health.js";
import {
	type AgentMessage,
	type AssistantMessage,
	addUsage,
	emptyUsage,
	type ImageBlock,
	type ToolResult,
	type Usage,
} from "./messages.js";
import type { Tool } from "./tools/types.js";
import type { AttemptUsage } from "./usage-ledger.js";
import { recordMissingUsageReport, recordUsageReport } from "./usage-ledger.js";

export type AgentEvent =
	| LLMEvent
	| { type: "tool_start"; toolCallId: string; name: string; args: unknown }
	| { type: "tool_end"; result: ToolResult }
	/** #sliding-window: a concurrency-safe call acquired a window slot and its
	 *  execution is starting NOW (fired before plan.run — a child source row
	 *  inherits the parent's startedAtMs, so the stamp must be the execution
	 *  start, not the pre-issued tool_start). **Display-only** — same channel
	 *  as `tool_settled`: the REPL tap upgrades the call's activity row from
	 *  queued to running; print reaches it via Renderer.event's no-op default,
	 *  extensions/health/history never see it. Emitted only for approved,
	 *  gate-passed plans that actually execute. */
	| { type: "tool_running"; toolCallId: string }
	/** #tool-settle: one concurrency-safe chunk call settled. **Display-only** —
	 *  the authoritative, call-ordered `tool_end` still follows in phase 3.
	 *  Reaches no extension sink (the dispatchers gate on `tool_end`) and is
	 *  never forwarded to the print/legacy Renderer. */
	| { type: "tool_settled"; result: ToolResult }
	/** #loop-health: a first-fire health signal, emitted by the callers'
	 *  monitors (never by the loop) and relayed to the interactive REPL.
	 *  It is not an M4 extension event and reaches no extension sink. */
	| { type: "health"; signal: HealthSignal };

export interface RunAgentLoopOptions {
	provider: LLMProvider;
	model: string;
	/** SA-05: the FULLY QUALIFIED producer reference (`provider/modelId`), the
	 *  pricing identity stamped onto assistant messages as `modelReference`
	 *  (distinct from `model`, the wire id). Omitted → no stamp → unpriced. */
	modelReference?: string;
	system: string;
	tools: Tool[];
	/** Conversation history. Appended in place with new messages from this run. */
	history: AgentMessage[];
	/** New user prompt. Omit to continue from existing history. */
	userMessage?: string;
	/** Image attachments for the opening user message (@file CLI args). */
	userImages?: ImageBlock[];
	maxTokens?: number;
	/** Thinking level (#thinking-levels); forwarded to the provider. */
	thinking?: import("../provider/thinking.js").ThinkingLevel;
	/** Safety valve against runaway tool loops. Default 40. */
	maxIterations?: number;
	/** Fires for every message that enters history (user, steering, assistant, tool results). */
	onMessage?: (message: AgentMessage) => void;
	/** Called between turns; may replace history contents in place (e.g. compaction). */
	onBeforeTurn?: (history: AgentMessage[]) => void | Promise<void>;
	/** Polls for steering messages: queued user input injected at turn boundaries. */
	getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
	/** Polls for follow-up messages (M17): queued user input consumed when the
	 *  model would otherwise stop — the SAME run continues to answer them
	 *  (pi agent-loop.ts:261). One poll per would-stop boundary; the caller's
	 *  drain mode (one-at-a-time / all) decides how much it returns. */
	getFollowUpMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
	/**
	 * Permission/observation gate: called after argument validation, before
	 * tool execution (M4c design §8.3). Return { block: true, reason } to
	 * veto — the model receives an isError tool result carrying the reason.
	 */
	onToolCall?: (
		call: { toolCallId: string; name: string; args: Record<string, unknown> },
		// biome-ignore lint/suspicious/noConfusingVoidType: a gate may return a decision, nothing (void), or undefined — sync or async (design §8.3)
	) => ToolCallDecision | void | undefined | Promise<ToolCallDecision | void | undefined>;
	onEvent?: (event: AgentEvent) => void;
	signal?: AbortSignal;
	/** #tool-settle: clock used to measure a concurrency-safe call's own
	 *  execution time. Injectable for deterministic tests; production passes
	 *  nothing and gets Date.now, matching TranscriptSink's default. */
	clock?: () => number;
	/**
	 * SA-04: optional attempt ledger. When present, every `message_end` report
	 * is recorded for the attempt and a started stream that ends without one
	 * marks the ledger incomplete — accounting that survives history splices,
	 * aborts and crashes. The main runner never passes it (no behavior change).
	 */
	usageLedger?: AttemptUsage;
}

export interface RunAgentLoopResult {
	stopReason: "completed" | "max_iterations" | "aborted";
	/** Assistant turns produced in this run. */
	turns: number;
	/** Aggregated token usage across all LLM calls in this run. */
	usage: Usage;
	/** #output-truncation D2: the final assistant message was cut off at the
	 *  output token limit ("max_tokens"). Set only on the "completed" return
	 *  (the otherwise-silent stop); never on aborted / max_iterations. */
	truncated?: boolean;
}

/**
 * Returned (sync or async) by an onToolCall gate / "tool_call" extension
 * handler. Declared here in core — next to the option that will consume it —
 * so src/extensions/ can import it type-only and core keeps zero extension
 * knowledge (M4 design §6.1/§8.3).
 */
export interface ToolCallDecision {
	/** Block execution. true is the only meaningful value; omit/void = allow. */
	block: boolean;
	/** Fed back to the model as the (isError) tool result — make it teaching-style. */
	reason?: string;
	/** #confirm-prompt (Phase 3 D9): the extension that returned this decision, set
	 *  by the registry (never by an extension or a raw onToolCall gate). Present ⇒
	 *  the block string names it; absent ⇒ today's `an extension` wording. */
	source?: string;
}

/** #confirm-prompt (Phase 3 D9): the block string's subject. The registry attaches
 *  the extension name to every decision it returns, so a block is attributed by the
 *  host; a raw `onToolCall` gate (no registry) keeps the anonymous fallback. */
function blockSource(decision: ToolCallDecision): string {
	return decision.source === undefined || decision.source === ""
		? "an extension"
		: `extension ${decision.source}`;
}

/**
 * The agent loop:
 *
 *   user message -> LLM (stream) -> assistant message
 *     -> if it contains tool calls: execute each, append tool results, call LLM again
 *     -> otherwise: done
 *
 * Everything the model does wrong (unknown tool, bad arguments, thrown errors)
 * is fed back to it as an error tool result instead of crashing the process.
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
	const {
		provider,
		model,
		modelReference,
		system,
		tools,
		history,
		userMessage,
		userImages,
		maxTokens = 8192,
		thinking,
		// Follows cli.ts's print default (100 since #no-turn-cap); callers
		// that go through the Runner always pass an explicit value — this floor
		// exists for direct/test callers.
		maxIterations = 100,
		onMessage,
		onBeforeTurn,
		getSteeringMessages,
		getFollowUpMessages,
		onToolCall,
		onEvent,
		signal,
		usageLedger,
		clock = Date.now,
	} = options;

	if (userMessage !== undefined && userMessage !== "") {
		// M13 batch 2: @file attachments ride the first user message as image
		// blocks (pi prompt(text, images) parity); a text-only prompt stays a
		// bare string — zero byte change for every existing session.
		const content =
			userImages !== undefined && userImages.length > 0
				? [{ type: "text", text: userMessage } as const, ...userImages]
				: userMessage;
		const user: AgentMessage = { role: "user", content };
		history.push(user);
		try {
			onMessage?.(user);
		} catch (error) {
			// Lazy session initialization can fail before the first request. Do
			// not carry an unsaved prompt into the next attempt's live context.
			history.pop();
			throw error;
		}
	}

	const usage = emptyUsage();
	const toolMap = new Map(tools.map((t) => [t.name, t] as const));
	let turns = 0;
	// Set right after injecting queued messages at a would-stop boundary so
	// the top-of-loop steering poll skips ONE pass — pi's "only poll again if
	// the earlier poll returned nothing" guard (:195): in one-at-a-time mode a
	// re-poll would deliver a second message into the same turn.
	let skipSteeringPoll = false;

	while (true) {
		if (signal?.aborted) return { stopReason: "aborted", turns, usage };

		// Steering: messages queued while the model was working enter before the
		// next assistant response, so the model sees them without a new user turn.
		if (skipSteeringPoll) {
			skipSteeringPoll = false;
		} else {
			const steering = (await getSteeringMessages?.()) ?? [];
			for (const message of steering) {
				history.push(message);
				onMessage?.(message);
			}
		}

		// Compaction hook: may rewrite history in place (older messages -> summary).
		await onBeforeTurn?.(history);

		const assistant = await streamAssistant({
			provider,
			request: { system, messages: history, tools, model, maxTokens, thinking, signal },
			onEvent,
			usage,
			ledger: usageLedger,
			modelReference,
		});
		if (assistant === null) return { stopReason: "aborted", turns, usage };

		history.push(assistant);
		turns++;
		onMessage?.(assistant);

		const toolCalls = assistant.blocks.filter(
			(b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall",
		);

		if (toolCalls.length === 0) {
			// The model would stop. M17, pi's boundary order (agent-loop.ts :257
			// then :261): steering queued during THIS turn's stream is consumed
			// first (it may add turns — steer priority); only an empty steering
			// poll consults follow-ups, which continue the SAME run (one abort
			// scope, one aggregated usage, one run_end). Each drained message
			// enters history exactly like a steering message. Empty polls on
			// both fronts are the real stop.
			// INVARIANT (caller-bounded, review P2): these polls can extend the
			// run indefinitely — maxIterations does NOT bound text-only
			// continuations. Every poll consumer must consume a FINITE queue
			// entry per delivery (the REPL splices one per drain); a poll that
			// always returns entries spins forever with no guard here.
			const boundarySteering = (await getSteeringMessages?.()) ?? [];
			if (boundarySteering.length > 0) {
				for (const message of boundarySteering) {
					history.push(message);
					onMessage?.(message);
				}
				skipSteeringPoll = true;
				continue;
			}
			const followUps = (await getFollowUpMessages?.()) ?? [];
			if (followUps.length === 0) {
				return {
					stopReason: "completed",
					turns,
					usage,
					// #output-truncation D2: the silent-stop case — a truncated final
					// response. aborted / max_iterations never set this.
					...(assistant.stopReason === "max_tokens" ? { truncated: true } : {}),
				};
			}
			for (const message of followUps) {
				history.push(message);
				onMessage?.(message);
			}
			skipSteeringPoll = true;
			continue;
		}

		if (turns >= maxIterations) {
			// Never executed: close the dangling tool_use ids so the session can be
			// resumed — an unanswered tool_call makes the next API request a 400.
			const results: ToolResult[] = [];
			fillMissingToolResults(toolCalls, results, "(not executed: reached max turns)");
			if (results.length > 0) {
				const toolResults: AgentMessage = { role: "toolResult", results };
				history.push(toolResults);
				onMessage?.(toolResults);
			}
			return { stopReason: "max_iterations", turns, usage };
		}

		const results: ToolResult[] = [];
		if (assistant.stopReason === "max_tokens") {
			// #output-truncation D1 (pi parity): a "max_tokens" stop means the
			// stream was cut mid-generation — streamed tool-call arguments may be
			// silently incomplete (they can even parse as valid JSON). Refuse the
			// whole batch; the model re-issues with complete arguments.
			failToolCallsFromTruncatedMessage(toolCalls, results, onEvent);
		} else {
			await executeToolBatch(toolCalls, toolMap, signal, onToolCall, onEvent, results, clock);
		}

		// Abort can stop mid-batch: synthesize results for tools that never ran,
		// so history (and the persisted session) always has complete tool_use →
		// tool_result pairs. Without this, a killed run becomes unresumable.
		fillMissingToolResults(toolCalls, results, "(interrupted before this tool ran)");

		if (results.length === 0) {
			// Aborted before any tool produced a result (unreachable with toolCalls > 0; guard kept).
			return { stopReason: "aborted", turns, usage };
		}
		const toolResults: AgentMessage = { role: "toolResult", results };
		history.push(toolResults);
		onMessage?.(toolResults);
	}
}

/**
 * Fill `results` with synthesized error results for tool calls that never
 * executed (abort mid-batch, max turns). Pure mutation — callers own the push.
 */
function fillMissingToolResults(
	toolCalls: Array<{ type: "toolCall"; id: string; name: string }>,
	results: ToolResult[],
	reason: string,
): void {
	const answered = new Set(results.map((r) => r.toolCallId));
	for (const call of toolCalls) {
		if (answered.has(call.id)) continue;
		results.push({ toolCallId: call.id, toolName: call.name, content: reason, isError: true });
	}
}

/** #output-truncation D1 (pi parity): refuse every tool call from an assistant
 *  message truncated at the output token limit — never execute a batch whose
 *  streamed arguments may be silently incomplete (a truncated argument string
 *  can still parse as valid JSON). Emits the same tool_start/tool_end event
 *  shape as execution so UI rows and extension taps stay consistent; the
 *  onToolCall gate is deliberately NOT consulted (this is not an execution
 *  attempt). Callers push the results as one toolResult message, so the
 *  tool_use → tool_result closure (resumability) is unchanged. */
function failToolCallsFromTruncatedMessage(
	toolCalls: ReadonlyArray<{ id: string; name: string; arguments: unknown }>,
	results: ToolResult[],
	onEvent?: (event: AgentEvent) => void,
): void {
	for (const call of toolCalls) {
		onEvent?.({ type: "tool_start", toolCallId: call.id, name: call.name, args: call.arguments });
		const result: ToolResult = {
			toolCallId: call.id,
			toolName: call.name,
			content: `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			isError: true,
		};
		results.push(persistableResult(result));
		onEvent?.({ type: "tool_end", result });
	}
}

/**
 * Scan a persisted message list for tool_use blocks with no matching
 * toolResult and return ONE toolResult message that closes them all.
 * Used when the process is about to die (force quit) so the session stays
 * resumable — an unanswered tool_call makes the next API request a 400.
 */
export function synthesizeMissingToolResults(messages: AgentMessage[], reason: string): AgentMessage[] {
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			for (const result of message.results) answered.add(result.toolCallId);
		}
	}
	const dangling: Array<{ id: string; name: string }> = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.blocks) {
			if (block.type === "toolCall" && !answered.has(block.id)) {
				dangling.push({ id: block.id, name: block.name });
			}
		}
	}
	if (dangling.length === 0) return [];
	const results = dangling.map((call) => ({
		toolCallId: call.id,
		toolName: call.name,
		content: reason,
		isError: true,
	}));
	return [{ role: "toolResult", results }];
}

async function streamAssistant(args: {
	provider: LLMProvider;
	request: Parameters<LLMProvider["stream"]>[0];
	onEvent?: (event: AgentEvent) => void;
	usage: Usage;
	ledger?: AttemptUsage;
	/** SA-05: fully qualified producer reference stamped on the message. */
	modelReference?: string;
}): Promise<AssistantMessage | null> {
	const { provider, request, onEvent, usage, ledger, modelReference } = args;
	// SA-04 (design §3.1/F2): account for a `message_end` BEFORE the observer
	// runs — a throwing observer must not turn a received report into a
	// phantom. Any exit without a report (abort, throw, protocol error) marks
	// the ledger incomplete: "started, not captured".
	let reported = false;
	try {
		for await (const event of provider.stream(request)) {
			if (request.signal?.aborted) return null;
			if (event.type === "message_end") {
				reported = true;
				addUsage(usage, event.message.usage);
				recordUsageReport(ledger, "task", event.message.usage);
				// SA-04 round 2: the adapter may have had NO usage data on the
				// wire (its zeros are initialization, not a report) — keep the
				// known numbers, disclose the unknown.
				if (event.message.usageMissing === true) recordMissingUsageReport(ledger);
				onEvent?.(event);
				// stamp the producer model for cost attribution (footer $ segment)
				return {
					...event.message,
					model: request.model,
					// SA-05: the fully qualified pricing identity (when supplied).
					...(modelReference !== undefined && { modelReference }),
				};
			}
			onEvent?.(event);
		}
		// Stream ended without a message_end event: an abort ends the generator
		// early (abortSafe) — report that as a clean abort, not a protocol error.
		if (request.signal?.aborted) return null;
		throw new Error("Provider stream ended without a message_end event");
	} finally {
		if (!reported) recordMissingUsageReport(ledger);
	}
}

interface ToolCallRef {
	id: string;
	name: string;
	arguments: unknown;
}

/** #abort-grace: bounded wait for signal-ignoring tool calls (design
 *  docs/design/abort-grace-design.md). After the signal aborts, each
 *  in-flight execution gets ABORT_GRACE_MS to settle on its own; at the
 *  deadline the host resolves the call's grace deferred with a synthesized
 *  isError result, so the waiting worker (or the serial caller) proceeds and
 *  the run finishes cleanly. This rescues the WAITER, not the culprit — the
 *  hung promise stays in the background (logged, never observed again).
 *
 *  Single-writer discipline (design §2.1, review MAJOR-1): the deadline timer
 *  only resolves deferreds and logs; the worker/serial caller remains the only
 *  writer of settled[index]/results/tool events. The resolver value IS the
 *  synthesized ToolResult object, so the grace path is byte-identical to a
 *  normal settle from the caller's perspective.
 *
 *  The timer exists ONLY after an abort AND while executions are in flight:
 *  normal runs allocate one deferred per call and never arm anything. It is
 *  unref'd (a pending grace timer must not hold the event loop open in print
 *  mode) and cleared when the batch finishes.
 *
 *  Load-bearing invariant (design §2.1, review MAJOR-2): `runTool` never
 *  rejects (it catches everything). The race loser stays pending forever in
 *  the hang case; if that ever changes, the fire-and-forget observation below
 *  must be re-audited for unhandledRejection. */
interface GraceEntry {
	/** Display name for the abandon log line. */
	name: string;
	/** The deferred raced against plan.run. Resolved by the deadline with the
	 *  SAME synthesized result object the waiter will use. */
	deferred: Promise<ToolResult>;
	resolveGrace: (result: ToolResult) => void;
	/** Memoized synthetic result (one object, resolved and awaited). */
	synthesized?: ToolResult;
}

function createGraceRegistry(signal: AbortSignal | undefined): {
	race: (run: Promise<ToolResult>, name: string) => Promise<ToolResult>;
	settle: () => void;
} {
	const entries = new Set<GraceEntry>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let armed = false;
	const fire = (): void => {
		timer = setTimeout(() => {
			timer = null;
			const seconds = Math.round(ABORT_GRACE_MS / 1000);
			for (const entry of entries) {
				if (entry.synthesized === undefined) {
					entry.synthesized = {
						toolCallId: "",
						toolName: entry.name,
						content: `Tool ${entry.name} did not respond to the interrupt within ${seconds}s — result abandoned; the underlying process may still be running.`,
						isError: true,
					};
					process.stderr.write(
						`ink: tool ${entry.name} did not respond to the interrupt within ${seconds}s — abandoning its result\n`,
					);
				}
				entry.resolveGrace(entry.synthesized);
			}
		}, ABORT_GRACE_MS);
		// DELIBERATELY NOT unref'd (review round 2 correction): an unref'd
		// grace timer lets the event loop drain past it — with the hung
		// execution's never-settling promise holding nothing but an await,
		// the process would exit 0 BEFORE the deadline and the synthesized
		// result (session closure, abandoning log) never happens. This timer
		// IS the run's only liveness during the window, so it must keep the
		// loop alive; the no-lingering guarantee comes from settle()'s finally
		// clear on every normal completion path, not from unref.
	};
	const arm = (): void => {
		if (armed || entries.size === 0) return;
		armed = true;
		fire();
	};
	const onAbort = (): void => arm();
	if (signal !== undefined) {
		// Fast path: already-aborted signals never fire the event again
		// (subagent.ts precedent) — arm immediately if anything is in flight.
		if (signal.aborted) arm();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		race: (run, name) => {
			let resolveGrace!: (result: ToolResult) => void;
			const deferred = new Promise<ToolResult>((resolve) => {
				resolveGrace = resolve;
			});
			const entry: GraceEntry = { name, deferred, resolveGrace };
			entries.add(entry);
			// #abort-grace review MAJOR-1: the abort listener is {once:true} —
			// an abort that fired while this registry was EMPTY (e.g. during a
			// serial gate await, before this registration) is already consumed
			// and will never call arm() again. signal.aborted is a latch: arm
			// here so a signal-ignoring tool registered post-abort is still
			// bounded. The `armed` guard keeps a pending timer from doubling.
			if (signal?.aborted) arm();
			const raced = Promise.race([run, deferred]);
			// Fire-and-forget observation of the loser (design §2.1): with
			// runTool never rejecting, this only silences the (impossible
			// today) rejection path; a late real settle is logged and dropped.
			run.then(
				() => {
					if (entries.has(entry)) entries.delete(entry);
					else process.stderr.write(`ink: tool ${name} settled late, result dropped\n`);
				},
				() => {},
			);
			return raced.then((result) => {
				entries.delete(entry);
				return result;
			});
		},
		settle: () => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			if (signal !== undefined) signal.removeEventListener("abort", onAbort);
		},
	};
}

// Arm-on-abort is wired per-batch by executeToolBatch (the registry itself is
// signal-agnostic so both paths share it).

/** One assistant message's tool calls, executed in order (M5b design §6;
 * #sliding-window).
 *
 * Non-safe tools run strictly serially — the exact pre-M5b path. A maximal
 * run of consecutive concurrency-safe calls is ONE chunk: gates evaluate
 * serially in call order first (deterministic, non-interleaved extension
 * state), then the approved subset executes behind a sliding window of
 * MAX_CONCURRENT_SAFE_CALLS slots — a released slot immediately admits the
 * next queued call in call order — and tool_end fires in call order as a
 * settled prefix advances (prefix flush), byte-stable output regardless of
 * completion timing. */
async function executeToolBatch(
	toolCalls: ToolCallRef[],
	toolMap: Map<string, Tool>,
	signal: AbortSignal | undefined,
	onToolCall: RunAgentLoopOptions["onToolCall"],
	onEvent: RunAgentLoopOptions["onEvent"],
	results: ToolResult[],
	clock: () => number,
): Promise<void> {
	const isSafe = (name: string) => toolMap.get(name)?.concurrencySafe === true;
	// #abort-grace: one registry per batch; both paths (serial + chunk) race
	// plan.run against a grace deferred that only resolves after an abort (see
	// createGraceRegistry). Normal runs never arm anything.
	const grace = createGraceRegistry(signal);
	try {
		await executeToolBatchInner(
			toolCalls,
			toolMap,
			signal,
			onToolCall,
			onEvent,
			results,
			clock,
			isSafe,
			grace,
		);
	} finally {
		grace.settle();
	}
}

async function executeToolBatchInner(
	toolCalls: ToolCallRef[],
	toolMap: Map<string, Tool>,
	signal: AbortSignal | undefined,
	onToolCall: RunAgentLoopOptions["onToolCall"],
	onEvent: RunAgentLoopOptions["onEvent"],
	results: ToolResult[],
	clock: () => number,
	isSafe: (name: string) => boolean,
	grace: ReturnType<typeof createGraceRegistry>,
): Promise<void> {
	let i = 0;
	while (i < toolCalls.length) {
		if (signal?.aborted) return;
		const call = toolCalls[i] as ToolCallRef;
		if (!isSafe(call.name)) {
			// Serial path — event order and behavior identical to pre-M5b.
			onEvent?.({ type: "tool_start", toolCallId: call.id, name: call.name, args: call.arguments });
			const result = await executeToolCall(
				call.id,
				call.name,
				call.arguments,
				toolMap,
				signal,
				onToolCall,
				grace,
			);
			results.push(persistableResult(result));
			onEvent?.({ type: "tool_end", result });
			i++;
			continue;
		}
		// Maximal run of consecutive safe calls → one sliding-window chunk.
		const run: ToolCallRef[] = [];
		while (i < toolCalls.length && isSafe((toolCalls[i] as ToolCallRef).name)) {
			run.push(toolCalls[i] as ToolCallRef);
			i++;
		}
		await executeChunk(run, toolMap, signal, onToolCall, onEvent, results, clock, grace);
	}
}

/** A plan is either an immediate result (validation/gate refusal — no execution)
 *  or an approved, unstarted execution. */
type ChunkPlan = { run: (signal: AbortSignal | undefined) => Promise<ToolResult> } | { result: ToolResult };

/** A chunk is the WHOLE maximal run of consecutive concurrency-safe calls
 *  (#sliding-window; waves retired). Three phases:
 *
 *  1. Serial, in call order: tool_start, validation, gate. Gates see a
 *     deterministic, non-interleaved sequence instead of racing under
 *     Promise.all. Every call of the run gets its tool_start here — queued
 *     calls are visible from the start (the display marks them queued until
 *     their tool_running arrives).
 *  2. Sliding window: min(cap, runnable) workers claim calls from a shared
 *     FIFO head — claim order is call order BY CONSTRUCTION (the synchronous
 *     head++ loop), never a completion-order refill. Each claim emits
 *     tool_running BEFORE plan.run (stamp ordering, see the event doc),
 *     measures its own durationMs at settle, and emits tool_settled.
 *  3. Prefix flush: a cursor emits tool_end/results for the longest settled
 *     CALL-ORDER prefix as soon as any settle advances it — deterministic
 *     order regardless of completion timing, without waiting for the whole
 *     run (a straggler blocks only its own suffix's tool_end, never the
 *     settled display updates).
 *
 * Abort: workers stop claiming at the head (unclaimed queued calls get no
 * events and are closed by fillMissingToolResults as a call-order suffix);
 * already-claimed calls settle via their AbortSignal (existing semantics).
 * The post-Promise.all flush drains any settled-but-unflushed prefix so a
 * killed run never drops computed events. */
async function executeChunk(
	chunk: ToolCallRef[],
	toolMap: Map<string, Tool>,
	signal: AbortSignal | undefined,
	onToolCall: RunAgentLoopOptions["onToolCall"],
	onEvent: RunAgentLoopOptions["onEvent"],
	results: ToolResult[],
	clock: () => number,
	grace: ReturnType<typeof createGraceRegistry>,
): Promise<void> {
	// Phase 1 — serial, in call order: tool_start, validation, gate. Gates see
	// a deterministic, non-interleaved sequence instead of racing under Promise.all.
	const plans: ChunkPlan[] = [];
	for (const call of chunk) {
		if (signal?.aborted) return; // not started: no events; fillMissing closes
		onEvent?.({ type: "tool_start", toolCallId: call.id, name: call.name, args: call.arguments });
		const prepared = prepareToolCall(call, toolMap);
		if ("result" in prepared) {
			plans.push(prepared);
			continue;
		}
		const decision = await onToolCall?.({
			toolCallId: call.id,
			name: call.name,
			args: call.arguments as Record<string, unknown>,
		});
		if (decision?.block) {
			plans.push({
				result: {
					toolCallId: call.id,
					toolName: call.name,
					content: `Tool "${call.name}" blocked by ${blockSource(decision)}: ${decision.reason ?? "no reason given"}`,
					isError: true,
				},
			});
		} else {
			plans.push(prepared);
		}
	}
	if (signal?.aborted) return; // approved, never executed: fillMissing closes
	// Per-index settle slots. Refusals (validation/gate) are settled NOW: they
	// never ran, occupy no window slot, and emit no tool_running/tool_settled.
	const settled: Array<ToolResult | undefined> = plans.map((plan) =>
		"result" in plan ? plan.result : undefined,
	);
	// Phase 3 — prefix flush: emit the longest settled call-order prefix. Any
	// settle (and the final drain below) advances it; a settled-but-unemitted
	// result can never be dropped.
	let cursor = 0;
	const flush = (): void => {
		while (cursor < settled.length && settled[cursor] !== undefined) {
			const result = settled[cursor] as ToolResult;
			cursor++;
			results.push(persistableResult(result));
			onEvent?.({ type: "tool_end", result });
		}
	};
	flush(); // leading refusals close immediately
	// Phase 2 — sliding window. Workers claim from the shared FIFO head in
	// call order; up to cap run at any moment (safety: each claim follows a
	// settle or an initial slot, so in-flight ≤ cap holds by induction).
	const runnable = plans
		.map((plan, index) => ({ plan, index }))
		.filter(
			(entry): entry is { plan: Extract<ChunkPlan, { run: unknown }>; index: number } => "run" in entry.plan,
		);
	let head = 0;
	const worker = async (): Promise<void> => {
		while (head < runnable.length) {
			if (signal?.aborted) return; // queued, never claimed: no events; fillMissing closes
			const { plan, index } = runnable[head++] as {
				plan: { run: (s: AbortSignal | undefined) => Promise<ToolResult> };
				index: number;
			};
			// Stamp ordering (#sliding-window MINOR-2): tool_running must reach
			// observers BEFORE the execution starts — the display rewrites the
			// row's startedAtMs from it, and child rows inherit that stamp.
			onEvent?.({ type: "tool_running", toolCallId: chunk[index]?.id as string });
			const startedAt = clock();
			// #abort-grace: race the execution against its grace deferred —
			// after an abort, a signal-ignoring tool is abandoned at the
			// deadline and the synthesized result flows the exact same path
			// (single writer: this worker). toolCallId is stamped here (the
			// registry is name-only; the object identity is stable).
			const result = await grace.race(plan.run(signal), chunk[index]?.name as string);
			const stamped = { ...result, toolCallId: chunk[index]?.id as string };
			// #tool-settle: own execution time (queue wait excluded by
			// construction) + real-time completion display; the authoritative
			// tool_end still follows via the prefix flush in call order.
			const measured: ToolResult = { ...stamped, durationMs: clock() - startedAt };
			settled[index] = measured;
			onEvent?.({ type: "tool_settled", result: measured });
			flush();
		}
	};
	const workers = Array.from({ length: Math.min(MAX_CONCURRENT_SAFE_CALLS, runnable.length) }, () =>
		worker(),
	);
	// runTool never rejects (it catches everything), so a rejection here can
	// only come from a throwing onEvent observer (tool-settle design §6.10's
	// exposure). Wider than the pre-window Promise.all in one way: sibling
	// workers keep claiming and flushing AFTER the first throw escapes this
	// function — the cursor prevents duplicate emissions, but late settles can
	// still push into `results` after the caller has seen the rejection. No
	// caller reads `results` on that path today (the loop aborts the turn);
	// recorded rather than guarded (a `broken` flag would only stop display
	// updates, not the semantic abort already in flight).
	try {
		await Promise.all(workers);
	} finally {
		flush(); // settled-but-unflushed prefix (abort path included)
	}
}

/** History-shaped result (prompt-audit P1): display is render-only and
 *  must not reach history — the session persists results verbatim and resume
 *  replay would resurrect a display string no renderer set. Events keep it.
 *  SA-03 taskRecord is the deliberate opposite: program metadata that MUST
 *  reach history — the spread below keeps it while removing display. */
function persistableResult(result: ToolResult): ToolResult {
	if (result.display === undefined && result.durationMs === undefined) return result;
	// #tool-settle: `durationMs` shares `display`'s lifecycle — events only.
	const { display: _display, durationMs: _durationMs, ...rest } = result;
	return rest;
}

/** Validation without side effects: unknown tool / non-object args / schema
 *  check → immediate error result; otherwise a deferred execution. Shared by
 *  the serial path (executeToolCall) and chunk planning. */
function prepareToolCall(call: ToolCallRef, toolMap: Map<string, Tool>): ChunkPlan {
	const tool = toolMap.get(call.name);
	if (!tool) {
		return {
			result: {
				toolCallId: call.id,
				toolName: call.name,
				content: `Error: unknown tool "${call.name}". Available tools: ${[...toolMap.keys()].join(", ")}.`,
				isError: true,
			},
		};
	}
	const record = call.arguments as Record<string, unknown>;
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		return {
			result: {
				toolCallId: call.id,
				toolName: call.name,
				content: `Error: tool arguments must be a JSON object, got: ${JSON.stringify(call.arguments)?.slice(0, 200)}`,
				isError: true,
			},
		};
	}
	if (!Value.Check(tool.parameters, record)) {
		const issues = [...Value.Errors(tool.parameters, record)]
			.slice(0, 5)
			.map((e) => `${(e as { instancePath?: string }).instancePath || "(root)"}: ${e.message}`)
			.join("; ");
		return {
			result: {
				toolCallId: call.id,
				toolName: call.name,
				content: `Error: invalid arguments for ${call.name} — ${issues}. Fix the arguments and retry.`,
				isError: true,
			},
		};
	}
	return {
		run: (signal: AbortSignal | undefined) => runTool(call, tool, record, signal),
	};
}

async function runTool(
	call: ToolCallRef,
	tool: Tool,
	record: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	try {
		const result = await tool.execute(record, signal ?? new AbortController().signal, {
			toolCallId: call.id,
		});
		return {
			toolCallId: call.id,
			toolName: call.name,
			// M13: tools that produce structured blocks (read's image path)
			// hand the model the blocks; `output` is display-only.
			content: result.content ?? result.output,
			isError: result.isError ?? false,
			display: result.display,
			// SA-03: explicit forwarding — the projection below drops unknown
			// fields, so the task record must be copied by name.
			taskRecord: result.taskRecord,
		};
	} catch (err) {
		return {
			toolCallId: call.id,
			toolName: call.name,
			content: `Error: tool ${call.name} threw: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
}

async function executeToolCall(
	id: string,
	name: string,
	args: unknown,
	toolMap: Map<string, Tool>,
	signal: AbortSignal | undefined,
	onToolCall: RunAgentLoopOptions["onToolCall"],
	grace: ReturnType<typeof createGraceRegistry>,
): Promise<ToolResult> {
	const call: ToolCallRef = { id, name, arguments: args };
	const prepared = prepareToolCall(call, toolMap);
	if ("result" in prepared) return prepared.result;

	// The gate (M4c design §8.3): post-validation, pre-execute, so handlers see
	// exactly what the tool will see. A block is a normal error result — it flows
	// through results.push → onMessage → session persistence, so the refusal is
	// resumable history and the run continues.
	const decision = await onToolCall?.({ toolCallId: id, name, args: args as Record<string, unknown> });
	if (decision?.block) {
		return {
			toolCallId: id,
			toolName: name,
			content: `Tool "${name}" blocked by ${blockSource(decision)}: ${decision.reason ?? "no reason given"}`,
			isError: true,
		};
	}
	// #abort-grace: the race covers ONLY the execution (design §2.5 — the gate
	// await above stays outside, matching the chunk's phase-1 scope decision).
	// Stamp the id: the grace result is synthesized name-only.
	const result = await grace.race(prepared.run(signal), name);
	return { ...result, toolCallId: id };
}
