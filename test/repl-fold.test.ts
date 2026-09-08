import { describe, expect, it } from "vitest";
import { buildFoldFromDiff, decorateDiffLines, Fold } from "../src/repl/components/fold.js";
import { TuiShell } from "../src/repl/shell.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { StdinBuffer, type Terminal, visibleWidth } from "../src/tui.js";

// ── fakes (the repl-tui.test.ts harness, repeated for this suite) ─────────

/** The pi-tui Terminal contract, captured: writes logged, input injectable
 *  through the real splitter. */
class FakeTerminal implements Terminal {
	private buffer: StdinBuffer | null = null;
	private readonly columnCount: number;
	private readonly rowCount: number;
	readonly writes: string[] = [];

	constructor(columnCount = 80, rowCount = 24) {
		this.columnCount = columnCount;
		this.rowCount = rowCount;
	}

	start(onInput: (data: string) => void, _onResize: () => void): void {
		const buffer = new StdinBuffer();
		buffer.on("data", (sequence: string) => onInput(sequence));
		buffer.on("paste", (content: string) => onInput(`\x1b[200~${content}\x1b[201~`));
		this.buffer = buffer;
	}

	stop(): void {
		this.buffer = null;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.columnCount;
	}

	get rows(): number {
		return this.rowCount;
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

	/** Inject keystrokes through the real splitter (like stdin bursts). */
	data(text: string): void {
		this.buffer?.process(text);
	}

	/** Everything written since `mark`, ANSI/control-stripped. */
	frameSince(mark: number): string {
		// Write-boundary safe (debt clearance): joining raw writes could glue
		// the tail of one frame to the head of the next into a phantom line —
		// a boundary break is inserted when neither side ends a line. NOTE:
		// the inserted \n is synthetic — assertions must never match text
		// ACROSS a write boundary (same logical line split over two writes
		// would read as two lines here; no current TUI write does that).
		let out = "";
		for (const write of this.writes.slice(mark)) {
			const text = stripAnsi(write);
			if (out !== "" && !out.endsWith("\n") && !text.startsWith("\n")) out += "\n";
			out += text;
		}
		return out;
	}
}

/** Remove escape sequences (CSI/OSC/APC), cursor markers, and \r. */
function stripAnsi(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch !== "\x1b") {
			if (ch !== "\r" && ch !== "\x07") out += ch;
			continue;
		}
		const next = text[i + 1];
		if (next === "[") {
			i += 2;
			while (i < text.length && !/[A-Za-z]/.test(text[i] ?? "")) i++;
		} else if (next === "]") {
			i += 2;
			while (i < text.length && text[i] !== "\x07" && text[i] !== "\x1b") i++;
			if (text[i] === "\x1b" && text[i + 1] === "\\") i++;
		} else {
			i += 1;
		}
	}
	return out;
}

/** Settle TUI renders: nextTick + the 16ms minimum render interval. */
async function settle(extraMs = 30): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, extraMs));
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeShell() {
	const terminal = new FakeTerminal();
	const transcript = new TranscriptSink();
	const events: string[] = [];
	const shell = new TuiShell({
		transcript,
		terminal,
		onLine: (line) => events.push(`line:${line}`),
		onInterrupt: () => events.push("interrupt"),
		onEof: () => events.push("eof"),
	});
	return { terminal, transcript, shell, events };
}

// ── Fold: the component contract ──────────────────────────────────────────

describe("Fold", () => {
	it("collapsed is ONE dimmed-arrow line; toggle() shows/hides the body", () => {
		const fold = new Fold("edit src/foo.ts (+12/-3)", ["+ hello", "- old"]);
		const collapsed = fold.render(40);
		expect(collapsed).toHaveLength(1);
		expect(stripAnsi(collapsed[0] ?? "")).toBe("▸ edit src/foo.ts (+12/-3)");

		fold.toggle();
		const expanded = fold.render(40);
		expect(expanded).toHaveLength(3);
		expect(stripAnsi(expanded[0] ?? "")).toBe("▾ edit src/foo.ts (+12/-3)");
		expect(stripAnsi(expanded[1] ?? "")).toBe("+ hello");
		expect(stripAnsi(expanded[2] ?? "")).toBe("- old");

		fold.toggle();
		const again = fold.render(40);
		expect(again).toHaveLength(1);
		expect(stripAnsi(again[0] ?? "")).toBe("▸ edit src/foo.ts (+12/-3)");
	});

	it("every rendered line fits the width budget in either state — 200-column content truncates", () => {
		const fold = new Fold("a long fold title that alone exceeds the narrow widths", [
			"x".repeat(200),
			"",
			"ok",
		]);
		for (const width of [80, 40, 8, 3]) {
			for (const expanded of [false, true]) {
				if (expanded) fold.toggle();
				const rendered = fold.render(width);
				if (!expanded) expect(rendered).toHaveLength(1); // collapsed: one line, always
				for (const line of rendered) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
				if (expanded) fold.toggle();
			}
		}
	});
});

// ── decorateDiffLines: body coloring + new-file line numbers ────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

describe("decorateDiffLines", () => {
	it("colors by prefix and numbers new-file lines from the hunk header (headers themselves unnumbered)", () => {
		expect(decorateDiffLines(["@@ line 10 @@", "- old line", "+ new line", "+ newer line"])).toEqual([
			`${CYAN}@@ line 10 @@${RESET}`,
			`${RED}- old line${RESET}`,
			`${DIM}10│ ${RESET}${GREEN}+ new line${RESET}`,
			`${DIM}11│ ${RESET}${GREEN}+ newer line${RESET}`,
		]);
	});

	it("context lines are dim and advance the counter; numbers right-align to the widest", () => {
		expect(decorateDiffLines(["@@ line 9 @@", "  context", "+ add"])).toEqual([
			`${CYAN}@@ line 9 @@${RESET}`,
			`${DIM} 9│ ${RESET}${DIM}  context${RESET}`,
			`${DIM}10│ ${RESET}${GREEN}+ add${RESET}`,
		]);
	});

	it("a removed line between adds gets no number and does not advance the counter", () => {
		const body = decorateDiffLines(["@@ line 3 @@", "+ keep", "- drop", "+ next"]);
		expect(body[1]).toBe(`${DIM}3│ ${RESET}${GREEN}+ keep${RESET}`);
		expect(body[2]).toBe(`${RED}- drop${RESET}`);
		expect(body[3]).toBe(`${DIM}4│ ${RESET}${GREEN}+ next${RESET}`);
	});

	it("no hunk header: colored, never numbered (tolerant degradation)", () => {
		expect(decorateDiffLines(["+ first", "- second", "plain"])).toEqual([
			`${GREEN}+ first${RESET}`,
			`${RED}- second${RESET}`,
			`${DIM}plain${RESET}`,
		]);
	});

	it("an unparseable header turns numbering off; a parseable one re-arms it", () => {
		const body = decorateDiffLines([
			"@@ line 5 @@",
			"+ a",
			"@@ -1,3 +1,4 @@", // unified-diff style: a header, but not ours
			"+ b",
			"@@ line 9 @@",
			"+ c",
		]);
		expect(body[0]).toBe(`${CYAN}@@ line 5 @@${RESET}`);
		expect(body[1]).toBe(`${DIM}5│ ${RESET}${GREEN}+ a${RESET}`);
		expect(body[2]).toBe(`${CYAN}@@ -1,3 +1,4 @@${RESET}`);
		expect(body[3]).toBe(`${GREEN}+ b${RESET}`); // no gutter after the foreign header
		expect(body[5]).toBe(`${DIM}9│ ${RESET}${GREEN}+ c${RESET}`);
	});
});

// ── Fold: the decorated body in the rendered output ─────────────────────

describe("Fold diff decoration", () => {
	it("the expanded body carries colors and the number gutter; the title line stays untouched", () => {
		const fold = new Fold("edit src/foo.ts (+1/-1)", ["@@ line 10 @@", "- old", "+ new"]);
		fold.toggle();
		const rendered = fold.render(80);
		expect(rendered).toHaveLength(4);
		expect(stripAnsi(rendered[0] ?? "")).toBe("▾ edit src/foo.ts (+1/-1)");
		expect(rendered[1]).toBe(`${CYAN}@@ line 10 @@${RESET}`);
		expect(rendered[2]).toBe(`${RED}- old${RESET}`);
		expect(rendered[3]).toBe(`${DIM}10│ ${RESET}${GREEN}+ new${RESET}`);
		expect(stripAnsi(rendered[3] ?? "")).toBe("10│ + new");
	});

	it("the gutter eats into the width budget — wide bodies still fit", () => {
		const fold = new Fold("wide (+1/-0)", ["@@ line 1 @@", `+ ${"w".repeat(90)}`]);
		fold.toggle();
		for (const line of fold.render(80)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});
});

// ── buildFoldFromDiff: unified-diff tallies in the title ──────────────────

describe("buildFoldFromDiff", () => {
	const DIFF = [
		"--- a/src/foo.ts",
		"+++ b/src/foo.ts",
		"@@ -1,3 +1,4 @@",
		" context line",
		"-old line",
		"+new line",
		"+newer line",
		"",
	].join("\n");

	it("counts +/− content lines into the title (+++/--- headers excluded); body keeps the diff", () => {
		const { title, lines } = buildFoldFromDiff("edit src/foo.ts", DIFF);
		const fold = new Fold(title, lines);
		expect(stripAnsi(fold.render(80)[0] ?? "")).toBe("▸ edit src/foo.ts (+2/-1)");

		fold.toggle();
		const body = fold.render(80).map(stripAnsi);
		// The trailing "\n" is an artifact, not a blank body line — the fold drops it.
		const diffLines = DIFF.split("\n");
		diffLines.pop();
		expect(body.slice(1)).toEqual(diffLines);
		expect(body).toContain("-old line");
		expect(body).toContain("+new line");
		expect(body).toContain("+newer line");
		expect(body).toContain("@@ -1,3 +1,4 @@");
		expect(body).toContain("+++ b/src/foo.ts"); // headers stay visible, just uncounted
	});
});

// ── TuiShell.addFold: the shell integration ───────────────────────────────

describe("TuiShell.addFold", () => {
	it("renders collapsed below the streamed text — v1 ordering: stream first, fold after", async () => {
		const { terminal, transcript, shell } = makeShell();
		shell.start();
		await settle();
		transcript.feed("streamed note\n");
		shell.addFold("edit a.ts (+1/-0)", ["+ one"]);
		await settle(); // paints without forceRender, like the transcript
		expect(terminal.frameSince(0)).toContain("▸ edit a.ts (+1/-0)");
		expect(terminal.frameSince(0)).not.toContain("+ one"); // body hidden while collapsed

		const mark = terminal.writes.length; // full repaint: relative order is readable
		shell.forceRender();
		await settle(0);
		const frame = terminal.frameSince(mark);
		expect(frame.indexOf("streamed note")).toBeLessThan(frame.indexOf("▸ edit a.ts (+1/-0)"));
		shell.close();
	});

	it("ctrl+o expands the newest fold — content appears, then disappears on the second press", async () => {
		const { terminal, shell, events } = makeShell();
		shell.start();
		await settle();
		terminal.data("\x0f"); // no fold yet: falls through, no-op
		await settle(0);
		expect(events).toEqual([]);

		shell.addFold("edit a.ts (+1/-0)", ["+ visible body"]);
		await settle();
		let mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).not.toContain("+ visible body");

		terminal.data("\x0f"); // ctrl+o → expand
		await settle();
		expect(terminal.frameSince(mark)).toContain("+ visible body");
		expect(terminal.frameSince(mark)).toContain("▾ edit a.ts (+1/-0)");

		terminal.data("\x0f"); // ctrl+o → collapse again
		await settle();
		mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).not.toContain("+ visible body");
		expect(terminal.frameSince(mark)).toContain("▸ edit a.ts (+1/-0)");
		shell.close();
	});

	it("two folds: ctrl+o expands ALL (debt clearance — mid-turn folds reachable), second press collapses all", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle();
		shell.addFold("fold a (+1/-0)", ["+ alpha"]);
		await settle();
		shell.addFold("fold b (+1/-0)", ["+ beta"]);
		await settle();
		expect(terminal.frameSince(0)).toContain("▸ fold a (+1/-0)");
		expect(terminal.frameSince(0)).toContain("▸ fold b (+1/-0)");

		terminal.data("\x0f"); // expand-all: BOTH bodies reachable
		await settle();
		expect(terminal.frameSince(0)).toContain("+ beta");
		expect(terminal.frameSince(0)).toContain("+ alpha");

		terminal.data("\x0f"); // collapse-all
		await settle();
		const mark = terminal.writes.length;
		shell.forceRender();
		await settle(0);
		expect(terminal.frameSince(mark)).not.toContain("+ beta");
		expect(terminal.frameSince(mark)).not.toContain("+ alpha");
		shell.close();
	});

	it("a 200-column body line renders through the TUI at 80 columns without throwing", async () => {
		const { terminal, shell } = makeShell();
		shell.start();
		await settle();
		shell.addFold("wide (+1/-0)", ["w".repeat(200)]);
		await settle();
		terminal.data("\x0f"); // expand — the widest state
		await settle();
		expect(terminal.writes.length).toBeGreaterThan(0); // the TUI kept rendering, no width throw
		shell.close();
	});
});
