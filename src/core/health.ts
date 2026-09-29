import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { envInt } from "./compaction.js";
import type { AgentEvent } from "./loop.js";
import type { AssistantMessage, ToolResult } from "./messages.js";

/**
 * #loop-health (docs/loop-health-design.md): the shared, observation-only
 * loop health monitor. It consumes the existing AgentEvent stream
 * (message_end / tool_start / tool_end) at the call sites — runAgentLoop
 * itself gains no options and is behavior-unchanged without a monitor.
 *
 * v1 is detection only: no prompts, no aborts, no new terminal statuses.
 * The child engine records `signals()` into its outcome (task-result lines +
 * TaskRecord), and both loops relay first fires as live `health` events for
 * the interactive REPL notes. Owner decisions A/B (2026-09-29): no numeric
 * valve; no injection.
 */

export type HealthCode = "repeat-loop" | "mutation-failure-streak" | "tool-open" | "compaction-failures";

/** One detected condition. `count` is the peak observed run length for the
 *  condition (1 for tool-open); `turn` is the assistant `message_end` count
 *  since monitor creation — at first fire for the live emit, and moved
 *  together with count/detail when the peak grows (post-merge review finding
 *  3: stored facts never mix evidence from two batches). */
export interface HealthSignal {
	code: HealthCode;
	count: number;
	turn: number;
	/** Bounded single-line evidence (no newlines, ≤ HEALTH_DETAIL_MAX chars). */
	detail?: string;
}

export interface HealthThresholds {
	/** Consecutive byte-identical tool-call turns before `repeat-loop`. */
	repeatTurns: number;
	/** Failed edit/write results before `mutation-failure-streak`. */
	mutationFailures: number;
	/** Open-tool duration before `tool-open`. */
	toolOpenMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
	repeatTurns: 5,
	mutationFailures: 3,
	toolOpenMs: 600_000,
};

/** A failed mutation older than this gap resets the streak (pi's window). */
export const MUTATION_FAILURE_WINDOW_MS = 5 * 60_000;

/** Producer-side single-line evidence bound. */
export const HEALTH_DETAIL_MAX = 120;

/** Call-preview sub-bound inside `detail`. */
export const HEALTH_PREVIEW_MAX = 80;

/** `IMP_HEALTH` is parsed by the call sites as a plain string — deliberately
 *  NOT through `envInt`, whose `n <= 0` rule would classify "0" as invalid
 *  and fall back to enabled (design §4.1). */
export function healthEnabled(): boolean {
	return process.env.IMP_HEALTH !== "0";
}

export interface LoopHealthMonitor {
	/** Feed one observed loop event (message_end / tool_start / tool_end). */
	observe(event: AgentEvent): void;
	/** Engine-level fact (e.g. the child's compaction backstop). Valid before
	 *  any observe() call; `turn` reads as the turns observed so far (0). */
	note(code: HealthCode, count: number, detail?: string): void;
	/** Fired signals, deduped by code, first-fire order, ≤ one per code. */
	signals(): readonly HealthSignal[];
	/** Clears timers; idempotent. Callers MUST call this after the loop
	 *  settles on every path. Facts already recorded survive disposal. */
	dispose(): void;
}

export interface LoopHealthOptions {
	/** Explicit thresholds win over env overrides and defaults (tests). */
	thresholds?: Partial<HealthThresholds>;
	/** Live relay; called once per code (first fire only). */
	emit?: (signal: HealthSignal) => void;
}

/** First non-empty line, ellipsis past `max`. Local minimal formatter —
 *  the monitor must not drag presentation/REPL imports. */
function inline(text: string, max: number): string {
	const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function boundDetail(text: string): string {
	return inline(text, HEALTH_DETAIL_MAX);
}

/** One-line call preview: `bash "npm test"`, `edit src/a.ts`, else name +
 *  first line of canonical JSON. Never exceeds HEALTH_PREVIEW_MAX. */
function previewCall(name: string, args: unknown): string {
	const record =
		typeof args === "object" && args !== null && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: undefined;
	let text: string;
	if (name === "bash" && typeof record?.command === "string") {
		text = `bash "${inline(record.command, HEALTH_PREVIEW_MAX - 8)}"`;
	} else if ((name === "edit" || name === "write") && typeof record?.path === "string") {
		text = `${name} ${inline(record.path, HEALTH_PREVIEW_MAX - name.length - 1)}`;
	} else {
		text = `${name} ${inline(canonicalJson(args), HEALTH_PREVIEW_MAX - name.length - 1)}`;
	}
	return inline(text, HEALTH_PREVIEW_MAX);
}

function mutationPath(name: string, args: unknown): string | undefined {
	if (name !== "edit" && name !== "write") return undefined;
	const record =
		typeof args === "object" && args !== null && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: undefined;
	return typeof record?.path === "string" && record.path !== "" ? record.path : undefined;
}

function hashArgs(args: unknown): string {
	return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

/** `12s` / `10m05s` — the render.ts duration shape. */
function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

interface CallInfo {
	name: string;
	preview: string;
	path?: string;
}

export function createLoopHealth(options: LoopHealthOptions = {}): LoopHealthMonitor {
	const thresholds: HealthThresholds = {
		repeatTurns:
			options.thresholds?.repeatTurns ??
			envInt("IMP_HEALTH_REPEAT_TURNS", DEFAULT_HEALTH_THRESHOLDS.repeatTurns),
		mutationFailures:
			options.thresholds?.mutationFailures ??
			envInt("IMP_HEALTH_MUTATION_FAILURES", DEFAULT_HEALTH_THRESHOLDS.mutationFailures),
		toolOpenMs:
			options.thresholds?.toolOpenMs ??
			envInt("IMP_HEALTH_TOOL_OPEN_MS", DEFAULT_HEALTH_THRESHOLDS.toolOpenMs),
	};

	let disposed = false;
	/** Assistant message_end events observed since creation (design §4.2). */
	let observedTurns = 0;
	const fired: HealthSignal[] = [];
	const firedIndex = new Map<HealthCode, number>();
	const callInfo = new Map<string, CallInfo>();
	const openTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Repeat-loop state: consecutive identical per-turn call signatures.
	let lastSignature: string | undefined;
	let repeatRun = 0;
	// Mutation-failure state: failed edit/write results, windowed.
	let mutationStreak = 0;
	let lastMutationFailureAt: number | undefined;

	/** First fire per code wins: stores + emits once (the emit is a first-fire
	 *  snapshot); later growth updates the PEAK evidence in place — count,
	 *  turn and detail move together so persisted facts never mix two batches
	 *  (post-merge review finding 3). No re-emit. */
	function record(signal: HealthSignal): void {
		const existing = firedIndex.get(signal.code);
		if (existing === undefined) {
			firedIndex.set(signal.code, fired.length);
			fired.push(signal);
			options.emit?.({ ...signal });
			return;
		}
		const current = fired[existing];
		if (current !== undefined && signal.count > current.count) {
			current.count = signal.count;
			current.turn = signal.turn;
			if (signal.detail === undefined) delete current.detail;
			else current.detail = signal.detail;
		}
	}

	function observe(event: AgentEvent): void {
		if (disposed) return;
		try {
			if (event.type === "message_end") {
				onTurn(event.message);
				return;
			}
			if (event.type === "tool_start") {
				onToolStart(event.toolCallId, event.name);
				return;
			}
			if (event.type === "tool_end") {
				onToolEnd(event.result);
			}
		} catch {
			// #loop-health contract: the monitor must never affect the run — a
			// malformed event (e.g. cyclic tool args defeating canonicalJson)
			// degrades to "no signal". The timer path has the same guard.
		}
	}

	function onTurn(message: AssistantMessage): void {
		observedTurns++;
		const calls = message.blocks.filter(
			(b): b is Extract<AssistantMessage["blocks"][number], { type: "toolCall" }> => b.type === "toolCall",
		);
		for (const call of calls) {
			callInfo.set(call.id, {
				name: call.name,
				preview: previewCall(call.name, call.arguments),
				path: mutationPath(call.name, call.arguments),
			});
		}
		// A turn with no tool-call blocks has an empty signature and is never
		// a repeat candidate (design §4.2); it also breaks any run.
		if (calls.length === 0) {
			lastSignature = undefined;
			repeatRun = 0;
			return;
		}
		const signature = calls.map((call) => `${call.name}:${hashArgs(call.arguments)}`).join("|");
		repeatRun = signature === lastSignature ? repeatRun + 1 : 1;
		lastSignature = signature;
		if (repeatRun >= thresholds.repeatTurns) {
			const last = calls[calls.length - 1];
			if (last !== undefined) {
				record({
					code: "repeat-loop",
					count: repeatRun,
					turn: observedTurns,
					detail: previewCall(last.name, last.arguments),
				});
			}
		}
	}

	function onToolStart(toolCallId: string, name: string): void {
		const startedAt = Date.now();
		const preview = callInfo.get(toolCallId)?.preview ?? name;
		const timer = setTimeout(() => {
			if (disposed) return;
			try {
				record({
					code: "tool-open",
					count: 1,
					turn: observedTurns,
					detail: boundDetail(`${preview} was still open after ${formatElapsed(Date.now() - startedAt)}`),
				});
			} catch {
				// a health timer must never crash the run
			}
		}, thresholds.toolOpenMs);
		timer.unref?.();
		// A duplicate toolCallId must not orphan the earlier timer (SA-08 round 3
		// hardened the loop against duplicate ids; the monitor clears on overwrite).
		const prior = openTimers.get(toolCallId);
		if (prior !== undefined) clearTimeout(prior);
		openTimers.set(toolCallId, timer);
	}

	function onToolEnd(result: ToolResult): void {
		const timer = openTimers.get(result.toolCallId);
		if (timer !== undefined) {
			clearTimeout(timer);
			openTimers.delete(result.toolCallId);
		}
		const info = callInfo.get(result.toolCallId);
		callInfo.delete(result.toolCallId);
		if (result.toolName !== "edit" && result.toolName !== "write") return;
		if (!result.isError) {
			mutationStreak = 0;
			lastMutationFailureAt = undefined;
			return;
		}
		const now = Date.now();
		if (lastMutationFailureAt !== undefined && now - lastMutationFailureAt > MUTATION_FAILURE_WINDOW_MS) {
			mutationStreak = 0;
		}
		lastMutationFailureAt = now;
		mutationStreak++;
		if (mutationStreak >= thresholds.mutationFailures) {
			const detail =
				info?.path !== undefined && info.path !== ""
					? `${result.toolName} ${info.path}`
					: (info?.preview ?? result.toolName);
			record({
				code: "mutation-failure-streak",
				count: mutationStreak,
				turn: observedTurns,
				detail: boundDetail(detail),
			});
		}
	}

	function note(code: HealthCode, count: number, detail?: string): void {
		if (disposed) return;
		try {
			record({
				code,
				count,
				turn: observedTurns,
				...(detail !== undefined ? { detail: boundDetail(detail) } : {}),
			});
		} catch {
			// Same never-affect-the-run contract as observe().
		}
	}

	return {
		observe,
		note,
		signals: () => fired.map((signal) => ({ ...signal })),
		dispose(): void {
			if (disposed) return;
			disposed = true;
			for (const timer of openTimers.values()) clearTimeout(timer);
			openTimers.clear();
			callInfo.clear();
		},
	};
}

/** Human one-line form for result lines and REPL notes (shared shape,
 *  pinned by goldens). */
export function healthSignalText(signal: HealthSignal): string {
	switch (signal.code) {
		case "repeat-loop":
			return `repeated identical tool calls ×${signal.count} (last: ${signal.detail ?? "unknown"})`;
		case "mutation-failure-streak":
			return `${signal.count} consecutive failed edits (last: ${signal.detail ?? "unknown"})`;
		case "tool-open":
			return signal.detail ?? `a tool call stayed open too long`;
		case "compaction-failures":
			return `child compaction disabled after ${signal.count} summarizer failures`;
	}
}
