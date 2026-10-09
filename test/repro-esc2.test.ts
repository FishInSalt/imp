import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Renderer } from "../src/render.js";
import { runRepl } from "../src/repl/repl.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner } from "../src/runner.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";
import { FakeTerminal, settle } from "./login-dialog.helpers.js";

/** Contrast case: a NORMAL run (thinking/streaming) aborts cleanly — the
 *  settle path resets the machine to idle BEFORE a second Esc lands, so the
 *  second Esc is the FIRST idle interrupt (a note, not an exit). */
describe("esc semantics: clean-abort case", () => {
	it("esc1 aborts to idle; esc2 (idle) is a no-op; Ctrl+C x2 quits gracefully", async () => {
		const baseDir = await mkTempDirAsync("ink-repro-esc2-");
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
		// A faithful hold: like the real SDK fetch, the stream ENDS (cleanly,
		// no message_end) when the request signal aborts — unlike fakes.ts's
		// streamingProvider whose gate never listens to the signal.
		const provider = {
			name: "mock-hold-abort-aware",
			async *stream(request: never) {
				const sig = (request as { signal?: AbortSignal }).signal;
				const held = new Promise<void>((resolve) => {
					if (sig?.aborted) resolve();
					else sig?.addEventListener("abort", () => resolve(), { once: true });
				});
				yield { type: "text_delta", text: "partial" } as never;
				await held; // the abort releases the hold; clean end, no message_end
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
				throw new Error(`exit:${code}`);
			},
		});
		await settle(200);
		terminal.data("go\r");
		await settle(400); // mid-stream, held
		// esc1: interrupt — the stream aborts cleanly and the machine settles to idle
		terminal.data("\x1b");
		const markAfterEsc1 = terminal.writes.length;
		// the abort lands and the machine settles to idle: the esc-hint row
		// disappears (it only renders while active)
		let backToIdle = false;
		for (let i = 0; i < 40; i++) {
			await settle(50);
			if (!terminal.frameSince(markAfterEsc1).includes("(esc to interrupt")) {
				backToIdle = true;
				break;
			}
		}
		expect(backToIdle).toBe(true);
		expect(exitCodes).toEqual([]);
		// esc2: state is IDLE now — this is the FIRST idle interrupt: a note only
		await settle(200); // let the settle path fully finish before the next press
		terminal.data("\x1b");
		// In idle, Esc is an EDITING key (shell.ts gates the interrupt on
		// active || pendingAsks) — the second Esc is a pure no-op: no exit,
		// not even the idle quit-hint note.
		const markBeforeEsc2 = terminal.writes.length;
		terminal.data("\x1b");
		await settle(300);
		expect(exitCodes).toEqual([]); // no exit
		expect(terminal.frameSince(markBeforeEsc2).includes("quit")).toBe(false);
		// quitting from idle needs the real quit gesture: Ctrl+C twice —
		// a GRACEFUL exit (note + finish), not the forceExit path
		terminal.data("\x03");
		await settle(150);
		terminal.data("\x03");
		let sawBye = false;
		for (let i = 0; i < 30; i++) {
			await settle(50);
			if (terminal.frameSince(0).match(/▪ (bye|session)/) !== null) {
				sawBye = true;
				break;
			}
		}
		expect(sawBye).toBe(true);
		expect(exitCodes).toEqual([]); // graceful, not forced
	}, 20000);
});
