import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExtensions } from "../src/extensions/loader.js";
import { ExtensionRegistry, NO_CONFIRM_LINE } from "../src/extensions/registry.js";
import type { ConfirmOptions } from "../src/extensions/types.js";
import { ReplInput } from "../src/repl/input.js";
import type { LineInput, SelectOptions } from "../src/repl/line-input.js";
import { TtyConfirm } from "../src/repl/repl.js";
import { makeRenderer } from "./helpers/fakes.js";

beforeEach(() => {
	vi.stubEnv("INK_LOG", "0");
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
	const pickAnswer = { value: 0 as number | null | "timeout" };
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
	it("#confirm-prompt (Phase 3 D9): the 4th argument names the caller; the record line carries it", async () => {
		const host = makeConfirmHost();
		await host.confirm.handler("allow this bash command?", "why it matched: risky", undefined, "guardian");
		expect(host.output()).toContain("▪ confirm: guardian — allow this bash command?");
		// the picker carries the same host-derived attribution (D9), which now
		// labels the picker's SectionRule (Phase 4 D14) — the title stays bare
		expect(host.picks[0]?.attribution).toBe("guardian");
		// without a source the bytes are exactly today's (no separator appears)
		await host.confirm.handler("plain question");
		expect(host.output()).toContain("▪ confirm: plain question");
		expect(host.output()).not.toContain("▪ confirm:  —");
		// an EMPTY-string source is treated exactly like an absent one (the
		// blockSource/record-line empty guards), not as a ` — ` prefix.
		const beforeEmpty = host.output().length;
		await host.confirm.handler("empty source question", undefined, undefined, "");
		const emptyLine = host.output().slice(beforeEmpty);
		expect(emptyLine).toContain("▪ confirm: empty source question");
		expect(emptyLine).not.toContain("▪ confirm:  —");
		// the empty string flows through as-is; the shell treats "" as no tag
		expect(host.picks.at(-1)?.attribution).toBe("");
		// session-allowlist note keeps the same prefix shape (the pick answer is
		// "Yes, don't ask again this session" — index 1)
		host.pickAnswer.value = 1;
		await host.confirm.handler("remember me", undefined, { sessionKey: "d9:k" }, "guardian");
		// same key, second ask: no picker, straight approval, prefixed audit note
		await host.confirm.handler("remember me", undefined, { sessionKey: "d9:k" }, "guardian");
		expect(host.output()).toContain("▪ confirm: guardian — remember me — allowed for this session");
	});

	it("#confirm-prompt (Phase 3 D9): the loader's api closure passes facts.name as the confirm source", async () => {
		const seen: Array<{ message: string; source?: string }> = [];
		const dir = await mkdtemp(path.join(tmpdir(), "imp-d9-"));
		await writeFile(
			path.join(dir, "asker.mjs"),
			`export default async function (api) {\n\tawait api.confirm("really?");\n}\n`,
		);
		const loaded = await loadExtensions({
			cwd: dir,
			cliPaths: [path.join(dir, "asker.mjs")],
			noDiscovery: true,
			confirm: (message, _detail, _options, source) => {
				seen.push({ message, source });
				return Promise.resolve(false);
			},
		});
		expect(loaded.failures).toEqual([]);
		// the loader closure calls registry.confirm with facts.name (module basename)
		expect(seen).toEqual([{ message: "really?", source: "asker" }]);
	});

	it("#confirm-prompt (Phase 3 D9): a direct registry call passes the source through; ConfirmOptions gained no field", async () => {
		const seen: Array<string | undefined> = [];
		const confirm = (
			_message: string,
			_detail?: string,
			_options?: ConfirmOptions,
			source?: string,
		): Promise<boolean> => {
			seen.push(source);
			return Promise.resolve(false);
		};
		const registry = new ExtensionRegistry({ confirm });
		registry.beginExtension("probe_ext", "cli");
		await registry.confirm("ask one");
		expect(seen).toEqual([undefined]); // absent stays absent
		await registry.confirm("ask two", undefined, undefined, "probe_ext");
		expect(seen).toEqual([undefined, "probe_ext"]);
		// the extension-facing facade is unchanged: the options bag is (message,
		// detail, options) and ConfirmOptions has no source field — an extension
		// cannot set or spoof the label.
		const options: ConfirmOptions = { sessionKey: "k", rememberLabel: "this command pattern" };
		expect(Object.keys(options)).toEqual(["sessionKey", "rememberLabel"]);
		// and the public registry seam still takes exactly four declared parameters
		expect(ExtensionRegistry.prototype.confirm.length).toBe(4);
	});

	it('a picker-bound host asks via the three options; "don\'t ask again" approves AND remembers the key', async () => {
		const host = makeConfirmHost();
		host.pickAnswer.value = 1; // "Yes, don't ask again this session"
		await expect(
			host.confirm.handler(
				"[guardian] allow this bash command?",
				"rm -rf node_modules\nwhy it matched: risky",
				{
					sessionKey: "guardian:bash:rm",
					warnSpans: [[9, 15]], // the gated fragment inside the detail
				},
			),
		).resolves.toBe(true);
		expect(host.picks).toHaveLength(1);
		expect(host.picks[0]?.title).toBe("[guardian] allow this bash command?");
		// the detail rides in the picker itself now (not only transcript notes)
		expect(host.picks[0]?.detail).toBe("rm -rf node_modules\nwhy it matched: risky");
		// and warnSpans survive the whole chain: extension → confirm options → picker
		expect(host.picks[0]?.warnSpans).toEqual([[9, 15]]);
		expect(host.picks[0]?.items.map((item) => item.label)).toEqual([
			"Yes",
			"Yes, don't ask again this session",
			"No",
		]);
		// the note lines keep the title only — the picker carries the detail (Phase 1 D1)
		expect(host.output()).toContain("▪ confirm: [guardian] allow this bash command?");
		expect(host.output()).not.toContain("  rm -rf node_modules");
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

	it("#confirm-prompt: a no-picker host keeps BOTH notes — the detail note is its only carrier (Phase 1 D1)", async () => {
		const host = makeConfirmHost({ select: false });
		await expect(
			host.confirm.handler(
				"[guardian] allow this bash command?",
				"rm -rf node_modules\nwhy it matched: risky",
			),
		).resolves.toBe(true);
		expect(host.questions).toEqual(["proceed? [y/N] "]); // the ask path ran
		expect(host.picks).toHaveLength(0);
		expect(host.output()).toContain("▪ confirm: [guardian] allow this bash command?");
		expect(host.output()).toContain("  rm -rf node_modules"); // the only place it reaches this host
	});

	it("#confirm-prompt (Phase 2): rememberLabel lands in the remember option; the preview reaches the picker, not the notes (D7)", async () => {
		const host = makeConfirmHost();
		host.pickAnswer.value = 2; // "No"
		await expect(
			host.confirm.handler("[guardian] allow this bash command?", "why it matched: recursive force delete", {
				sessionKey: "guardian:bash:rm",
				rememberLabel: "this command pattern",
				preview: { kind: "command", tool: "bash", text: "rm -rf node_modules", warnSpans: [[0, 6]] },
			}),
		).resolves.toBe(false);
		expect(host.picks[0]?.items.map((item) => item.label)).toEqual([
			"Yes",
			"Yes, don't ask again this session (this command pattern)",
			"No",
		]);
		expect(host.picks[0]?.preview).toEqual({
			kind: "command",
			tool: "bash",
			text: "rm -rf node_modules",
			warnSpans: [[0, 6]],
		});
		// the picker carries the preview, so the transcript must not repeat it
		expect(host.output()).not.toContain("● bash");
	});

	it("#confirm-prompt (Phase 2): a text host gets the preview as one plain note line — the command is still shown once (D7)", async () => {
		const host = makeConfirmHost({ select: false });
		await expect(
			host.confirm.handler("[guardian] allow this bash command?", "why it matched: recursive force delete", {
				preview: { kind: "command", tool: "bash", text: "rm -rf node_modules", warnSpans: [[0, 6]] },
			}),
		).resolves.toBe(true);
		expect(host.questions).toEqual(["proceed? [y/N] "]);
		expect(host.output()).toContain("▪ confirm: [guardian] allow this bash command?");
		expect(host.output()).toContain("why it matched: recursive force delete"); // the detail note stays (D1)
		expect(host.output()).toContain("● bash  rm -rf node_modules"); // one plain line, no ANSI
		expect(host.output().split("rm -rf node_modules").length - 1).toBe(1);
	});

	it("#guardian-auto-mode (D13): a fresh confirm has no remember option — and No is index 1", async () => {
		const host = makeConfirmHost();
		// The auto/shadow fallback shape: no sessionKey => no memory to offer,
		// so the picker must not promise one (the old three-option shape lied).
		host.pickAnswer.value = 1;
		await expect(
			host.confirm.handler(
				"allow this bash command?",
				"why it matched: recursive force delete",
				{
					preview: { kind: "command", tool: "bash", text: "rm -rf -- /tmp/imp-verify", warnSpans: [[0, 6]] },
				},
				"guardian",
			),
		).resolves.toBe(false); // index 1 is No here — the 3-option mapping would have approved
		expect(host.picks[0]?.items.map((item) => item.label)).toEqual(["Yes", "No"]);
		// Yes stays index 0
		host.pickAnswer.value = 0;
		await expect(host.confirm.handler("q", undefined, undefined, "guardian")).resolves.toBe(true);
		// a sessionKey keeps the M10 three-option contract byte for byte
		host.pickAnswer.value = 2;
		await expect(host.confirm.handler("q2", undefined, { sessionKey: "k" })).resolves.toBe(false);
		expect(host.picks.at(-1)?.items.map((item) => item.label)).toEqual([
			"Yes",
			"Yes, don't ask again this session",
			"No",
		]);
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

	it("#ask-timeout: the deadline rides the picker options — forwarded only when set", async () => {
		const host = makeConfirmHost();
		host.pickAnswer.value = 0;
		await expect(host.confirm.handler("m", undefined, { timeoutMs: 600000 })).resolves.toBe(true);
		expect(host.picks[0]?.timeoutMs).toBe(600000);
		// unset → the option bag keeps the pre-timeout shape (no undefined key)
		await expect(host.confirm.handler("m2")).resolves.toBe(true);
		expect("timeoutMs" in (host.picks[1] ?? {})).toBe(false);
	});

	it('#ask-timeout: a timed-out picker resolves "timeout" with the record note — and grants no session memory', async () => {
		const host = makeConfirmHost();
		host.pickAnswer.value = "timeout";
		await expect(
			host.confirm.handler(
				"allow this bash command?",
				"why it matched: risky",
				{ sessionKey: "k" },
				"guardian",
			),
		).resolves.toBe("timeout");
		expect(host.output()).toContain("▪ confirm: guardian — allow this bash command? — timed out (declined)");
		// the question was never answered: the key is NOT remembered — it prompts again
		host.pickAnswer.value = 1; // "Yes, don't ask again"
		await expect(host.confirm.handler("q2", undefined, { sessionKey: "k" })).resolves.toBe(true);
		expect(host.picks).toHaveLength(2);
		// now the key IS remembered (the timeout granted nothing; this pick did)
		host.pickAnswer.value = null;
		await expect(host.confirm.handler("q3", undefined, { sessionKey: "k" })).resolves.toBe(true);
		expect(host.picks).toHaveLength(2);
	});

	it("#ask-timeout: a no-picker host ignores the deadline (the [y/N] path stays byte-identical)", async () => {
		const host = makeConfirmHost({ select: false });
		await expect(host.confirm.handler("m", undefined, { timeoutMs: 5 })).resolves.toBe(true);
		expect(host.questions).toEqual(["proceed? [y/N] "]);
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
