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
 * Dogfood report 2026-09-27 (verified real): a subagent's bash tool ran a
 * command whose GRANDCHILD kept the stdio pipes open; the first Esc aborted
 * the controllers (the direct child died) but the tool promise never settled
 * (close waits for every pipe holder) — the UI sat on the task row and the
 * first Esc LOOKED dead. The second Esc hit the still-running state with
 * interruptCount=1 → forceExit(130): the whole REPL quit.
 *
 * Pin of the CURRENT behavior (witness, not endorsement): esc1 interrupts,
 * the run stays wedged on the grandchild, esc2 force-exits with 130. When
 * the wedging is fixed, this test should be tightened to the fixed contract.
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
		// First Esc: the interrupt note appears, but the run stays wedged —
		// the grandchild holds the pipes, the tool never settles
		terminal.data("\x1b");
		let sawNote = false;
		for (let i = 0; i < 20; i++) {
			await sleep(50);
			if (terminal.frameSince(0).includes("press Ctrl+C again to force quit")) {
				sawNote = true;
				break;
			}
		}
		expect(sawNote).toBe(true);
		expect(exitCodes).toEqual([]); // nothing exited yet
		// Second Esc while the run is still wedged: force exit 130 (current
		// behavior — the "whole REPL quits" dogfood report)
		let threw: string | null = null;
		try {
			terminal.data("\x1b");
			await settle(300);
		} catch (err) {
			threw = String(err);
		}
		expect(exitCodes).toEqual([130]);
		if (threw !== null) expect(threw).toContain("force-exit:130");
	}, 30000);
});
