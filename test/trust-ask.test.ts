import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptSink } from "../src/repl/transcript.js";
import { askTrustViaTui } from "../src/repl/trust-ask.js";
import { StdinBuffer, type Terminal } from "../src/tui.js";

/** Mirrors the FakeTerminal in repl-tui.test.ts — that one is file-local. */
class AskTerminal implements Terminal {
	private buffer: StdinBuffer | null = null;
	readonly writes: string[] = [];

	start(onInput: (data: string) => void, _onResize: () => void): void {
		const buffer = new StdinBuffer();
		buffer.on("data", (sequence: string) => onInput(sequence));
		buffer.on("paste", (content: string) => onInput(`\x1b[200~${content}\x1b[201~`));
		this.buffer = buffer;
	}

	stopped = false;

	stop(): void {
		this.buffer = null;
		this.stopped = true;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	data(text: string): void {
		this.buffer?.process(text);
	}
}

function settle(ms = 30): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping OSC/C0 controls IS this helper's job
	return text.replace(/\[[0-9;?]*[A-Za-z]/g, "").replace(/\][^\x07]*\x07/g, "");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("askTrustViaTui (debt clearance: TUI picker, not readline)", () => {
	it("Enter on the first item answers yes — and the ask writes NOTHING to the transcript", async () => {
		const terminal = new AskTerminal();
		const transcript = new TranscriptSink();
		const dir = mkdtempSync(join(tmpdir(), "imp-ask-"));
		const asked = askTrustViaTui({ transcript, cwd: dir, resources: [".imp/commands"], terminal });
		await settle();
		expect(stripAnsi(terminal.writes.join(""))).toContain("Yes — trust and remember");
		expect(stripAnsi(terminal.writes.join(""))).toContain(".imp/commands");
		terminal.data("\r");
		await expect(asked).resolves.toBe("yes");
		expect(transcript.completedLines()).toEqual([]); // the ask leaves no transcript trace
	});

	it("(review P0) the ask settles BEFORE it returns — the terminal stop has run, so a successor shell cannot be undermined", async () => {
		const terminal = new AskTerminal();
		const asked = askTrustViaTui({
			transcript: new TranscriptSink(),
			cwd: "/tmp/x",
			resources: [".imp/extensions"],
			terminal,
		});
		await settle();
		terminal.data("\r");
		let stoppedAtResolve = false;
		await expect(
			asked.then(() => {
				stoppedAtResolve = terminal.stopped;
			}),
		).resolves.toBe(undefined);
		expect(stoppedAtResolve).toBe(true); // the 40ms delayed stop already ran
	});

	it("down + Enter answers no", async () => {
		const terminal = new AskTerminal();
		const asked = askTrustViaTui({
			transcript: new TranscriptSink(),
			cwd: "/tmp/x",
			resources: [".imp/extensions"],
			terminal,
		});
		await settle();
		terminal.data("\x1b[B\r");
		await expect(asked).resolves.toBe("no");
	});

	it("down, down + Enter answers session", async () => {
		const terminal = new AskTerminal();
		const asked = askTrustViaTui({
			transcript: new TranscriptSink(),
			cwd: "/tmp/x",
			resources: [".imp/agents"],
			terminal,
		});
		await settle();
		terminal.data("\x1b[B\x1b[B\r");
		await expect(asked).resolves.toBe("session");
	});

	it("Esc cancels to null — the dropped-terminal deny", async () => {
		const terminal = new AskTerminal();
		const asked = askTrustViaTui({
			transcript: new TranscriptSink(),
			cwd: "/tmp/x",
			resources: [".imp/extensions"],
			terminal,
		});
		await settle();
		terminal.data("\x1b");
		await expect(asked).resolves.toBe(null);
	});
});
