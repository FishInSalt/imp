import { describe, expect, it } from "vitest";
import { ReplInput } from "../src/repl/input.js";
import { makeConsole, ticks } from "./helpers/fakes.js";

function makeInput(options?: { tty?: boolean; onLine?: (l: string) => void }) {
	const fake = makeConsole({ tty: options?.tty ?? true });
	const events: string[] = [];
	const input = new ReplInput({
		input: fake.stdin,
		output: fake.stdout,
		interactive: options?.tty ?? true,
		onLine: (line) => {
			events.push(`line:${line}`);
			options?.onLine?.(line);
		},
		onInterrupt: () => events.push("interrupt"),
		onEof: () => events.push("eof"),
	});
	return { fake, input, events };
}

describe("ReplInput", () => {
	it("routes lines through one handler whether idle or active (state decides, not input)", async () => {
		const { fake, input, events } = makeInput();
		input.start();
		fake.send("hello\n");
		await ticks();
		input.setActive(true); // a run is "active" — same routing
		fake.send("steer me\n");
		await ticks();
		expect(events).toEqual(["line:hello", "line:steer me"]);
		input.close();
	});

	it('prompt switches "> " ↔ "+ "; non-interactive writes no prompt bytes', async () => {
		const { fake, input } = makeInput({ tty: true });
		input.start();
		expect(fake.output()).toContain("> ");
		input.setActive(true);
		expect(fake.output()).toContain("+ ");
		input.setActive(false);
		// prompt redraws carry cursor-position escapes; compare positions instead
		expect(fake.output().lastIndexOf("> ")).toBeGreaterThan(fake.output().lastIndexOf("+ "));
		input.refresh();
		input.close();

		const scripted = makeInput({ tty: false });
		scripted.input.start();
		scripted.fake.send("a\nb\n");
		await ticks();
		expect(scripted.fake.output()).toBe(""); // clean pipe output
		scripted.input.close();
	});

	it("send(\\x03) → onInterrupt; send(\\x04)/eof() → onEof after buffered lines", async () => {
		const { fake, input, events } = makeInput();
		input.start();
		fake.interrupt();
		await ticks();
		expect(events).toEqual(["interrupt"]);
		fake.send("buffered\n");
		fake.send("\x04");
		await ticks();
		expect(events).toEqual(["interrupt", "line:buffered", "eof"]);
		input.close();

		const second = makeInput();
		second.input.start();
		second.fake.send("one\n");
		second.fake.eof();
		await ticks();
		expect(second.events).toEqual(["line:one", "eof"]);
		second.input.close();
	});

	it("history: consecutive dups dropped, empties skipped, capped at 100", async () => {
		const { fake, input } = makeInput();
		input.start();
		fake.send("one\n");
		fake.send("one\n");
		fake.send("two\n");
		fake.send("\n");
		fake.send("three\n");
		await ticks();
		expect(input.getHistory()).toEqual(["three", "two", "one"]);
		input.close();

		const cap = makeInput();
		cap.input.start();
		for (let i = 0; i < 110; i++) cap.fake.send(`line-${i}\n`);
		await ticks(16);
		expect(cap.input.getHistory().length).toBe(100);
		expect(cap.input.getHistory()).toContain("line-109");
		expect(cap.input.getHistory()).not.toContain("line-0");
		cap.input.close();
	});

	it("clearPending wipes typed-but-unsubmitted text and reports it", async () => {
		const { fake, input, events } = makeInput();
		input.start();
		fake.send("partial"); // no newline — stays in the buffer
		await ticks();
		expect(input.clearPending()).toBe(true);
		expect(input.clearPending()).toBe(false); // second time: nothing to clear
		fake.send("new\n"); // must NOT become "partialnew"
		await ticks();
		expect(events).toEqual(["line:new"]);
		input.close();
	});
});
