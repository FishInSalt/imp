/**
 * #bash-abort (design docs/bash-abort-design.md rev3.1): process-tree kill
 * and detached-group bookkeeping for the bash tool.
 *
 * The bash tool spawns with detached:true (a fresh process group per
 * command), so abort/timeout can kill the WHOLE tree with one kill(-pid).
 * Detached groups survive the parent's exit by construction — the tracked
 * set lets gracefulExit/forceExit/print-mode teardown sweep them.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown (SIGHUP/SIGTERM/beforeExit — pi's pattern, utils/shell.ts:191).
 * The tool untracks in its finally; the set only ever holds live groups.
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

/** Best-effort sweep of every live detached group — call BEFORE an
 *  explicit process.exit (beforeExit does not fire there — design D3). */
export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/** Kill a process and all its descendants (cross-platform, pi utils/shell.ts:216).
 *  POSIX: the child was spawned detached, so -pid addresses its whole group.
 *  Windows: taskkill /F /T via System32 (never from PATH).
 *
 *  DEFENSIVE: pid must be a positive integer — kill(-1) is the POSIX
 *  BROADCAST ("every process I may signal") and killed a whole desktop in
 *  the 2026-09-27 incident. Invalid input is a no-op (2026-09-27 hardening). */
export function killProcessTree(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid
			// crashing Node. The helper exits on its own — no orphan risk (R3).
			child.once("error", () => {});
		} catch {
			// taskkill spawn itself failed — nothing more to do.
		}
		return;
	}
	// Group SIGKILL — no TERM escalation (D1: both pi and Claude Code
	// SIGKILL directly; abort semantics prefer a clean sweep over a graceful
	// exit nobody is waiting for).
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// ESRCH/EPERM: fall back to the direct child (pi parity).
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already dead — nothing to do.
		}
	}
}
