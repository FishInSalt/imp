import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_CONFIRM_LINE } from "../src/extensions/registry.js";
import { ReplInput } from "../src/repl/input.js";
import type { LineInput, SelectOptions } from "../src/repl/line-input.js";
import { TtyConfirm } from "../src/repl/repl.js";
import { makeRenderer } from "./helpers/fakes.js";

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

/** A TtyConfirm bound to recording fakes: every picker/ask call is captured,
 *  the next answer is steerable. This is the "fake shell with select" the M10
 *  confirm contract is tested against (the real TuiShell has its own suite). */
function makeConfirmHost(args?: { select?: boolean }) {
	const { renderer, output } = makeRenderer();
	const confirm = new TtyConfirm(renderer);
	const questions: string[] = [];
	const picks: SelectOptions[] = [];
	const pickAnswer = { value: 0 as number | null };
	const askAnswer = { value: true };
	confirm.bind((question: string) => {
		questions.push(question);
		return Promise.resolve(askAnswer.value);
	});
	if (args?.select !== false) {
		confirm.bindSelect((options: SelectOptions) => {
			picks.push(options);
			return Promise.resolve(pickAnswer.value);
		});
	}
	return { confirm, questions, picks, pickAnswer, askAnswer, output };
}

describe("TtyConfirm: three-option confirm + session allowlist (M10)", () => {
	it('a picker-bound host asks via the three options; "don\'t ask again" approves AND remembers the key', async () => {
		const host = makeConfirmHost();
		host.pickAnswer.value = 1; // "Yes, don't ask again this session"
		await expect(
			host.confirm.handler(
				"[guardian] allow this bash command?",
				"rm -rf node_modules\nwhy it matched: risky",
				{
					sessionKey: "guardian:bash:rm",
				},
			),
		).resolves.toBe(true);
		expect(host.picks).toHaveLength(1);
		expect(host.picks[0]?.title).toBe("[guardian] allow this bash command?");
		expect(host.picks[0]?.items.map((item) => item.label)).toEqual([
			"Yes",
			"Yes, don't ask again this session",
			"No",
		]);
		// the note lines keep message + detail (the dim second line)
		expect(host.output()).toContain("▪ confirm: [guardian] allow this bash command?");
		expect(host.output()).toContain("  rm -rf node_modules");
		// same key again: approved WITHOUT a second picker, with an audit note
		await expect(
			host.confirm.handler("[guardian] allow this bash command?", "again", {
				sessionKey: "guardian:bash:rm",
			}),
		).resolves.toBe(true);
		expect(host.picks).toHaveLength(1); // no re-prompt
		expect(host.output()).toContain(
			"▪ confirm: [guardian] allow this bash command? — allowed for this session",
		);
		expect(host.questions).toEqual([]); // the [y/N] path never fired
	});

	it("a different sessionKey still prompts", async () => {
		const host = makeConfirmHost();
		host.pickAnswer.value = 1;
		await host.confirm.handler("m1", undefined, { sessionKey: "guardian:bash:rm" });
		await host.confirm.handler("m2", undefined, { sessionKey: "guardian:write:/proj" });
		expect(host.picks).toHaveLength(2);
	});

	it('"No" declines without remembering; a cancelled picker declines too', async () => {
		const host = makeConfirmHost();
		host.pickAnswer.value = 2; // "No"
		await expect(host.confirm.handler("m", undefined, { sessionKey: "k" })).resolves.toBe(false);
		// declined ⇒ nothing remembered: the same key prompts again
		host.pickAnswer.value = 1;
		await expect(host.confirm.handler("m", undefined, { sessionKey: "k" })).resolves.toBe(true);
		// now remembered: no third picker, straight approval
		host.pickAnswer.value = null;
		await expect(host.confirm.handler("m", undefined, { sessionKey: "k" })).resolves.toBe(true);
		expect(host.picks).toHaveLength(2);
		// a cancelled picker on a fresh key declines (same as Ctrl+C at the ask)
		await expect(host.confirm.handler("m", undefined, { sessionKey: "other" })).resolves.toBe(false);
		expect(host.picks).toHaveLength(3);
	});

	it('a plain "Yes" (index 0) approves once and still asks next time', async () => {
		const host = makeConfirmHost();
		host.pickAnswer.value = 0;
		await expect(host.confirm.handler("m", undefined, { sessionKey: "k" })).resolves.toBe(true);
		await expect(host.confirm.handler("m", undefined, { sessionKey: "k" })).resolves.toBe(true);
		expect(host.picks).toHaveLength(2); // one-shot approval never writes the allowlist
	});

	it("without a picker the [y/N] ask path runs verbatim (readline shell, byte-identical)", async () => {
		const host = makeConfirmHost({ select: false });
		await expect(host.confirm.handler("m", "d", { sessionKey: "k" })).resolves.toBe(true);
		expect(host.questions).toEqual(["proceed? [y/N] "]);
		expect(host.picks).toEqual([]);
		host.askAnswer.value = false;
		await expect(host.confirm.handler("m2")).resolves.toBe(false);
		expect(host.questions).toEqual(["proceed? [y/N] ", "proceed? [y/N] "]);
	});

	it("an unbound host (scripted mode, tests) declines with the one stderr teaching line", async () => {
		const { renderer } = makeRenderer();
		const confirm = new TtyConfirm(renderer);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await expect(confirm.handler("m")).resolves.toBe(false);
			expect(stderr).toHaveBeenCalledTimes(1);
			expect(String(stderr.mock.calls[0]?.[0])).toBe(NO_CONFIRM_LINE);
		} finally {
			stderr.mockRestore();
		}
	});
});

describe("LineInput contract: the M10 optional setQueue stays optional", () => {
	it("the readline shell (ReplInput) still satisfies LineInput without the TUI-only optionals", () => {
		const input: LineInput = new ReplInput({
			input: new PassThrough(),
			output: { write: () => {} },
			interactive: false,
			onLine: () => {},
			onInterrupt: () => {},
			onEof: () => {},
		});
		// optional affordances are simply absent on the readline shell — the
		// machine's `?.` call sites must keep working without them
		expect(input.setQueue).toBeUndefined();
		expect(input.select).toBeUndefined();
		expect(input.setFooter).toBeUndefined();
		input.close();
	});
});
