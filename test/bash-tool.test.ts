/**
 * #bash-abort regression pins (design docs/bash-abort-design.md §6).
 * Real process trees — no child_process mocks.
 */

import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.js";

function execute(tool: ReturnType<typeof createBashTool>, command: string, signal?: AbortSignal) {
	return tool.execute({ command, timeout: undefined }, signal ?? new AbortController().signal);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pid is gone when signal 0 fails — poll until it is or the budget ends. */
async function waitForGone(pid: number, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		if (Date.now() > deadline) return false;
		await sleep(25);
	}
}

describe("#bash-abort: process-group kill + exit/idle wait", () => {
	it("1. abort settles a grandchild-held-pipe hang (the dogfood repro shape) and kills the group", async () => {
		const tool = createBashTool();
		const controller = new AbortController();
		// The grandchild keeps the pipes open; the shell blocks in wait —
		// with close-based waiting this NEVER settles (the original bug).
		const pending = execute(tool, "sleep 60 & wait", controller.signal);
		await sleep(400); // let both processes come up
		controller.abort();
		const result = await Promise.race([
			pending,
			sleep(3000).then(() => new Error("TOOL NEVER SETTLED") as unknown as { output: string }),
		]);
		expect((result as { output: string }).output).toContain("command aborted by user");
	}, 10000);

	it("2. timeout path kills the same tree (no leftover grandchild)", async () => {
		const tool = createBashTool();
		// find the grandchild's pid from inside the wrapper: print it, then hang
		const out = tool.execute(
			{ command: 'sleep 60 & echo "GC:$!"; wait', timeout: 1 },
			new AbortController().signal,
		);
		const result = (await out) as { output: string; isError: boolean };
		expect(result.isError).toBe(true);
		expect(result.output).toContain("timed out after 1s");
		const m = /GC:(\d+)/.exec(result.output);
		expect(m).not.toBeNull();
		// The grandchild must be dead (it was in the killed group).
		expect(await waitForGone(Number(m?.[1]), 2000)).toBe(true);
	}, 15000);

	it("3. abort fast-path: settle ≈ abort time (group SIGKILL, no TERM escalation)", async () => {
		const tool = createBashTool();
		const controller = new AbortController();
		const pending = execute(tool, "sleep 60 & wait", controller.signal);
		await sleep(400);
		const t0 = Date.now();
		controller.abort();
		await pending;
		// The old code waited KILL_GRACE_MS(2000) after SIGTERM before SIGKILL.
		// Group SIGKILL must settle far faster than that.
		expect(Date.now() - t0).toBeLessThan(1500);
	}, 10000);

	// macOS has no setsid(1) binary — the escapee is built with python's
	// os.setsid (same semantics: new session, own process group, out of the
	// tool's kill(-pid) reach). ESCAPE = "start <argv> detached like setsid".
	const ESCAPE = "python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])'";

	it("4a. setsid escapee (silent handle): exit + idle grace settles within the cap", async () => {
		const tool = createBashTool();
		const t0 = Date.now();
		// The shell exits immediately; the escaped grandchild holds the pipes
		// forever but writes nothing → the 100ms idle grace must release us.
		const result = (await execute(tool, `${ESCAPE} sleep 60 & disown; echo done`)) as {
			output: string;
		};
		expect(result.output).toContain("done");
		expect(Date.now() - t0).toBeLessThan(2000);
	}, 10000);

	it("4b. writing grandchild: idle grace re-arms, full output, no truncation", async () => {
		const tool = createBashTool();
		// Parent exits at ~0.3s; the writing grandchild keeps printing every
		// 50ms for ~1.5s (30 ticks, within the 2000ms absolute cap with
		// margin). The tool must NOT settle before the writer finishes, and
		// every tick must survive.
		const result = (await execute(
			tool,
			`${ESCAPE} sh -c 'i=0; while [ $i -lt 30 ]; do echo tick; i=$((i+1)); sleep 0.05; done' & sleep 0.3; echo parent-done`,
		)) as { output: string };
		expect(result.output).toContain("parent-done");
		const ticks = (result.output.match(/^tick$/gm) ?? []).length;
		expect(ticks).toBe(30);
	}, 10000);

	it("4c. continuously-writing escapee + abort → immediate finalize (abort-after-exit window)", async () => {
		const tool = createBashTool();
		const controller = new AbortController();
		// Parent exits fast; the escapee writes forever. Abort lands WELL
		// after the parent's exit — the wait must finalize at abort time, not
		// wait out the 2000ms cap (design D2 invariant, round-2 review F2).
		const pending = execute(
			tool,
			`${ESCAPE} sh -c 'while :; do echo spam; sleep 0.05; done' & sleep 0.3; echo parent-done`,
			controller.signal,
		);
		await sleep(900); // parent long gone; idle timer re-arming under spam
		const t0 = Date.now();
		controller.abort();
		const result = (await Promise.race([
			pending,
			sleep(1500).then(() => new Error("TOOL NEVER SETTLED") as unknown as { output: string }),
		])) as { output: string };
		expect(result.output).toContain("command aborted by user");
		expect(Date.now() - t0).toBeLessThan(600);
		// cleanup the escapee (it setsid'd out of the group — kill by name)
		const { exec } = await import("node:child_process");
		await new Promise<void>((resolve) =>
			exec("pkill -f 'echo spam' 2>/dev/null; pkill -f 'while :; do echo spam' 2>/dev/null || true", () =>
				resolve(),
			),
		);
	}, 10000);

	it("5. normal commands keep full output + exit code (regression guard)", async () => {
		const tool = createBashTool();
		const result = (await execute(tool, "echo hello; echo world >&2; exit 7")) as {
			output: string;
			exitCode: number;
			isError: boolean;
		};
		expect(result.output).toContain("hello");
		expect(result.output).toContain("world");
		expect(result.output).toContain("Exit code: 7");
		expect(result.exitCode).toBe(7);
		expect(result.isError).toBe(false);
	}, 10000);

	it("6. signal report survives (self-TERMed shell is reported)", async () => {
		const tool = createBashTool();
		// The shell kills ITSELF with SIGTERM mid-command — exit fires with
		// signal "SIGTERM", code null; the tool must report the signal.
		const result = (await execute(tool, "echo before; kill -TERM $$; sleep 60")) as {
			output: string;
			isError: boolean;
		};
		expect(result.output).toContain("before");
		expect(result.isError).toBe(true);
		expect(result.output).toContain("terminated by signal SIGTERM");
	}, 10000);
});
