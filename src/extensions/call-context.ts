/**
 * #guardian-auto-mode (design D15/D33): the per-call facts a `classify` call
 * may rely on — frozen at the tool gate and carried to the extension dispatch
 * through AsyncLocalStorage.
 *
 * The chain is `run → tool call → handler → classify`, one snapshot per call:
 * two children with the same agent and cwd cannot cross-contaminate, and a
 * handler that calls `classify` *after* returning (detached from its
 * dispatch) finds no store — the seam must then fall back to asking the
 * human. There is deliberately no shared "current run" variable.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { GateDecisionEvent, HumanRecordEntry } from "./user-input-log.js";

export interface ToolCallContext {
	/** The tool call this dispatch belongs to. */
	callId: string;
	/** True when the emitting run is a subagent (task tool child). */
	subagent: boolean;
	/** The child's agent profile name, when it has one. */
	agent?: string;
	/** The loop's working directory (worktree path under isolation). */
	cwd?: string;
	/** §16/D33: the tool name and the host-computed call identity
	 *  (`<tool> @ <JSON cwd> <JSON call text>`) — the gate-decision record's
	 *  per-call identity, display/equality text; never extension-authored. */
	tool: string;
	callIdentity: string;
	/** Copy of the verified submission log, frozen at gate entry (D11). */
	userInputs: readonly HumanRecordEntry[];
	/** Copy of the gate-decision log, frozen at gate entry (§16/D33). */
	decisions: readonly GateDecisionEvent[];
	/** §16/D34: the child's work order (task prompt), subagent calls only —
	 *  scope context for the classifier, never authorization. */
	workOrder?: string;
}

const storage = new AsyncLocalStorage<ToolCallContext>();

export function runWithToolCallContext<T>(context: ToolCallContext, fn: () => T): T {
	return storage.run(context, fn);
}

export function currentToolCallContext(): ToolCallContext | undefined {
	return storage.getStore();
}
