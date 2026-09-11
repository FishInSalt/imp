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

	it("a trace-only turn (aborted before text) still renders its section via endRun", () => {
		const { out, r } = makeRenderer();
		r.event({ type: "thinking_delta", text: "half a thought" });
		r.endRun();
		expect(out()).toContain("\x1b[2mhalf a thought");
	});
});
