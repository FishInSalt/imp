/**
 * #bash-abort hardening (2026-09-27 incident): killProcessTree must NEVER
 * turn invalid input into the POSIX broadcast kill(-1) — a sentinel passed
 * by a caller once SIGKILLed every process on the user's machine.
 * These pins run WITHOUT spawning anything dangerous: invalid pids must be
 * silent no-ops.
 */

import { describe, expect, it } from "vitest";
import { killProcessTree } from "../src/core/process-tree.js";

describe("#bash-abort: killProcessTree input hardening", () => {
	it("pid -1 (the broadcast sentinel) is a silent no-op", () => {
		// Before the guard this reached process.kill(1) then process.kill(-1)
		// = kill every signalable process. Now: rejected at the gate.
		expect(() => killProcessTree(-1)).not.toThrow();
	});
	it("pid 0 (own process group) is a silent no-op", () => {
		expect(() => killProcessTree(0)).not.toThrow();
	});
	it("non-integer and negative pids are silent no-ops", () => {
		expect(() => killProcessTree(-1234)).not.toThrow();
		expect(() => killProcessTree(Number.NaN)).not.toThrow();
		expect(() => killProcessTree(1.5)).not.toThrow();
	});
	it("a (very likely dead) valid pid is attempted without throwing", () => {
		// PID_MAX on macOS is 99998 by default — 99999999 is effectively
		// guaranteed unused; the ESRCH path must swallow it silently.
		expect(() => killProcessTree(99999999)).not.toThrow();
	});
});
