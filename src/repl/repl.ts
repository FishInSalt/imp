import type { Readable } from "node:stream";
import type { AgentEvent, RunAgentLoopResult } from "../core/loop.js";
import type { AgentMessage } from "../core/messages.js";
import type { RegisteredExtensionCommand } from "../extensions/types.js";
import { VERSION } from "../format.js";
import type { Runner } from "../runner.js";
import type { CommandContext } from "./commands.js";
import { dispatchCommand, parseCommand } from "./commands.js";
import type { ReplOutput } from "./input.js";
import { ReplInput } from "./input.js";
import type { Renderer } from "./render.js";

export interface ReplOptions {
	runner: Runner;
	/** Extension slash commands, already registered as data (M4b design §8.2):
	 *  cli.ts passes loadExtensions' runtime.commands here. */
	commands?: readonly RegisteredExtensionCommand[];
	input?: Readable; // default process.stdin
	output?: ReplOutput; // default process.stdout
	interactive?: boolean; // default: stdin && stdout TTY
	exit?: (code: number) => never; // default process.exit; injected in tests
}

type ReplState = "idle" | "running" | "compacting" | "exited";

/** Queued/steering display: cap at 80 chars, ellipsis when truncated. */
function shorten(text: string): string {
	return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

interface ReplMachineOptions {
	runner: Runner;
	/** Extension commands (M4b): forwarded to dispatchCommand at the single dispatch site. */
	commands: readonly RegisteredExtensionCommand[];
	renderer: Renderer;
	input: ReplInput;
	interactive: boolean;
	exit: (code: number) => never;
	finish: (code: number) => void;
}

/**
 * The REPL state machine (idle / running / compacting / exited).
 *
 * One persistent line handler routes by state; runs are fire-and-forget
 * promises whose settle path returns to idle, flushes leftover steering, or
 * exits when EOF/an exit request is pending. Double Ctrl+C force-exits
 * through `exit()` — never awaiting a possibly-hung tool.
 */
class ReplMachine {
	private state: ReplState = "idle";
	private queue: string[] = [];
	private controller: AbortController | null = null;
	private interruptCount = 0;
	private pendingExitCode: number | null = null;
	private eofPending = false;
	private receivedLine = false;
	private readonly runner: Runner;
	private readonly commands: readonly RegisteredExtensionCommand[];
	private readonly renderer: Renderer;
	private readonly input: ReplInput;
	private readonly interactive: boolean;
	private readonly exit: (code: number) => never;
	private readonly finish: (code: number) => void;

	constructor(options: ReplMachineOptions) {
		this.runner = options.runner;
		this.commands = options.commands;
		this.renderer = options.renderer;
		this.input = options.input;
		this.interactive = options.interactive;
		this.exit = options.exit;
		this.finish = options.finish;
	}

	handleLine(line: string): void {
		if (this.state === "exited") return;
		this.receivedLine = true;
		this.interruptCount = 0; // an accepted line resets the double-Ctrl+C counter
		if (line.trim() === "") {
			this.input.refresh();
			return;
		}
		const command = parseCommand(line);
		if (command) {
			void this.runCommand(line, command.name);
			return;
		}
		if (this.state === "idle") {
			void this.submitTurn(line);
			return;
		}
		this.queue.push(line);
		if (this.interactive) this.renderer.note(`▪ queued: ${shorten(line)}`);
		this.input.refresh();
	}

	handleInterrupt(): void {
		if (this.state === "exited") return;
		switch (this.state) {
			case "idle": {
				// typed-but-unsubmitted text is discarded, not counted as a quit gesture
				if (this.input.clearPending()) return;
				this.interruptCount++;
				if (this.interruptCount === 1) {
					this.renderer.note("(press Ctrl+C again to quit — /exit or Ctrl+D also work)");
				} else {
					this.gracefulExit(130);
				}
				return;
			}
			case "running": {
				this.interruptCount++;
				if (this.interruptCount === 1) {
					this.controller?.abort();
					this.renderer.note("(interrupt — press Ctrl+C again to force quit)");
				} else {
					this.forceExit(130);
				}
				return;
			}
			case "compacting": {
				this.interruptCount++;
				if (this.interruptCount === 1) {
					this.renderer.note("(compacting — press Ctrl+C again to force quit)");
				} else {
					this.forceExit(130);
				}
				return;
			}
		}
	}

	handleEof(): void {
		if (this.state === "exited") return;
		if (!this.receivedLine && !this.interactive) {
			// zero-line piped stdin ("forgot -p"): cli prints HELP for exit code 1.
			// On a real TTY, Ctrl+D with nothing typed is just a graceful exit.
			this.state = "exited";
			this.finish(1);
			return;
		}
		if (this.state === "idle") {
			this.gracefulExit(0);
			return;
		}
		this.eofPending = true; // exit after the active run/compaction settles
	}

	private async runCommand(line: string, name: string): Promise<void> {
		// Scripted mode defers session/banners to the first accepted line; a
		// failed warmup (bad -r id) must surface as a clean error, never an
		// unhandled rejection — so it runs inside the guarded region.
		try {
			this.runner.warmup();
		} catch (err) {
			this.reportError(err);
			return;
		}
		// Manual /compact runs in its own state so Ctrl+C gets the right hint
		// and /new / /compact can refuse while it is in flight.
		const manualCompact = name === "compact" && this.state === "idle" && this.runner.session !== null;
		if (manualCompact) {
			this.state = "compacting";
			this.input.setActive(true);
		}
		try {
			// authorizedCompact: this dispatch IS the authorized compact — the
			// state was pre-set to "compacting" for Ctrl+C hints and /new refusal,
			// which must not make dispatchCommand's isActive() guard reject it.
			// Any OTHER line arriving while compacting still sees isActive() true.
			// Extension commands ride the same path with identical semantics (M4b).
			await dispatchCommand(line, this.commandContext(manualCompact), this.commands);
		} catch (err) {
			this.reportError(err);
		} finally {
			if (manualCompact && this.state === "compacting") {
				this.interruptCount = 0;
				await this.flushQueue(); // queued lines drain as after a run (§5.2)
			}
		}
	}

	private async submitTurn(line: string): Promise<void> {
		if (this.state === "exited") return;
		this.state = "running";
		this.input.setActive(true);
		const controller = new AbortController();
		this.controller = controller;
		try {
			this.runner.warmup(); // deferred init for scripted mode; guarded like the rest
			const result = await this.runner.runTurn({
				userMessage: line,
				signal: controller.signal,
				onEvent: (event: AgentEvent) => this.renderer.event(event),
				getSteeringMessages: () => this.steeringMessages(),
			});
			await this.settleSuccess(result);
		} catch (err) {
			this.settleFailure(err);
		}
	}

	private steeringMessages(): AgentMessage[] {
		const [next, ...rest] = this.queue;
		this.queue = rest;
		if (next === undefined) return [];
		this.renderer.note(`▪ steering: ${shorten(next)}`);
		return [{ role: "user", content: next }];
	}

	private async settleSuccess(result: RunAgentLoopResult): Promise<void> {
		this.controller = null;
		this.interruptCount = 0;
		if (this.state === "exited") return;
		this.renderer.endRun();
		this.runner.printRunStats(result);
		this.runner.printSessionStats();
		if (result.stopReason === "aborted") {
			// the user pressed Ctrl+C to take control — queued lines are not run
			this.discardQueue();
			this.returnToIdle();
			return;
		}
		await this.flushQueue();
	}

	private settleFailure(err: unknown): void {
		this.controller = null;
		this.interruptCount = 0;
		if (this.state === "exited") return;
		this.renderer.endRun();
		// Defensive: an AbortError racing the settle path is a user interrupt,
		// not a provider failure (the provider should already have ended the
		// stream cleanly — see abortSafe in anthropic.ts).
		if (err instanceof Error && err.name === "AbortError") {
			this.renderer.note("(aborted)");
			this.discardQueue();
			this.returnToIdle();
			return;
		}
		this.reportError(err);
		// Mid-run failures keep every completed tool result in the session — the
		// next message resumes from the break. Users assume the whole turn was
		// lost otherwise (dogfood report 2026-09-01: 6 tool results survived,
		// the user just wasn't told they could type 继续).
		this.renderer.note(
			"completed work from this turn is saved in the session — send another message (e.g. \"继续\") to resume from the break",
		);
		this.discardQueue();
		this.returnToIdle();
	}

	private async flushQueue(): Promise<void> {
		if (this.pendingExitCode !== null) {
			this.returnToIdle();
			return;
		}
		const [next, ...rest] = this.queue;
		if (next === undefined) {
			this.returnToIdle();
			return;
		}
		this.queue = rest;
		this.renderer.note(`▪ continuing with queued: ${shorten(next)}`);
		await this.submitTurn(next);
	}

	private returnToIdle(): void {
		if (this.state === "exited") return;
		if (this.pendingExitCode !== null) {
			const code = this.pendingExitCode;
			this.pendingExitCode = null;
			this.gracefulExit(code);
			return;
		}
		if (this.eofPending) {
			this.gracefulExit(0);
			return;
		}
		this.state = "idle";
		this.input.setActive(false); // shows "> "
	}

	private discardQueue(): void {
		if (this.queue.length === 0) return;
		this.renderer.note(`▪ discarded ${this.queue.length} queued line(s)`);
		this.queue = [];
	}

	private requestExit(code: number): void {
		if (this.state === "idle") {
			this.gracefulExit(code);
			return;
		}
		this.pendingExitCode = code; // exits when the active phase settles
		this.controller?.abort();
	}

	private gracefulExit(code: number): void {
		if (this.state === "exited") return;
		this.state = "exited";
		const session = this.runner.session;
		if (session) {
			const id8 = session.header.id.slice(0, 8);
			this.renderer.note(`▪ session ${id8} saved — resume with: imp -r ${id8}`);
		} else {
			this.renderer.note("▪ bye");
		}
		this.finish(code);
	}

	private forceExit(code: number): void {
		if (this.state === "exited") return;
		this.state = "exited";
		// Close dangling tool_use in the session so a force-quit run stays
		// resumable (single Ctrl+C is handled by the loop; this is the 130 path).
		this.runner.persistMissingToolResults("(force quit before this tool ran)");
		try {
			this.exit(code); // process.exit in production
		} catch {
			// injected test exit threw its sentinel — resolve the loop below
		}
		this.finish(code);
	}

	private reportError(err: unknown): void {
		this.renderer.error(`imp: ${err instanceof Error ? err.message : String(err)}`);
	}

	private commandContext(authorizedCompact = false): CommandContext {
		return {
			runner: this.runner,
			renderer: this.renderer,
			isActive: () => !authorizedCompact && (this.state === "running" || this.state === "compacting"),
			requestExit: (code: number) => this.requestExit(code),
			abortActive: () => {
				if (this.controller !== null) {
					this.controller.abort();
					return true;
				}
				return false;
			},
		};
	}
}

/**
 * Runs the interactive REPL. Resolves with the exit code on graceful exits
 * (0/130, zero-line stdin ⇒ 1); force exits go through the injected `exit`
 * (default process.exit) and resolve the same code without awaiting the run.
 */
export async function runRepl(options: ReplOptions): Promise<number> {
	const stdin = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const interactive =
		options.interactive ?? ((stdin as { isTTY?: boolean }).isTTY === true && output.isTTY === true);
	const runner = options.runner;
	const renderer = runner.renderer; // one renderer, one newline state, shared with the runner

	let resolveDone!: (code: number) => void;
	const done = new Promise<number>((resolve) => {
		resolveDone = resolve;
	});
	let doneResolved = false;
	const finish = (code: number): void => {
		if (doneResolved) return;
		doneResolved = true;
		input.close();
		resolveDone(code);
	};

	let machine: ReplMachine;
	const input = new ReplInput({
		input: stdin,
		output,
		interactive,
		onLine: (line) => machine.handleLine(line),
		onInterrupt: () => machine.handleInterrupt(),
		onEof: () => machine.handleEof(),
	});
	machine = new ReplMachine({
		runner,
		commands: options.commands ?? [],
		renderer,
		input,
		interactive,
		exit: options.exit ?? ((code: number) => process.exit(code)),
		finish,
	});

	input.start();
	if (interactive) {
		renderer.writeLine(`imp ${VERSION} — /help for commands · Ctrl+D exits`);
		const session = runner.session;
		if (session) renderer.note(`▪ session ${session.header.id.slice(0, 8)} · model ${runner.model}`);
		input.refresh(); // banner block ends with a fresh idle prompt
	}
	return done;
}
