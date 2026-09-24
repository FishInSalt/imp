import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { Fold } from "../src/repl/components/fold.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { visibleWidth } from "../src/tui.js";

const rows = (sink: TranscriptSink, width = 80): string[] => sink.render(width).map(stripVTControlCharacters);

describe("semantic transcript thinking", () => {
	it("reveals completed paragraphs and an active tail without another delta", () => {
		const sink = new TranscriptSink();
		const section = sink.thinkingSink.begin();
		section.append(" first\n\nsecond\n\npar");
		expect(rows(sink)).toEqual(["first", "", "second", "", "par"]);
		for (let i = 0; i < 3; i++) {
			sink.thinkingSink.setHidden(true);
			expect(rows(sink)).toEqual(["Thinking..."]);
			sink.thinkingSink.setHidden(false);
			expect(rows(sink)).toEqual(["first", "", "second", "", "par"]);
		}
		section.end();
		section.end();
		expect(rows(sink)).toEqual(["first", "", "second", "", "par", ""]);
		expect(sink.completedLines()).toEqual([]);
		expect(sink.render(80)[0]).toContain("\x1b[3m\x1b[2m");
	});

	it("retains initially hidden chunks, suppresses empty placeholders and redundant repaint", () => {
		const sink = new TranscriptSink();
		sink.thinkingSink.setHidden(true);
		const section = sink.thinkingSink.begin();
		sink.onUpdate = vi.fn();
		section.append(" \n\t");
		expect(rows(sink)).toEqual([]);
		expect(sink.onUpdate).not.toHaveBeenCalled();
		section.append("partial");
		expect(rows(sink)).toEqual(["Thinking..."]);
		expect(sink.onUpdate).toHaveBeenCalledTimes(1);
		section.append(" tail");
		expect(sink.onUpdate).toHaveBeenCalledTimes(1);
		sink.thinkingSink.setHidden(false);
		expect(rows(sink)).toEqual(["partial tail"]);
	});

	it("invalidates an expanded cache after hidden appends, resize and end", () => {
		const sink = new TranscriptSink();
		const section = sink.thinkingSink.begin();
		section.append("alpha");
		expect(rows(sink)).toEqual(["alpha"]);
		sink.thinkingSink.setHidden(true);
		section.append("\nbeta");
		rows(sink, 3);
		section.end();
		sink.thinkingSink.setHidden(false);
		expect(rows(sink, 80)).toEqual(["alpha", "beta", ""]);
		section.append("ignored after end");
		expect(rows(sink, 80)).toEqual(["alpha", "beta", ""]);
	});

	it.each([1, 2, 5, 20])("bounds ANSI and CJK content at width %s", (width) => {
		const sink = new TranscriptSink();
		const section = sink.thinkingSink.begin();
		section.append("\x1b[31m中文abc\x1b[0m\n\n尾部");
		for (const hidden of [false, true, false]) {
			sink.thinkingSink.setHidden(hidden);
			for (const row of sink.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("preserves ordinary tails, fold identity/state, user blocks and status adjacency", () => {
		const sink = new TranscriptSink();
		sink.feed("tail");
		const fold = new Fold("tool", ["result"]);
		fold.setExpanded(true);
		sink.appendChild(fold);
		sink.feed("next\n");
		sink.feedStatus("before");
		const section = sink.thinkingSink.begin();
		section.append("reason");
		section.end();
		sink.feedStatus("after");
		sink.feedStatus("replacement");
		sink.feedUser("user");
		const before = rows(sink);
		expect(before[0]).toBe("tail");
		expect(before.join("\n")).toMatch(
			/tail[\s\S]*tool[\s\S]*result[\s\S]*next[\s\S]*before[\s\S]*reason[\s\S]*replacement[\s\S]*user/,
		);
		sink.thinkingSink.setHidden(true);
		sink.thinkingSink.setHidden(false);
		expect(rows(sink)).toEqual(before);
		expect(fold.isExpanded()).toBe(true);
		expect(sink.completedLines().map(stripVTControlCharacters)).toEqual([
			"tail",
			"next",
			"before",
			"replacement",
			"",
			"user",
			"",
		]);
	});

	it.each(["thinking", "fold", "user", "status"])("settles parser carry literally before %s", (kind) => {
		const sink = new TranscriptSink();
		sink.feed("answer\r");
		if (kind === "thinking") {
			const section = sink.thinkingSink.begin();
			section.append("reason");
			section.end();
		} else if (kind === "fold") sink.appendChild(new Fold("tool"));
		else if (kind === "user") sink.feedUser("user");
		else sink.feedStatus("status");
		sink.feed("\x1b[2Knext\n");
		expect(sink.completedLines()[0]).toBe("answer\r");
		expect(sink.completedLines().at(-1)).toBe("\x1b[2Knext");
		if (kind === "thinking") expect(rows(sink)).toContain("reason");
	});

	it.each([1, 2, 3, 4])("recognizes reset split at byte %s, even after text", (split) => {
		const sink = new TranscriptSink();
		const marker = "\r\x1b[2K";
		sink.feed(`discard${marker.slice(0, split)}`);
		sink.feed(`${marker.slice(split)}replacement\n`);
		expect(sink.completedLines()).toEqual(["replacement"]);
	});

	it("clear drops current text, carry and old handles but preserves visibility", () => {
		const sink = new TranscriptSink();
		sink.thinkingSink.setHidden(true);
		const old = sink.thinkingSink.begin();
		old.append("old");
		sink.feed("current\r\x1b[");
		sink.clear();
		old.append("stale");
		old.end();
		expect(rows(sink)).toEqual([]);
		const fresh = sink.thinkingSink.begin();
		fresh.append("fresh");
		expect(rows(sink)).toEqual(["Thinking..."]);
		sink.thinkingSink.setHidden(false);
		expect(rows(sink)).toEqual(["fresh"]);
	});

	it("keeps ordinary wrap caches and does not rewrap hidden bodies", () => {
		const sink = new TranscriptSink();
		sink.feed("ordinary\n");
		const section = sink.thinkingSink.begin();
		section.append("reason");
		sink.render(80);
		const wrap = vi.spyOn(sink as unknown as { wrapLine(text: string, width: number): string[] }, "wrapLine");
		sink.thinkingSink.setHidden(true);
		sink.render(80);
		wrap.mockClear();
		section.append(" more");
		sink.render(80);
		expect(wrap).not.toHaveBeenCalled();
		sink.thinkingSink.setHidden(false);
		sink.render(80);
		expect(wrap).toHaveBeenCalledTimes(1);
	});
});
