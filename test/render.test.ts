import { describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../src/core/messages.js";
import { renderMarkdownLite } from "../src/format.js";
import { Renderer } from "../src/render.js";

function collector(): { chunks: string[]; write(s: string): void; output(): string } {
	const chunks: string[] = [];
	return {
		chunks,
		write: (s: string) => {
			chunks.push(s);
		},
		output: () => chunks.join(""),
	};
}

const okResult = (content: string, id = "t1"): ToolResult => ({
	toolCallId: id,
	toolName: "bash",
	content,
	isError: false,
});
const errResult = (content: string, id = "t1"): ToolResult => ({
	toolCallId: id,
	toolName: "bash",
	content,
	isError: true,
});

const THINK_DELAY = 250; // mirrors THINK_DELAY_MS in render.ts (grace period)

describe("Renderer", () => {
	it("concatenates text deltas in order and forces tool lines onto fresh lines", () => {
		const out = collector();
		const r = new Renderer({ write: out.write, ansi: false, liveTools: false, toolStyle: "one-line" });
		r.event({ type: "text_delta", text: "Hello" });
		r.event({ type: "text_delta", text: " world" });
		r.event({ type: "tool_start", toolCallId: "t1", name: "bash", args: { command: "ls" } });
		r.event({ type: "tool_end", result: okResult("a.ts\nb.ts") });
		r.event({ type: "text_delta", text: "done" });
		r.endRun();
		expect(out.output()).toBe("Hello world\n● bash $ ls ✓\n  ⎿  a.ts (+1 lines)\ndone\n");
	});

	it("one-line live tool formats: spinner pending line, ✓ with duration (injected clock), ✗ error, ⎿ summary", () => {
		let now = 0;
		const out = collector();
		const r = new Renderer({
			write: out.write,
			ansi: true,
			liveTools: true,
			toolStyle: "one-line",
			spinnerIntervalMs: 0, // tests tick manually
			clock: () => now,
		});
		// pending: erase prefix + dim ● + bold name + dim args + dim frame, no newline
		r.event({ type: "tool_start", toolCallId: "t1", name: "bash", args: { command: "npm test" } });
		expect(out.output()).toBe(
			"\r\x1b[2K\x1b[2m● \x1b[0m\x1b[1mbash\x1b[0m \x1b[2m$ npm test\x1b[0m\x1b[2m ⠋\x1b[0m",
		);
		// tick at 5s: rewrite with next frame + elapsed
		now = 5000;
		r.tick();
		expect(out.output().endsWith("\x1b[2m ⠙ 5s\x1b[0m")).toBe(true);
		// success with 12.4s duration, then ⎿ summary line
		now = 12400;
		r.event({ type: "tool_end", result: okResult("all good") });
		expect(
			out
				.output()
				.endsWith(
					"\r\x1b[2K\x1b[2m● \x1b[0m\x1b[1mbash\x1b[0m \x1b[2m$ npm test\x1b[0m \x1b[32m✓\x1b[0m \x1b[2m12.4s\x1b[0m\n\x1b[2m  ⎿  all good\x1b[0m\n",
				),
		).toBe(true);
		// fast tool: no duration; empty content → (no output)
		r.event({ type: "tool_start", toolCallId: "t2", name: "bash", args: { command: "true" } });
		now += 400;
		r.event({ type: "tool_end", result: okResult("", "t2") });
		expect(
			out
				.output()
				.endsWith(
					"\x1b[2m● \x1b[0m\x1b[1mbash\x1b[0m \x1b[2m$ true\x1b[0m \x1b[32m✓\x1b[0m\n\x1b[2m  ⎿  (no output)\x1b[0m\n",
				),
		).toBe(true);
		// error: dim ● + bold name + red ✗ + red firstLine(content, 120); ⎿ in red
		const long = "x".repeat(130);
		r.event({ type: "tool_start", toolCallId: "t3", name: "bash", args: { command: "cat nope" } });
		r.event({ type: "tool_end", result: errResult(long, "t3") });
		expect(
			out
				.output()
				.endsWith(
					`\r\x1b[2K\x1b[2m● \x1b[0m\x1b[1mbash\x1b[0m \x1b[2m$ cat nope\x1b[0m \x1b[31m✗\x1b[0m \x1b[31m${"x".repeat(120)}…\x1b[0m\n\x1b[31m  ⎿  ${"x".repeat(80)}…\x1b[0m\n`,
				),
		).toBe(true);
	});

	it("live thinking spinner: delayed start, ticks with elapsed, erased by the first text delta", () => {
		vi.useFakeTimers();
		try {
			let now = 0;
			const out = collector();
			const r = new Renderer({
				write: out.write,
				ansi: true,
				liveTools: true,
				toolStyle: "one-line",
				spinnerIntervalMs: 0,
				clock: () => now,
			});
			r.think();
			expect(out.output()).toBe(""); // grace period — nothing yet
			now = THINK_DELAY;
			vi.advanceTimersByTime(THINK_DELAY);
			expect(out.output()).toBe("\r\x1b[2K\x1b[2m⠋ Thinking…\x1b[0m");
			now = THINK_DELAY + 3000;
			r.tick();
			expect(out.output().endsWith("\r\x1b[2K\x1b[2m⠙ Thinking… 3s\x1b[0m")).toBe(true);
			// first streamed text erases the spinner line entirely
			r.event({ type: "text_delta", text: "hello" });
			expect(out.output().endsWith("\r\x1b[2Khello")).toBe(true);
			r.endRun();
		} finally {
			vi.useRealTimers();
		}
	});

	it("two-line style is byte-identical to the legacy renderEvent output", () => {
		const out = collector();
		const r = new Renderer({ write: out.write, ansi: true, liveTools: false, toolStyle: "two-line" });
		r.event({ type: "text_delta", text: "Let me check" });
		r.event({ type: "tool_start", toolCallId: "t1", name: "bash", args: { command: "ls" } });
		r.event({ type: "tool_end", result: okResult("a.ts\nb.ts") });
		r.event({ type: "tool_start", toolCallId: "t2", name: "read", args: { path: "x.ts" } });
		r.event({ type: "tool_end", result: errResult("boom") });
		r.endRun(true);
		expect(out.output()).toBe(
			"Let me check" +
				"\n\x1b[2m● bash $ ls\x1b[0m\n" +
				"\x1b[2m  → a.ts\x1b[0m\n" +
				'\n\x1b[2m● read {"path":"x.ts"}\x1b[0m\n' +
				"\x1b[31m  ✗ boom\x1b[0m\n" +
				"\n",
		);
		// plain-text variant (no ANSI): same bytes with the escapes stripped
		const plain = collector();
		const p = new Renderer({ write: plain.write, ansi: false, liveTools: false, toolStyle: "two-line" });
		p.event({ type: "text_delta", text: "Let me check" });
		p.event({ type: "tool_start", toolCallId: "t1", name: "bash", args: { command: "ls" } });
		p.event({ type: "tool_end", result: okResult("a.ts\nb.ts") });
		p.endRun(true);
		expect(plain.output()).toBe("Let me check\n● bash $ ls\n  → a.ts\n\n");
	});

	it("non-TTY: no \\r, no pending line, no ANSI; note/error/writeLine track newline state", () => {
		const out = collector();
		const r = new Renderer({ write: out.write, ansi: false, liveTools: false, toolStyle: "one-line" });
		r.event({ type: "tool_start", toolCallId: "t1", name: "bash", args: { command: "ls" } });
		r.event({ type: "tool_end", result: okResult("ok") });
		r.note("▪ a note");
		r.error("imp: boom");
		r.writeLine("plain line");
		r.endRun();
		expect(out.output()).toBe("● bash $ ls ✓\n  ⎿  ok\n▪ a note\nimp: boom\nplain line\n");
		expect(out.output()).not.toContain("\r");
		expect(out.output()).not.toContain("\x1b");
	});

	it("note mid-stream inserts onto a fresh line and streaming continues after it", () => {
		const out = collector();
		const r = new Renderer({ write: out.write, ansi: false, liveTools: false, toolStyle: "one-line" });
		r.raw("streaming text"); // no trailing newline
		r.note("▪ context ~1.2k tokens — compacting…");
		r.raw("more text");
		r.endRun();
		expect(out.output()).toBe("streaming text\n▪ context ~1.2k tokens — compacting…\nmore text\n");
	});

	it("markdown mode: streamed text is paragraph-buffered and rendered; flushed at endRun", () => {
		const out = collector();
		const r = new Renderer({
			write: out.write,
			ansi: true,
			liveTools: false,
			toolStyle: "one-line",
			markdown: true,
		});
		// paragraph 1 completes at the blank line — rendered immediately
		r.event({ type: "text_delta", text: "## Header\nplain " });
		r.event({ type: "text_delta", text: "text\n\n" });
		expect(out.output()).toBe("\x1b[1mHeader\x1b[0m\nplain text\n\n");
		// code fence: held until the fence closes, then indented content
		r.event({ type: "text_delta", text: "```ts\nconst x = 1;" });
		expect(out.output()).toBe("\x1b[1mHeader\x1b[0m\nplain text\n\n"); // still buffering
		r.event({ type: "text_delta", text: "\n```\n" });
		expect(out.output()).toContain("\x1b[2m```ts\x1b[0m\n  const x = 1;\n\x1b[2m```\x1b[0m\n");
		// trailing paragraph without a blank line flushes on endRun
		r.event({ type: "text_delta", text: "- done **now**" });
		r.endRun();
		expect(out.output().endsWith("  • done \x1b[1mnow\x1b[0m\n")).toBe(true);
	});

	it("markdown disabled (print/pipes): text deltas pass through verbatim", () => {
		const out = collector();
		const r = new Renderer({ write: out.write, ansi: true, liveTools: false, toolStyle: "one-line" });
		r.event({ type: "text_delta", text: "## raw **stays**\n\nuntouched" });
		r.endRun();
		expect(out.output()).toBe("## raw **stays**\n\nuntouched\n");
	});
});

describe("concurrent live tools (M5b design §7)", () => {
	it("two pendings collapse to one aggregate line; results print under it in call order", () => {
		let now = 0;
		const out = collector();
		const r = new Renderer({
			write: out.write,
			ansi: true,
			liveTools: true,
			toolStyle: "one-line",
			spinnerIntervalMs: 0,
			clock: () => now,
		});
		r.event({ type: "tool_start", toolCallId: "a", name: "task", args: { prompt: "scout A" } });
		// first pending: today's single-slot line
		expect(out.output()).toBe(
			'\r\x1b[2K\x1b[2m● \x1b[0m\x1b[1mtask\x1b[0m \x1b[2m{"prompt":"scout A"}\x1b[0m\x1b[2m ⠋\x1b[0m',
		);
		// second pending: collapse to the aggregate line
		r.event({ type: "tool_start", toolCallId: "b", name: "task", args: { prompt: "scout B" } });
		expect(out.output().endsWith("\r\x1b[2K\x1b[2m⠋ 2 tasks running 0s\x1b[0m")).toBe(true);
		// aggregate ticks with the oldest start
		now = 12000;
		r.tick();
		expect(out.output().endsWith("\r\x1b[2K\x1b[2m⠙ 2 tasks running 12s\x1b[0m")).toBe(true);
		// first result: erase, final line + ⎿, then the survivor redraws alone
		now = 12400;
		r.event({ type: "tool_end", result: okResult("A found 3 files", "a") });
		const afterA = out.output();
		expect(afterA).toContain('"scout A"}\x1b[0m \x1b[32m✓\x1b[0m \x1b[2m12.4s\x1b[0m\n');
		expect(afterA).toContain("\x1b[2m  ⎿  A found 3 files\x1b[0m\n");
		expect(
			afterA.endsWith(
				'\r\x1b[2K\x1b[2m● \x1b[0m\x1b[1mtask\x1b[0m \x1b[2m{"prompt":"scout B"}\x1b[0m\x1b[2m ⠙\x1b[0m',
			),
		).toBe(true);
		// sole survivor ticks in single-pending format (started at 0)
		now = 20000;
		r.tick();
		expect(out.output().endsWith("\x1b[2m ⠹ 20s\x1b[0m")).toBe(true);
		// last result: final line + ⎿, no live line after
		r.event({ type: "tool_end", result: okResult("B found 1 file", "b") });
		expect(out.output().endsWith("\x1b[2m  ⎿  B found 1 file\x1b[0m\n")).toBe(true);
	});

	it("CJK prompt args under the aggregate: no padding or column math anywhere", () => {
		const out = collector();
		const r = new Renderer({
			write: out.write,
			ansi: false,
			liveTools: true,
			toolStyle: "one-line",
			spinnerIntervalMs: 0,
		});
		r.event({ type: "tool_start", toolCallId: "a", name: "task", args: { prompt: "审查渲染层" } });
		r.event({ type: "tool_start", toolCallId: "b", name: "task", args: { prompt: "检查并发" } });
		const output = out.output();
		expect(output).toContain("2 tasks running 0s");
		expect(output).not.toContain("\uFFFD");
	});

	it("print mode (two-line) with two concurrent tools: byte-identical to the serial shape", () => {
		const out = collector();
		const r = new Renderer({ write: out.write, ansi: false, liveTools: false, toolStyle: "two-line" });
		r.event({ type: "tool_start", toolCallId: "a", name: "task", args: { prompt: "A" } });
		r.event({ type: "tool_start", toolCallId: "b", name: "task", args: { prompt: "B" } });
		r.event({ type: "tool_end", result: okResult("ra", "a") });
		r.event({ type: "tool_end", result: okResult("rb", "b") });
		expect(out.output()).toBe(
			'\n● task {"prompt":"A"}\n' + '\n● task {"prompt":"B"}\n' + "  → ra\n" + "  → rb\n",
		);
	});
});

describe("renderMarkdownLite", () => {
	it("headers → bold, bullets → •, bold spans, hr → dim rule, plain untouched", () => {
		const src = "### Title\n- a\n- **b**\nbody **x** y\n---\n中文段落不受影响";
		const out = renderMarkdownLite(src, true);
		expect(out).toContain("\x1b[1mTitle\x1b[0m");
		expect(out).toContain("  • a");
		expect(out).toContain("  • \x1b[1mb\x1b[0m");
		expect(out).toContain("body \x1b[1mx\x1b[0m y");
		expect(out).toContain("\x1b[2m────────────────────────\x1b[0m");
		expect(out).toContain("中文段落不受影响");
		expect(out).not.toContain("###");
		expect(out).not.toContain("**");
	});

	it("fenced code: markers dim, content indented 2, fences respected", () => {
		const out = renderMarkdownLite("before\n```js\nconst a = 1;\n```\nafter", true);
		expect(out).toContain("\x1b[2m```js\x1b[0m");
		expect(out).toContain("  const a = 1;");
		expect(out).toContain("after");
	});

	it("fast path: text without markdown markers passes through untouched", () => {
		const plain = "just a plain sentence\nsecond line";
		expect(renderMarkdownLite(plain, true)).toBe(plain);
	});

	it("ansi=false is the identity transform", () => {
		const src = "### T\n- **b**\n```x\ny\n```";
		expect(renderMarkdownLite(src, false)).toBe(src);
	});
});
