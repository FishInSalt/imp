import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { LLMProvider } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { Fold } from "../src/repl/components/fold.js";
import { runRepl } from "../src/repl/repl.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner } from "../src/runner.js";
import { StdinBuffer, type Terminal, visibleWidth } from "../src/tui.js";
import { assistant, gate } from "./helpers/fakes.js";

/** Focused physical-screen interpreter, not a write log or a full VT emulator.
 * Models cursor addressing, erasure, bottom-edge scrolling and deferred wrap.
 * Resize clips/pads cells without reflow; the TUI must repaint at the new width.
 * Printable one/two-cell code points are supported, with blank continuation
 * cells for wide glyphs. Styling, titles, hyperlinks, cursor visibility and synchronized-output modes
 * have no cell effect. No scrollback, alternate screen, images, grapheme clusters,
 * combining characters, wide-cell partial overwrite repair, margins or terminal query replies are modeled.
 * Unknown escapes/control bytes fail rather than silently producing a false pass.
 */
class Screen {
	private cells: string[][];
	private x = 0;
	private y = 0;
	private pendingWrap = false;
	private carry = "";

	constructor(
		public columns: number,
		public rows: number,
	) {
		this.cells = Array.from({ length: rows }, () => this.blank());
	}

	private blank(): string[] {
		return Array<string>(this.columns).fill(" ");
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.cells = Array.from({ length: rows }, (_, i) =>
			Array.from({ length: columns }, (_, j) => this.cells[i]?.[j] ?? " "),
		);
		this.x = Math.min(this.x, columns - 1);
		this.y = Math.min(this.y, rows - 1);
		this.pendingWrap = false;
	}

	lines(): string[] {
		return this.cells.map((row) => row.join("").trimEnd());
	}

	private lineFeed(): void {
		if (this.y === this.rows - 1) {
			this.cells.shift();
			this.cells.push(this.blank());
		} else this.y++;
		this.pendingWrap = false;
	}

	write(chunk: string): void {
		const data = this.carry + chunk;
		this.carry = "";
		for (let i = 0; i < data.length; ) {
			if (data[i] === "\x1b") {
				const sequence = data.slice(i);
				if (sequence.startsWith("\x1b[")) {
					// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal control sequences
					const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(sequence);
					if (!match) {
						this.carry = sequence;
						return;
					}
					this.csi(match[1] ?? "", match[2] ?? "", match[3] ?? "");
					i += match[0].length;
					continue;
				}
				if (sequence.startsWith("\x1b]")) {
					// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal control sequences
					const match = /^\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(sequence);
					if (!match) {
						this.carry = sequence;
						return;
					}
					if (!match[1]?.startsWith("8;") && !match[1]?.startsWith("2;") && match[1] !== "11;?") {
						throw new Error(`Unsupported OSC: ${JSON.stringify(match[0])}`);
					}
					i += match[0].length;
					continue;
				}
				if (sequence.length === 1) {
					this.carry = sequence;
					return;
				}
				throw new Error(`Unsupported escape: ${JSON.stringify(sequence)}`);
			}
			const ch = String.fromCodePoint(data.codePointAt(i) ?? 0);
			i += ch.length;
			if (ch === "\r") {
				this.x = 0;
				this.pendingWrap = false;
			} else if (ch === "\n") this.lineFeed();
			else {
				const width = visibleWidth(ch);
				if (ch < " " || ch === "\x7f" || (width !== 1 && width !== 2)) {
					throw new Error(`Unsupported cell/control: ${JSON.stringify(ch)}`);
				}
				if (this.pendingWrap || this.x + width > this.columns) {
					this.x = 0;
					this.lineFeed();
				}
				const row = this.cells[this.y];
				if (!row) throw new Error("Cursor outside screen");
				row[this.x] = ch;
				if (width === 2) row[this.x + 1] = "";
				if (this.x + width === this.columns) {
					this.x = this.columns - 1;
					this.pendingWrap = true;
				} else this.x += width;
			}
		}
	}

	private csi(parameters: string, intermediate: string, command: string): void {
		const unsupported = () => {
			throw new Error(`Unsupported CSI: ${JSON.stringify([parameters, intermediate, command])}`);
		};
		if (intermediate !== "") unsupported();
		if (command === "m" && /^[\d;:]*$/.test(parameters)) return;
		if ((command === "h" || command === "l") && /^\?(25|2026|2031)$/.test(parameters)) return;
		if ((command === "t" && parameters === "16") || (command === "n" && parameters === "?996")) return;
		if (!/^[\d;]*$/.test(parameters)) unsupported();
		const parts = parameters.split(";").map(Number);
		const n = parts[0] || 1;
		this.pendingWrap = false;
		switch (command) {
			case "A":
				this.y = Math.max(0, this.y - n);
				break;
			case "B":
				this.y = Math.min(this.rows - 1, this.y + n);
				break;
			case "C":
				this.x = Math.min(this.columns - 1, this.x + n);
				break;
			case "D":
				this.x = Math.max(0, this.x - n);
				break;
			case "G":
				this.x = Math.min(this.columns - 1, n - 1);
				break;
			case "H":
			case "f":
				this.y = Math.min(this.rows - 1, n - 1);
				this.x = Math.min(this.columns - 1, (parts[1] || 1) - 1);
				break;
			case "K": {
				const mode = parts[0] ?? 0;
				if (![0, 1, 2].includes(mode)) unsupported();
				this.cells[this.y]?.fill(" ", mode === 0 ? this.x : 0, mode === 1 ? this.x + 1 : this.columns);
				break;
			}
			case "J": {
				const mode = parts[0] ?? 0;
				if (mode === 3) break; // scrollback is intentionally not retained
				if (![0, 1, 2].includes(mode)) unsupported();
				for (let row = 0; row < this.rows; row++) {
					if (mode === 2 || (mode === 0 && row > this.y) || (mode === 1 && row < this.y)) {
						this.cells[row] = this.blank();
					} else if (row === this.y) {
						this.cells[row]?.fill(" ", mode === 0 ? this.x : 0, mode === 1 ? this.x + 1 : this.columns);
					}
				}
				break;
			}
			case "S":
				for (let i = 0; i < Math.min(n, this.rows); i++) {
					this.cells.shift();
					this.cells.push(this.blank());
				}
				break;
			default:
				unsupported();
		}
	}
}

class ScreenTerminal implements Terminal {
	readonly screen = new Screen(64, 24);
	private input: StdinBuffer | null = null;
	private onResize: (() => void) | null = null;
	get columns(): number {
		return this.screen.columns;
	}
	get rows(): number {
		return this.screen.rows;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.input = new StdinBuffer();
		this.input.on("data", onInput);
		this.input.on("paste", (text: string) => onInput(`\x1b[200~${text}\x1b[201~`));
		this.onResize = onResize;
	}
	stop(): void {
		this.input = null;
		this.onResize = null;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.screen.write(data);
	}
	data(data: string): void {
		this.input?.process(data);
	}
	resize(columns: number, rows: number): void {
		this.screen.resize(columns, rows);
		this.onResize?.();
	}
	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[2K");
	}
	clearFromCursor(): void {
		this.write("\x1b[0J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(): void {}
	setProgress(): void {}
}

async function screenEventually(terminal: ScreenTerminal, check: (lines: string[]) => void): Promise<void> {
	await expect
		.poll(
			() => {
				check(terminal.screen.lines());
				return true;
			},
			{ timeout: 3000 },
		)
		.toBe(true);
}

it("the screen interpreter overwrites, erases, wraps, scrolls and rejects unsupported controls", () => {
	const screen = new Screen(5, 3);
	screen.write("abcdeX\r\nlast");
	expect(screen.lines()).toEqual(["abcde", "X", "last"]);
	screen.write("\r\nnew\x1b[1A\r\x1b[2Kold");
	expect(screen.lines()).toEqual(["X", "old", "new"]);
	screen.write("\x1b[1;2H!\x1b[0J");
	expect(screen.lines()).toEqual(["X!", "", ""]);
	screen.write("\x1b[2J\x1b[H12345\x1b[0mZ");
	expect(screen.lines()).toEqual(["12345", "Z", ""]);
	expect(() => screen.write("\x1b[?1049h")).toThrow("Unsupported CSI");
	expect(() => screen.write("\t")).toThrow("Unsupported cell/control");
});

it("Ctrl+T repaints a long physical screen during live thinking, including hidden append and resize", async () => {
	const baseDir = await mkdtemp(path.join(tmpdir(), "imp-thinking-screen-"));
	const thinkingGate = gate();
	const endGate = gate();
	let calls = 0;
	let appended = false;
	const provider: LLMProvider = {
		name: "screen-test",
		async *stream() {
			calls++;
			yield { type: "thinking_delta", text: "LIVE alpha beta gamma delta epsilon zeta eta theta iota kappa" };
			await thinkingGate.promise;
			yield { type: "thinking_delta", text: "\nHIDDEN append retained" };
			appended = true;
			await endGate.promise;
			yield { type: "message_end", message: assistant([]) };
		},
	};
	const terminal = new ScreenTerminal();
	const transcript = new TranscriptSink();
	const renderer = new Renderer({
		write: transcript.feed,
		thinkingSink: transcript.thinkingSink,
		userSink: (text) => transcript.feedUser(text),
		statusSink: (text) => transcript.feedStatus(text),
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
		markdown: false,
	});
	const runner = await createRunner({
		cwd: baseDir,
		argv: [],
		model: "test-model",
		maxTokens: 1024,
		maxTurns: 2,
		noContextFiles: true,
		noSession: true,
		sessionBaseDir: baseDir,
		settingsPath: path.join(baseDir, "settings.json"),
		renderer,
		provider,
		tools: [],
	});
	const repl = runRepl({ runner, commands: [], shell: "tui", transcript, terminal, interactive: true });
	try {
		await screenEventually(terminal, (lines) => expect(lines.join("\n")).toContain("/help for commands"));
		transcript.feed(Array.from({ length: 45 }, (_, i) => `history-${i}\n`).join(""));
		const prior = transcript.thinkingSink.begin();
		prior.append("PRIOR retained reasoning");
		prior.end();
		const fold = new Fold("tool summary", ["FOLD retained detail"], false);
		fold.setExpanded(true);
		transcript.appendChild(fold);
		terminal.data("go\r");
		await screenEventually(terminal, (lines) => expect(lines.join("\n")).toContain("LIVE alpha"));
		terminal.data("draft survives");
		const checkCommon = (lines: string[]) => {
			const text = lines.join("\n");
			expect(text.match(/FOLD retained detail/g)).toHaveLength(1);
			expect(text.match(/draft survives/g)).toHaveLength(1);
			expect(text).toContain("working…"); // the live activity row (label: #activity-working-label)
			expect(text).not.toContain("history-0\n");
			expect(fold.isExpanded()).toBe(true);
		};
		const checkHidden = (lines: string[]) => {
			checkCommon(lines);
			const text = lines.join("\n");
			expect(text.match(/Thinking\.\.\./g)).toHaveLength(2);
			expect(text).not.toMatch(/PRIOR|LIVE|HIDDEN|epsilon|kappa/);
			expect(text).toContain("Thinking blocks: hidden");
		};
		terminal.data("\x14");
		await screenEventually(terminal, checkHidden);
		thinkingGate.resolve();
		// Wait for the hidden append itself, not merely an already-hidden screen.
		await expect.poll(() => appended).toBe(true);
		terminal.resize(40, 24);
		await screenEventually(terminal, checkHidden);
		terminal.data("\x14");
		await screenEventually(terminal, (lines) => {
			checkCommon(lines);
			const text = lines.join("\n");
			expect(text.match(/PRIOR retained reasoning/g)).toHaveLength(1);
			expect(text.match(/LIVE alpha beta gamma delta epsilon zeta/g)).toHaveLength(1);
			expect(text.match(/eta theta iota kappa/g)).toHaveLength(1);
			expect(text.match(/HIDDEN append retained/g)).toHaveLength(1);
			expect(text).not.toContain("Thinking...");
			expect(text).toContain("Thinking blocks: visible");
		});
		terminal.resize(64, 28);
		await screenEventually(terminal, (lines) => {
			checkCommon(lines);
			expect(lines.filter((line) => line.includes("LIVE alpha"))).toEqual([
				"LIVE alpha beta gamma delta epsilon zeta eta theta iota kappa",
			]);
			expect(lines.filter((line) => line.trim() === "eta theta iota kappa")).toEqual([]);
		});
		terminal.data("\x14");
		await screenEventually(terminal, checkHidden);
		expect(calls).toBe(1);
	} finally {
		thinkingGate.resolve();
		endGate.resolve();
		terminal.data("\x7f".repeat("draft survives".length));
		// Submission of /exit is accepted after the provider finishes.
		await new Promise<void>((resolve) => setTimeout(resolve, 80));
		terminal.data("/exit\r");
		await expect(repl).resolves.toBe(0);
	}
});
