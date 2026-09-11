import { describe, expect, it } from "vitest";
import { Renderer } from "../src/render.js";

// ── #thinking-levels: dim thinking sections in the stream ───────────────

describe("Renderer thinking (#thinking-levels)", () => {
	function makeRenderer(): { out: () => string; r: Renderer } {
		const chunks: string[] = [];
		const r = new Renderer({
			write: (s) => chunks.push(s),
			ansi: true,
			liveTools: false,
			toolStyle: "one-line",
		});
		return { out: () => chunks.join(""), r };
	}

	it("#thinking-stream: completed paragraphs render DURING the stream (pi parity), not at flush time", () => {
		const writes: string[] = [];
		const r = new Renderer({
			write: (s) => writes.push(s),
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
		});
		r.event({ type: "thinking_delta", text: "paragraph one, still growing" });
		r.event({ type: "thinking_delta", text: "\n\n" }); // blank line — block completes
		expect(writes.join("")).toContain("paragraph one, still growing"); // ALREADY on screen
		r.event({ type: "thinking_delta", text: "paragraph two unfinished" });
		expect(writes.join("")).not.toContain("paragraph two"); // held until complete
		r.event({ type: "text_delta", text: "the answer" });
		const text = writes.join("");
		expect(text).toContain("paragraph two unfinished"); // flushed by the answer
		expect(text.indexOf("paragraph one")).toBeLessThan(text.indexOf("paragraph two"));
		expect(text.indexOf("paragraph two")).toBeLessThan(text.indexOf("the answer"));
	});

	it("thinking deltas flush as ONE dim italic section before the answer; answer stays plain", () => {
		const { out, r } = makeRenderer();
		r.event({ type: "thinking_delta", text: "step one " });
		r.event({ type: "thinking_delta", text: "step two" });
		r.event({ type: "text_delta", text: "the answer" });
		r.endRun();
		const text = out();
		expect(text).toContain("\x1b[2mstep one step two"); // dim
		expect(text).toContain("\x1b[3m"); // italic
		expect(text).toContain("the answer");
		expect(text.indexOf("step one")).toBeLessThan(text.indexOf("the answer"));
		// the answer is NOT dim: a fresh plain run after the section
		const answerAt = text.indexOf("the answer");
		expect(text.slice(Math.max(0, answerAt - 10), answerAt)).not.toContain("\x1b[2m");
	});

	it("piped output (ansi=false): the trace is plain text — ZERO escape bytes (print contract)", () => {
		const chunks: string[] = [];
		const r = new Renderer({
			write: (s2) => chunks.push(s2),
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
		});
		r.event({ type: "thinking_delta", text: "quiet trace" });
		r.event({ type: "text_delta", text: "answer" });
		r.endRun();
		const text = chunks.join("");
		expect(text).toContain("quiet trace");
		expect(text).not.toContain("\x1b"); // review P1: no dim, no italic, nothing
	});

	it("a trace-only turn (aborted before text) still renders its section via endRun", () => {
		const { out, r } = makeRenderer();
		r.event({ type: "thinking_delta", text: "half a thought" });
		r.endRun();
		expect(out()).toContain("\x1b[2mhalf a thought");
	});
});

describe("hideThinking (pi's ctrl+t)", () => {
	it("hidden: the full trace NEVER renders — one dim label per section (pi's Thinking...)", () => {
		const chunks: string[] = [];
		const r = new Renderer({
			write: (t) => chunks.push(t),
			ansi: true,
			liveTools: false,
			toolStyle: "one-line",
		});
		r.hideThinking = true;
		r.event({ type: "thinking_delta", text: "secret reasoning step one" });
		r.event({ type: "text_delta", text: "the answer" });
		r.endRun();
		const text = chunks.join("");
		expect(text).toContain("Thinking...");
		expect(text).not.toContain("secret reasoning step one");
	});

	it("constructor option seeds the flag (pi's persisted getHideThinkingBlock)", () => {
		const r = new Renderer({
			write: () => {},
			ansi: false,
			liveTools: false,
			toolStyle: "one-line",
			hideThinking: true,
		});
		expect(r.hideThinking).toBe(true);
	});
});
