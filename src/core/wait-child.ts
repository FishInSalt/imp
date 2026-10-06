/**
 * #bash-abort (design docs/design/bash-abort-design.md rev3.1 D2): a child-process
 * wait that never hangs on inherited stdio handles.
 *
 * `close` waits for ALL pipe holders — a grandchild (wrapper script, npm's
 * node, ...) that inherited stdout/stderr keeps the pipes open forever, so a
 * close-based wait wedges the tool. This port of pi's waitForChildProcess
 * (utils/child-process.ts:49) differs from pi in two deliberate ways
 * (design D2, review round-2 F2):
 *
 * 1. it returns { code, signal } — Ink reports "terminated by signal X"
 *    (pi's helper drops the signal);
 * 2. an abort signal FINALIZES IMMEDIATELY, whether or not the child has
 *    exited — pi's unbounded idle re-arm would let a continuously-writing
 *    setsid escapee reproduce the original wedge on the abort path. The
 *    normal path keeps the idle re-arm but under an absolute cap.
 */

import type { Readable } from "node:stream";

export interface ChildExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/** Post-exit idle grace: streams quiet for this long after exit → finalize. */
export const EXIT_STDIO_GRACE_MS = 100;
/** Absolute post-exit cap (normal path only — abort finalizes immediately):
 *  a writing escapee may delay settle at most this long. */
export const MAX_POST_EXIT_MS = 2000;

export interface WaitForChildOptions {
	/** Abort/timeout: force-finalize the wait the moment it fires. */
	killSignal?: AbortSignal;
}

export function waitForChildProcess(
	child: { stdout: Readable | null; stderr: Readable | null } & NodeJS.EventEmitter,
	options: WaitForChildOptions = {},
): Promise<ChildExit> {
	return new Promise<ChildExit>((resolve) => {
		let settled = false;
		let exited = false;
		let exitInfo: ChildExit = { code: null, signal: null };
		let idleTimer: NodeJS.Timeout | undefined;
		let capTimer: NodeJS.Timeout | undefined;
		const stdoutEnded = child.stdout === null;
		const stderrEnded = child.stderr === null;
		let endedCount = (stdoutEnded ? 1 : 0) + (stderrEnded ? 1 : 0);

		const clearTimers = () => {
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			if (capTimer !== undefined) clearTimeout(capTimer);
			idleTimer = undefined;
			capTimer = undefined;
		};
		const cleanup = () => {
			clearTimers();
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStreamEnd);
			child.stderr?.removeListener("end", onStreamEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
			options.killSignal?.removeEventListener("abort", onAbort);
		};
		// The single finalize funnel (design R2-F4): every trigger — exit +
		// both streams ended, idle grace, absolute cap, abort, close (belt
		// and braces if it ever does fire) — first through this gate.
		const finalize = (info: ChildExit) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(info);
		};
		const armIdleTimer = () => {
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => finalize(exitInfo), EXIT_STDIO_GRACE_MS);
		};
		const maybeFinalizeAfterStreams = () => {
			if (exited && endedCount >= 2) finalize(exitInfo);
		};
		const onData = () => {
			// Output still arriving after exit: defer finalizing so we don't
			// destroy the stream mid-write and truncate the tail (pi#5303).
			if (exited) armIdleTimer();
		};
		const onStreamEnd = () => {
			endedCount++;
			maybeFinalizeAfterStreams();
		};
		const onError = () => {
			finalize({ code: null, signal: null });
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			exited = true;
			exitInfo = { code, signal };
			maybeFinalizeAfterStreams();
			if (!settled) {
				armIdleTimer();
				capTimer = setTimeout(() => finalize(exitInfo), MAX_POST_EXIT_MS);
			}
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			finalize({ code, signal });
		};
		// Design D2 invariant: abort resolves the wait IMMEDIATELY,
		// regardless of prior exit state (round-2 review F2 — the exit event
		// may never arrive, or may already have fired and the idle timer is
		// re-arming under a writing escapee).
		const onAbort = () => {
			finalize(exitInfo);
		};

		child.stdout?.once("end", onStreamEnd);
		child.stderr?.once("end", onStreamEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
		if (options.killSignal !== undefined) {
			if (options.killSignal.aborted) onAbort();
			else options.killSignal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
