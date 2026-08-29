import { describe, expect, it } from "vitest";
import type { ToolResult } from "../src/core/messages.js";
import { Renderer } from "../src/repl/render.js";
import type { AgentEvent } from "../src/core/loop.js";

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

const okResult = (content: string): ToolResult => ({
	toolCallId: "t1",
	toolName: "bash",
	content,
	isError: false,
});
const errResult = (content: string): ToolResult => ({
	toolCallId: "t1",
	toolName: "bash",
	content,
	isError: true,
});

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
		expect(out.output()).toBe("Hello world\n● bash $ ls ✓\ndone\n");
	});

	it("one-line live tool formats: pending rewrite, ✓ with duration (injected clock), ✗ error", () => {
		let now = 0;
		const out = collector();
		const r = new Renderer({
			write: out.write,
			ansi: true,
			liveTools: true,
			toolStyle: "one-line",
			clock: () => now,
		});
		// pending: dim, ends with " …", \r\x1b[2K prefix, no newline
		r.event({ type: "tool_start", toolCallId: "t1", name: "bash", args: { command: "npm test" } });
		expect(out.output()).toBe("\r\x1b[2K\x1b[2m● bash $ npm test …\x1b[0m");
		// success with 12.4s duration (duration outside the dim wrap)
		now = 12400;
		r.event({ type: "tool_end", result: okResult("all good") });
		expect(out.output()).toBe(
			"\r\x1b[2K\x1b[2m● bash $ npm test …\x1b[0m\r\x1b[2K\x1b[2m● bash $ npm test ✓\x1b[0m 12.4s\n",
		);
		// fast tool: no duration
		r.event({ type: "tool_start", toolCallId: "t2", name: "bash", args: { command: "true" } });
		now += 400;
		r.event({ type: "tool_end", result: okResult("") });
		expect(out.output().endsWith("\x1b[2m● bash $ true ✓\x1b[0m\n")).toBe(true);
		// error: dim base + red firstLine(content, 120)
		const long = "x".repeat(130);
		r.event({ type: "tool_start", toolCallId: "t3", name: "bash", args: { command: "cat nope" } });
		r.event({ type: "tool_end", result: errResult(long) });
		expect(out.output().endsWith(
			`\r\x1b[2K\x1b[2m● bash $ cat nope ✗ \x1b[0m\x1b[31m${"x".repeat(120)}…\x1b[0m\n`,
		)).toBe(true);
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
				"\n\x1b[2m● read {\"path\":\"x.ts\"}\x1b[0m\n" +
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
		expect(out.output()).toBe("● bash $ ls ✓\n▪ a note\nimp: boom\nplain line\n");
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
});
