/**
 * #bash-abort regression pins (design docs/design/bash-abort-design.md §6).
 * Real process trees — no child_process mocks.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		// silently for at most 5s → the 100ms idle grace must release us first.
		const result = (await execute(tool, `${ESCAPE} sleep 5 & disown; echo done`)) as {
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
		// Only this worker observes these markers in this test-owned directory.
		const fixtureDir = await mkdtemp(join(tmpdir(), "ink-bash-escapee-"));
		const stop = join(fixtureDir, "stop");
		const stopped = join(fixtureDir, "stopped");
		const worker = [
			"import os,time",
			"deadline = time.monotonic() + 5",
			"try:",
			'    while time.monotonic() < deadline and not os.path.exists("stop"):',
			'        print("spam", flush=True)',
			"        time.sleep(0.05)",
			"except BrokenPipeError:",
			"    pass",
			"finally:",
			'    with open("stopped", "w") as marker: marker.write("done")',
		].join("\n");
		try {
			const tool = createBashTool({ cwd: fixtureDir });
			const controller = new AbortController();
			// Parent exits at ~0.3s; the escapee writes every 50ms until stopped
			// (or its 5s crash-safety deadline). Abort at ~0.9s must finalize the
			// wait, not idle grace or the 2000ms cap (design D2 invariant).
			const pending = execute(
				tool,
				`${ESCAPE} python3 -c '${worker}' & sleep 0.3; echo parent-done; exit 0`,
				controller.signal,
			);
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await sleep(900); // parent long gone; idle timer re-arming under spam
			expect(settled).toBe(false);
			const t0 = Date.now();
			controller.abort();
			const result = (await Promise.race([
				pending,
				sleep(1500).then(() => {
					throw new Error("TOOL NEVER SETTLED");
				}),
			])) as { output: string };
			expect(Date.now() - t0).toBeLessThan(600);
			expect(result.output).toContain("command aborted by user");
			expect(result.output).toContain("parent-done");
			expect((result.output.match(/^spam$/gm) ?? []).length).toBeGreaterThan(10);
		} finally {
			// Cooperative shutdown even on assertion failure; no PID/name matching
			// or signals. Wait for the worker's acknowledgement before removing
			// only our two markers and their empty, owned directory.
			await writeFile(stop, "");
			const deadline = Date.now() + 6000;
			while (!existsSync(stopped) && Date.now() < deadline) await sleep(25);
			try {
				expect(existsSync(stopped)).toBe(true);
			} finally {
				await unlink(stop);
				if (existsSync(stopped)) await unlink(stopped);
				await rmdir(fixtureDir);
			}
		}
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
