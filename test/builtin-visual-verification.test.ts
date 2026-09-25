import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { LLMRequest } from "../src/provider/types.js";
import { Renderer } from "../src/render.js";
import { runRepl } from "../src/repl/repl.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner } from "../src/runner.js";
import { StdinBuffer, type Terminal, visibleWidth } from "../src/tui.js";
import { assistant, scriptedProvider } from "./helpers/fakes.js";

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
	readonly screen = new Screen(120, 200);
	readonly writes: string[] = [];
	private input: StdinBuffer | null = null;
	private onResize: (() => void) | null = null;
	private closing = false;
	private interrupted = false;
	get started(): boolean {
		return this.input !== null;
	}
	cancel(force = false): void {
		this.closing = true;
		if (!this.input) return;
		if (!this.interrupted || force) {
			this.interrupted = true;
			this.data("\x03"); // abort an active tool; also clear any editor draft
		}
		this.data("\x04"); // EOF exits once the aborted turn settles
	}
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
		// Cleanup may begin while runRepl is still probing its input dependencies.
		if (this.closing) queueMicrotask(() => this.cancel());
	}
	stop(): void {
		this.input = null;
		this.onResize = null;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
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
			{ timeout: 8000, interval: 20 },
		)
		.toBe(true);
}

/** Keep setup, execution and shutdown inside the same environment scope. */
async function withVisualScope(
	baseDir: string,
	body: (terminal: ScreenTerminal, track: (repl: Promise<number>) => void) => Promise<void>,
): Promise<void> {
	const previousPath = process.env.PATH;
	const terminal = new ScreenTerminal();
	let outcome: { code: number } | { error: unknown } | undefined;
	let tracked = false;
	try {
		process.env.PATH = baseDir;
		await body(terminal, (repl) => {
			tracked = true;
			// Observe immediately: startup rejection must not become unhandled.
			void repl.then(
				(code) => {
					outcome = { code };
				},
				(error: unknown) => {
					outcome = { error };
				},
			);
		});
	} finally {
		try {
			if (tracked) {
				const deadline = Date.now() + 1000;
				await expect
					.poll(
						() => {
							if (!outcome) terminal.cancel(Date.now() >= deadline);
							return outcome !== undefined;
						},
						{ timeout: 5000, interval: 20 },
					)
					.toBe(true);
				if (outcome && "error" in outcome) await Promise.reject(outcome.error);
				// A force quit is a failed cleanup, not a successful visual test.
				expect(outcome).toEqual({ code: 0 });
				await expect.poll(() => terminal.started, { timeout: 2000, interval: 20 }).toBe(false);
			}
		} finally {
			try {
				terminal.stop();
			} finally {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
			}
		}
	}
}

it.each(["setup", "repl rejection"])("restores PATH after %s failure", async (phase) => {
	const before = process.env.PATH;
	const failure = new Error(`injected ${phase} failure`);
	await expect(
		withVisualScope("/tmp/visual-setup-failure", async (_terminal, track) => {
			if (phase === "setup") throw failure;
			track(Promise.reject(failure));
		}),
	).rejects.toBe(failure);
	expect(process.env.PATH).toBe(before);
});

import { createFindTool } from "../src/core/tools/find.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { createLsTool } from "../src/core/tools/ls.js";
import { createReadTool } from "../src/core/tools/read.js";
import { createTaskTool } from "../src/core/tools/task.js";
import { createWriteTool } from "../src/core/tools/write.js";

const fixtures = [
	{
		name: "write",
		args: { path: "file.txt", content: 'const x = "\\n";\nsecond line\n', extra: "UNKNOWN_RETAINED" },
		labels: ["Path", "Content", "second line"],
	},
	{
		name: "read",
		args: { path: "file.txt", offset: 1, limit: 2, extra: "UNKNOWN_RETAINED" },
		labels: ["Path", "Start line", "Requested line limit"],
	},
	{
		name: "grep",
		args: {
			pattern: "needle",
			path: ".",
			glob: "*.txt",
			ignoreCase: true,
			literal: true,
			context: 1,
			limit: 10,
			timeout: 5,
			extra: "UNKNOWN_RETAINED",
		},
		labels: [
			"Pattern",
			"File glob",
			"Ignore case",
			"Literal",
			"Context lines",
			"Output line limit",
			"Timeout (seconds)",
		],
	},
	{
		name: "find",
		args: { pattern: "*.txt", path: ".", type: "file", limit: 10, timeout: 5, extra: "UNKNOWN_RETAINED" },
		labels: ["Name glob", "Type", "Output line limit", "Timeout (seconds)"],
	},
	{ name: "ls", args: { path: ".", limit: 10, extra: "UNKNOWN_RETAINED" }, labels: ["Path", "Entry limit"] },
	{
		name: "task",
		args: {
			prompt: "Inspect local fixture\nReport second line",
			timeoutMs: 5000,
			worktree: false,
			extra: "UNKNOWN_RETAINED",
		},
		labels: ["Prompt", "Agent", "Timeout (ms)", "Worktree", "Report second line"],
	},
];
it.each(fixtures)(
	"physical REPL frames: $name",
	async ({ name, args, labels }) => {
		const baseDir = await mkdtemp(path.join("/tmp", `imp-builtin-visual-${name}-`));
		console.log(`VISUAL_ARTIFACT ${name} ${baseDir}`);
		await writeFile(path.join(baseDir, "file.txt"), "needle first\nsecond line\n");
		for (const bin of ["rg", "fd"])
			await writeFile(
				path.join(baseDir, bin),
				`#!${process.execPath}\nif(process.argv.includes('--version'))process.exit(0);process.stdout.write(${JSON.stringify(bin === "rg" ? "file.txt:1:needle first\n" : "file.txt\n")});`,
				{ mode: 0o755 },
			);
		await withVisualScope(baseDir, async (terminal, track) => {
			const tools = [
				createWriteTool({ cwd: baseDir }),
				createReadTool({ cwd: baseDir }),
				createGrepTool({ cwd: baseDir }),
				createFindTool({ cwd: baseDir }),
				createLsTool({ cwd: baseDir }),
				createTaskTool({
					cwd: baseDir,
					getProvider: () => scriptedProvider([assistant([{ type: "text", text: "LOCAL_CHILD_ANSWER" }])]),
					getModel: () => "fake",
					getSystem: () => "",
					getTools: () => [],
					getSession: () => null,
					agents: [],
					childSessions: false,
				}),
			];
			const requests: LLMRequest[] = [];
			const provider = scriptedProvider(
				[
					assistant([{ type: "toolCall", id: "visual-call", name, arguments: args }], "tool_use"),
					assistant([{ type: "text", text: "VISUAL_DONE" }]),
				],
				requests,
			);
			const transcript = new TranscriptSink();
			const renderer = new Renderer({
				write: transcript.feed,
				thinkingSink: transcript.thinkingSink,
				userSink: (s) => transcript.feedUser(s),
				statusSink: (s) => transcript.feedStatus(s),
				ansi: true,
				liveTools: false,
				toolStyle: "one-line",
				markdown: false,
			});
			const runner = await createRunner({
				cwd: baseDir,
				agentsHomeDir: baseDir,
				argv: [],
				model: "test-model",
				maxTokens: 1024,
				maxTurns: 3,
				noContextFiles: true,
				noSession: true,
				sessionBaseDir: baseDir,
				settingsPath: path.join(baseDir, "settings.json"),
				renderer,
				provider,
				tools,
			});
			const repl = runRepl({
				runner,
				commands: [],
				shell: "tui",
				transcript,
				terminal,
				interactive: true,
				exit: (code) => {
					throw new Error(`Unexpected forced REPL exit: ${code}`);
				},
			});
			track(repl);
			const expectedResult = {
				write: "Overwrote file.txt (2 lines, 28 bytes)",
				read: "needle first",
				grep: "file.txt:1:needle first",
				find: "file.txt",
				ls: "file.txt",
				task: "(child: 1 turns",
			}[name];
			if (expectedResult === undefined) throw new Error(`Missing result fixture: ${name}`);
			// Ignore wrap indentation only, not content. At 20/40 columns words and
			// JSON tokens can cross physical rows; all expected characters must remain.
			const compact = (text: string) => text.replace(/\s/g, "");
			const checkContent = (text: string, state: string, width: number) => {
				if (width === 1) return; // resilience/width only: viewport clips content
				const content = compact(text);
				expect(content).toContain(compact(`● ${name}`));
				expect(content).toContain("VISUAL_DONE");
				expect(content).toContain(compact(expectedResult));
				if (state === "collapsed") {
					expect(text).not.toContain('"extra":');
					expect(text).not.toContain("Other arguments");
				} else if (state === "raw") {
					expect(content).toContain("Rawarguments");
					for (const key of Object.keys(args)) expect(content).toContain(`"${key}":`);
					expect(content).toContain('"UNKNOWN_RETAINED"');
				} else {
					for (const label of labels) expect(content).toContain(compact(label));
					expect(content).toContain("Otherarguments");
					expect(content).toContain("UNKNOWN_RETAINED");
					expect(text).not.toContain("Raw arguments");
				}
			};
			async function capture(state: string, width: number) {
				const before = terminal.writes.length;
				terminal.resize(width, 200);
				await screenEventually(terminal, (lines) => {
					expect(terminal.writes.length).toBeGreaterThan(before);
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					checkContent(lines.join("\n"), state, width);
				});
				const lines = terminal.screen.lines();
				await writeFile(path.join(baseDir, `${state}-${width}.txt`), `${lines.join("\n")}\n`);
				return lines.join("\n");
			}
			await screenEventually(terminal, (lines) => expect(lines.join("\n")).toContain("/help for commands"));
			terminal.data("verify local tools\r");
			await screenEventually(terminal, (lines) => expect(lines.join("\n")).toContain("VISUAL_DONE"));
			expect(requests).toHaveLength(name === "task" ? 3 : 2);
			for (const width of [120, 40, 20, 1]) {
				const text = await capture("collapsed", width);
				if (width === 120) {
					expect(text).toContain(name);
					expect(text).not.toContain('"extra":');
					expect(text).not.toContain('"path":');
				}
			}
			await capture("collapsed", 120);
			terminal.data("\x0f");
			for (const width of [120, 40, 20, 1]) {
				const text = await capture("expanded", width);
				if (width === 120) {
					for (const label of labels) expect(text).toContain(label);
					expect(text).toContain("Other arguments");
					expect(text).toContain("UNKNOWN_RETAINED");
				}
			}
			await capture("expanded", 120);
			terminal.data("\x1bo");
			for (const width of [120, 40, 20, 1]) {
				const text = await capture("raw", width);
				if (width === 120) for (const key of Object.keys(args)) expect(text).toContain(`"${key}":`);
			}
			await capture("raw", 120);
			terminal.data("\x1bo");
			const restored = await capture("restored", 120);
			for (const label of labels) expect(restored).toContain(label);
			expect(restored).not.toContain("Error:");
			expect(restored).toContain(expectedResult);
			await writeFile(path.join(baseDir, "terminal.ansi"), terminal.writes.join(""));
			if (name === "write") expect(await readFile(path.join(baseDir, "file.txt"), "utf8")).toBe(args.content);
		});
	},
	60000,
);
