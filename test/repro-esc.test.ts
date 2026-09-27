import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assistant } from "./helpers/fakes.js";
import { FakeTerminal, settle } from "./login-dialog.helpers.js";
import { Renderer } from "../src/render.js";
import { createRunner } from "../src/runner.js";
import { runRepl } from "../src/repl/repl.js";
import { TranscriptSink } from "../src/repl/transcript.js";

/**
 * Dogfood report 2026-09-27 (verified real, then fixed by #bash-abort): a
 * subagent's bash tool ran a command whose GRANDCHILD kept the stdio pipes
 * open; the first Esc LOOKED dead (close-based wait never settled) and the
 * second Esc force-quit the whole REPL.
 *
 * Post-fix contract: the first Esc interrupts the whole process tree and
 * settles the run to idle within the deadline; the second Esc is an idle
 * no-op; quitting takes Ctrl+C x2 and is graceful. Mirrors the clean-abort
 * case (repro-esc2.test.ts).
 */
describe("repro: subagent bash hung by a grandchild (esc semantics)", () => {
	it("esc1 shows the interrupt note while the run is wedged; esc2 force-exits 130", async () => {
		const baseDir = await mkdtemp(path.join(tmpdir(), "imp-repro-esc-"));
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink();
		const renderer = new Renderer({
			write: transcript.feed,
			thinkingSink: transcript.thinkingSink,
			userSink: (t: string) => transcript.feedUser(t),
			statusSink: (t: string) => transcript.feedStatus(t),
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
			foldedResults: true,
		});
		let call = 0;
		const provider = {
			name: "mock",
			async *stream(request: never) {
				call++;
				if (call === 1) {
					// main agent delegates via task
					const msg = assistant(
						[
							{
								type: "toolCall",
								id: "tc1",
								name: "task",
								arguments: { prompt: "run a blocking command" },
							} as never,
						],
						"tool_use",
					);
					yield { type: "message_end", message: msg } as never;
				} else {
					// child agent calls bash with a command whose grandchild
					// (sleep 300) keeps the stdio pipes open — close never fires
					const msg = assistant(
						[
							{
								type: "toolCall",
								id: `tc${call}`,
								name: "bash",
								arguments: { command: "sleep 300 & wait" },
							} as never,
						],
						"tool_use",
					);
					yield { type: "message_end", message: msg } as never;
				}
			},
		};
		const exitCodes: number[] = [];
		const runner = await createRunner({
			cwd: baseDir,
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: true,
			sessionBaseDir: baseDir,
			settingsPath: path.join(baseDir, "settings.json"),
			renderer,
			provider,
			deferInit: false,
		});
		runRepl({
			runner,
			commands: [],
			shell: "tui",
			transcript,
			terminal,
			interactive: true,
			exit: (code: number) => {
				exitCodes.push(code);
				throw new Error(`force-exit:${code}`);
			},
		});
		await settle(200);
		terminal.data("go\r");
		// wait until the child's bash call is in flight (task activity row up)
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		let hung = false;
		for (let i = 0; i < 60; i++) {
			await sleep(50);
			if (terminal.frameSince(0).includes("sleep 300")) {
				hung = true;
				break;
			}
		}
		expect(hung).toBe(true);
		// FIXED CONTRACT (#bash-abort): the first Esc interrupts the whole
		// tree (group SIGKILL reaches the grandchild; the wait finalizes at
		// abort) — the run settles to idle WITHIN THE DEADLINE, no force exit.
		terminal.data("\x1b");
		const markAfterEsc1 = terminal.writes.length;
		let backToIdle = false;
		for (let i = 0; i < 60; i++) {
			await sleep(50);
			// The esc-hint row only renders while active: its reappearance in
			// INCREMENTAL frames after the interrupt = the run settled to idle.
			if (!terminal.frameSince(markAfterEsc1).includes("(esc to interrupt")) {
				backToIdle = true;
				break;
			}
		}
		expect(backToIdle).toBe(true);
		expect(exitCodes).toEqual([]); // the FIRST Esc settled it — no force exit
		// Second Esc in idle: an editing no-op, never an exit (parity with the
		// clean-abort case — repro-esc2.test.ts)
		terminal.data("\x1b");
		await sleep(300);
		expect(exitCodes).toEqual([]);
		// Quitting takes the real gesture: Ctrl+C twice — GRACEFUL (bye
		// note), never the force path
		terminal.data("\x03");
		await sleep(150);
		terminal.data("\x03");
		let sawBye = false;
		for (let i = 0; i < 30; i++) {
			await sleep(50);
			if (terminal.frameSince(0).match(/▪ (bye|session)/) !== null) {
				sawBye = true;
				break;
			}
		}
		expect(sawBye).toBe(true);
	}, 30000);
});
