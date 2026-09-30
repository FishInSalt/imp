import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ClassifyRequest,
	ClassifyResult,
	ExtensionApi,
	ToolCallEvent,
} from "../src/extensions/types.js";
import { CLASSIFY_MAX_INPUT_CHARS } from "../src/repl/classify.js";

// #guardian-auto-mode Wave 3: the guardian consumer against a fake api — the
// example-extension test pattern (no REPL, no LLM, no network). Tests 14-44 of
// the design's pin list, guardian side (§13: 28-30; §14: 31-44).

let fakeHome = "";

beforeEach(async () => {
	fakeHome = await mkdtemp(path.join(os.tmpdir(), "imp-guardian-auto-"));
	vi.stubEnv("HOME", fakeHome); // floors, audit path and ~/.imp/guardian.json
});

interface Harness {
	api: ExtensionApi;
	gate: (event: Partial<ToolCallEvent>) => Promise<unknown>;
	gateRaw: (event: ToolCallEvent) => Promise<unknown>;
	confirm: ReturnType<typeof vi.fn>;
	classify: ReturnType<typeof vi.fn>;
	classifyImpl: { fn: (request: ClassifyRequest) => Promise<ClassifyResult | undefined> };
	commands: Map<string, { run: (args: string, ctx: unknown) => unknown }>;
	notes: string[];
	statuses: Array<[string, string | undefined]>;
	run: (line: string) => Promise<unknown>;
}

function fakeApi(cwd: string): Harness {
	const handlers: Record<string, (event: ToolCallEvent) => unknown> = {};
	const commands = new Map<string, { run: (args: string, ctx: unknown) => unknown }>();
	const notes: string[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const confirm = vi.fn(async () => false);
	const classifyImpl: { fn: (request: ClassifyRequest) => Promise<ClassifyResult | undefined> } = {
		fn: async () => undefined,
	};
	const classify = vi.fn(async (request: ClassifyRequest) => classifyImpl.fn(request));
	const api = {
		cwd,
		version: "test",
		origin: "project",
		registerTool: () => {},
		registerCommand: (command: { name: string; run: (args: string, ctx: unknown) => unknown }) => {
			commands.set(command.name, command);
		},
		registerContext: () => {},
		on: (event: string, handler: (event: ToolCallEvent) => unknown) => {
			handlers[event] = handler;
		},
		setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
		confirm,
		classify,
	} as unknown as ExtensionApi;
	const gate = (event: Partial<ToolCallEvent>): Promise<unknown> =>
		(handlers.tool_call as (e: ToolCallEvent) => Promise<unknown>)({
			type: "tool_call",
			toolCallId: "t1",
			name: "bash",
			args: {},
			verifiedUserContext: true,
			...event,
		} as ToolCallEvent);
	/** The raw handler call — no default field injection (absence tests). */
	const gateRaw = (event: ToolCallEvent): Promise<unknown> =>
		(handlers.tool_call as (e: ToolCallEvent) => Promise<unknown>)(event);
	const run = async (line: string): Promise<unknown> => {
		const [name, ...rest] = line.trim().split(/\s+/);
		const command = commands.get((name ?? "").replace(/^\//, ""));
		if (command === undefined) throw new Error(`no command ${name}`);
		return command.run(rest.join(" "), { renderer: { note: (text: string) => notes.push(text) } });
	};
	return { api, gate, gateRaw, confirm, classify, classifyImpl, commands, notes, statuses, run };
}

async function loadGuardian(cwd: string): Promise<Harness> {
	const mod = (await import(pathToFileURL(path.resolve("examples/extensions/guardian.mjs")).href)) as {
		default: (api: ExtensionApi) => void;
	};
	const harness = fakeApi(cwd);
	mod.default(harness.api);
	return harness;
}

const writeConfig = async (config: unknown): Promise<void> => {
	const dir = path.join(fakeHome, ".imp");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "guardian.json"), JSON.stringify(config));
};

const risky = "rm -rf /tmp/imp-guardian-auto-target"; // matches the rm rule, no floor

/** §14 write/edit gate events (target outside the caller cwd, payload verbatim). */
const writeCall = (
	target: string,
	content = "probe",
	extra: Partial<ToolCallEvent> = {},
): Partial<ToolCallEvent> => ({
	name: "write",
	args: { path: target, content },
	cwd: "/proj",
	...extra,
});
const editCall = (
	target: string,
	edits: Array<{ oldText: string; newText: string }>,
	extra: Partial<ToolCallEvent> = {},
): Partial<ToolCallEvent> => ({ name: "edit", args: { path: target, edits }, cwd: "/proj", ...extra });

const verdict = (v: "allow" | "ask", reason: string): ClassifyResult => ({
	verdict: v,
	reason,
	model: "anthropic/session-model",
});

describe("guardian auto mode (#guardian-auto-mode Phase A)", () => {
	it("27: a config-set mode reaches the footer at load (fix round)", async () => {
		// A session that STARTS in shadow (config default) must show it before
		// the first /guardian command — otherwise the user cannot tell the mode.
		// The host replays load-time statuses when the machine starts (repl.ts).
		const plain = await loadGuardian("/proj");
		expect(plain.statuses).toEqual([["mode", undefined]]); // manual: silent no-op
		await writeConfig({ auto: { mode: "shadow" } });
		const shadow = await loadGuardian("/proj");
		expect(shadow.statuses).toEqual([["mode", "guardian: shadow"]]);
	});

	it("14: the hard floor never reaches the classifier, even in auto", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		const decision = await h.gate({ args: { command: "rm -rf /etc" } });
		expect(decision).toMatchObject({ block: true });
		expect(h.classify).not.toHaveBeenCalled();
	});

	it("15: auto + allow runs without asking", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("allow", "removing a scratch dir");
		expect(await h.gate({ args: { command: risky } })).toBeUndefined();
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it("16: auto + ask asks fresh (no sessionKey) with the classifier's reason", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("ask", "not clearly within the user's request");
		const decision = await h.gate({ args: { command: risky } });
		expect(decision).toMatchObject({ block: true }); // confirm answered false
		expect(h.confirm).toHaveBeenCalledTimes(1);
		const [, detail, options] = h.confirm.mock.calls[0] ?? [];
		expect(String(detail)).toContain("classifier: ask — not clearly within the user's request");
		expect(options).not.toHaveProperty("sessionKey");
		expect(options).not.toHaveProperty("rememberLabel");
	});

	it("17: auto + classifier unavailable asks fresh", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => undefined;
		await h.gate({ args: { command: risky } });
		expect(String(h.confirm.mock.calls[0]?.[1])).toContain("classifier unavailable");
	});

	it("18: three non-allows trip the breaker back to manual; shadow never flips", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("ask", "unsure");
		for (let i = 0; i < 3; i++) await h.gate({ args: { command: risky } });
		expect(h.statuses.at(-1)).toEqual(["mode", undefined]); // back to manual → footer cleared
		const calls = h.classify.mock.calls.length;
		await h.gate({ args: { command: risky } }); // manual now: no classifier
		expect(h.classify.mock.calls.length).toBe(calls);
		expect(String(h.confirm.mock.calls.at(-1)?.[1])).toContain("why it matched");

		const shadow = await loadGuardian("/proj");
		await shadow.run("/guardian shadow");
		shadow.classifyImpl.fn = async () => verdict("ask", "unsure");
		for (let i = 0; i < 4; i++) await shadow.gate({ args: { command: risky } });
		expect(shadow.statuses.at(-1)?.[1]).toContain("shadow"); // never flipped
	});

	it("19: /guardian cycles, sets, reports status and rejects unknown arguments", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian");
		expect(h.notes.at(-1)).toBe("▪ guardian: mode → shadow");
		await h.run("/guardian");
		expect(h.notes.at(-1)).toBe("▪ guardian: mode → auto");
		await h.run("/guardian");
		expect(h.notes.at(-1)).toBe("▪ guardian: mode → manual");
		await h.run("/guardian status");
		expect(h.notes.at(-1)).toContain("▪ guardian: mode manual");
		await h.run("/guardian nonsense");
		expect(h.notes.at(-1)).toContain('unknown argument "nonsense"');
	});

	it("20: config is tolerant, feeds the model, and reload reports what changed", async () => {
		await writeConfig({ auto: { mode: "auto", model: "zai/glm-5.3" } });
		const h = await loadGuardian("/proj");
		h.classifyImpl.fn = async () => verdict("allow", "clearly authorized");
		await h.gate({ args: { command: risky } });
		expect(h.classify.mock.calls[0]?.[0]).toMatchObject({ model: "zai/glm-5.3" });

		// bad JSON: defaults + one diagnostic, the gate stands
		await writeFile(path.join(fakeHome, ".imp", "guardian.json"), "{not json");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const tolerant = await loadGuardian("/proj");
		expect(stderr.mock.calls.some(([line]) => String(line).includes("unreadable"))).toBe(true);
		stderr.mockRestore();
		await tolerant.run("/guardian status");
		// the new tree (shadows the auto mode); classify in auto was skipped
		expect(tolerant.classify).not.toHaveBeenCalled();
		expect(tolerant.notes.at(-1)).toContain("mode manual");

		await writeConfig({ auto: { mode: "shadow" } });
		await tolerant.run("/guardian reload");
		expect(tolerant.notes.at(-1)).toContain("mode manual → shadow");
		expect(tolerant.notes.at(-1)).toContain("model session default → session default");
	});

	// §14 (write-gate classification): the write/edit gate's pins 31-44.
	it("31: §14 — auto + write outside + allow runs unprompted; the prompt carries tool/path/payload", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("allow", "the probe matches the task");
		expect(await h.gate(writeCall("/outside/file.txt", "let x = 1;"))).toBeUndefined();
		expect(h.confirm).not.toHaveBeenCalled();
		const request = h.classify.mock.calls[0]?.[0] as ClassifyRequest;
		expect(request.prompt).toContain("tool: write");
		expect(request.prompt).toContain('path: "/outside/file.txt"');
		expect(request.prompt).toContain('resolved: "/outside/file.txt"');
		expect(request.prompt).toContain("let x = 1;");
		expect(request.prompt).toContain("-----BEGIN PAYLOAD-----");
		expect(request.prompt).toContain("-----END PAYLOAD-----");
	});

	it("32: §14 — auto + ask asks fresh with the reason; decline blocks with the teaching reason", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("ask", "not clearly within the user's request");
		const decision = await h.gate(writeCall("/outside/file.txt"));
		expect(decision).toMatchObject({
			block: true,
			reason:
				"writing outside the project directory (/proj) — keep changes inside it, or hand files beyond the project to the human",
		});
		const [, detail, options] = h.confirm.mock.calls[0] ?? [];
		expect(String(detail)).toContain("classifier: ask — not clearly within the user's request");
		expect(options).not.toHaveProperty("sessionKey");
		expect(options).not.toHaveProperty("rememberLabel");
	});

	it("33: §14 — auto + classifier unavailable asks fresh", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => undefined;
		await h.gate(writeCall("/outside/file.txt"));
		expect(String(h.confirm.mock.calls[0]?.[1])).toContain("classifier unavailable");
	});

	it("34: §14 — auto without verified context never classifies a write (bare events too)", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		await h.gate(writeCall("/outside/file.txt", "probe", { verifiedUserContext: false }));
		expect(h.classify).not.toHaveBeenCalled();
		expect(String(h.confirm.mock.calls[0]?.[1])).toContain("not classified: no verified user context");

		const bare = await loadGuardian("/proj");
		await bare.run("/guardian auto");
		await bare.gateRaw({
			type: "tool_call",
			toolCallId: "t2",
			name: "write",
			args: { path: "/outside/file.txt", content: "x" },
			cwd: "/proj",
		} as ToolCallEvent);
		expect(bare.classify).not.toHaveBeenCalled();
	});

	it("35: §14 — an over-budget write payload is never classified in auto; size counted, breaker counts it", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("allow", "x");
		const big = "x".repeat(CLASSIFY_MAX_INPUT_CHARS);
		await h.gate(writeCall("/outside/big.txt", big));
		expect(h.classify).not.toHaveBeenCalled();
		expect(String(h.confirm.mock.calls[0]?.[1])).toContain(
			"not classified: request exceeds the classifier input budget",
		);
		await h.run("/guardian status");
		expect(h.notes.at(-1)).toContain("size 1");
		await h.gate(writeCall("/outside/big.txt", big));
		await h.gate(writeCall("/outside/big.txt", big));
		await h.run("/guardian status");
		expect(h.notes.at(-1)).toContain("breaker tripped");
	});

	it("36: §14 — shadow classifies writes, then asks fresh; samples stay real judgments", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian shadow");
		h.classifyImpl.fn = async () => verdict("allow", "looks fine");
		h.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await h.gate(writeCall("/outside/a.txt"));
		const options = h.confirm.mock.calls[0]?.[2];
		expect(options).not.toHaveProperty("sessionKey");
		expect(options).not.toHaveProperty("rememberLabel");
		await h.gate(writeCall("/outside/b.txt"));
		expect(h.classify).toHaveBeenCalledTimes(2);
		await h.run("/guardian status");
		expect(h.notes.at(-1)).toContain("allow→human approved 1, denied 1");
	});

	it("37: §14 — shadow cannot classify an over-budget payload either; size counted", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian shadow");
		await h.gate(writeCall("/outside/big.txt", "x".repeat(CLASSIFY_MAX_INPUT_CHARS)));
		expect(h.classify).not.toHaveBeenCalled();
		expect(String(h.confirm.mock.calls[0]?.[1])).toContain(
			"not classified: request exceeds the classifier input budget",
		);
		await h.run("/guardian status");
		expect(h.notes.at(-1)).toContain("size 1");
	});

	it("38: §14 — manual keeps the write gate byte-for-byte (no classify, today's options)", async () => {
		const h = await loadGuardian("/proj");
		h.confirm.mockResolvedValueOnce(true);
		expect(await h.gate(writeCall("/outside/file.txt"))).toBeUndefined();
		expect(h.classify).not.toHaveBeenCalled();
		expect(h.confirm.mock.calls[0]?.[0]).toBe("allow writing outside /proj?");
		expect(h.confirm.mock.calls[0]?.[2]).toEqual({
			sessionKey: "guardian:write:/proj",
			rememberLabel: "this directory",
		});
	});

	it("39: §14 — the write floor still blocks before any classify or confirm", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		const decision = await h.gate(writeCall(path.join(fakeHome, ".ssh", "key"), "secret"));
		expect(decision).toMatchObject({ block: true });
		expect(h.classify).not.toHaveBeenCalled();
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it("40: §14 — the edit tier classifies too; pairs travel verbatim, asks stay fresh", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("allow", "targeted edit matches the task");
		const pairs = [{ oldText: "before", newText: "after" }];
		expect(await h.gate(editCall("/outside/config.txt", pairs))).toBeUndefined();
		expect(h.confirm).not.toHaveBeenCalled();
		const prompt = String((h.classify.mock.calls[0]?.[0] as ClassifyRequest | undefined)?.prompt ?? "");
		expect(prompt).toContain("tool: edit");
		expect(prompt).toContain("1. old: before");
		expect(prompt).toContain("new: after");
		expect(prompt).toContain("-----BEGIN PAYLOAD-----");

		const asking = await loadGuardian("/proj");
		await asking.run("/guardian auto");
		asking.classifyImpl.fn = async () => verdict("ask", "unsure");
		await asking.gate(editCall("/outside/config.txt", pairs));
		expect(asking.confirm.mock.calls[0]?.[2]).not.toHaveProperty("sessionKey");
	});

	it("41: §14 — the shared breaker counts write non-allows; re-arming clears the stale trip note", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("ask", "unsure");
		for (let i = 0; i < 3; i++) await h.gate(writeCall("/outside/file.txt"));
		expect(h.statuses.at(-1)).toEqual(["mode", undefined]); // tripped back to manual
		await h.run("/guardian status");
		expect(h.notes.at(-1)).toContain("breaker tripped");
		await h.run("/guardian auto"); // re-arm
		await h.run("/guardian status");
		expect(h.notes.at(-1)).not.toContain("breaker tripped");
		await h.gate(writeCall("/outside/file.txt"));
		expect(String(h.confirm.mock.calls.at(-1)?.[1])).not.toContain("breaker tripped");

		// an allow resets: 2 non-allows + allow + 2 non-allows stays auto
		const reset = await loadGuardian("/proj");
		await reset.run("/guardian auto");
		reset.classifyImpl.fn = async () => verdict("ask", "unsure");
		await reset.gate(writeCall("/outside/file.txt"));
		await reset.gate(writeCall("/outside/file.txt"));
		reset.classifyImpl.fn = async () => verdict("allow", "fine");
		await reset.gate(writeCall("/outside/file.txt"));
		reset.classifyImpl.fn = async () => verdict("ask", "unsure");
		await reset.gate(writeCall("/outside/file.txt"));
		await reset.gate(writeCall("/outside/file.txt"));
		await reset.run("/guardian status");
		expect(reset.notes.at(-1)).toContain("mode auto");

		const shadow = await loadGuardian("/proj");
		await shadow.run("/guardian shadow");
		shadow.classifyImpl.fn = async () => verdict("ask", "unsure");
		for (let i = 0; i < 4; i++) await shadow.gate(writeCall("/outside/file.txt"));
		expect(shadow.statuses.at(-1)?.[1]).toContain("shadow"); // never flips
	});

	it("42: §14 — the pre-flight boundary mirrors the imported host cap", async () => {
		const cap = CLASSIFY_MAX_INPUT_CHARS;
		const probe = await loadGuardian("/proj");
		await probe.run("/guardian auto");
		probe.classifyImpl.fn = async () => verdict("allow", "x");
		await probe.gate(writeCall("/outside/probe.txt", "P".repeat(10)));
		const first = probe.classify.mock.calls[0]?.[0] as ClassifyRequest;
		const overhead = first.system.length + first.prompt.length - 10;
		expect(overhead).toBeGreaterThan(0);

		const atCap = await loadGuardian("/proj");
		await atCap.run("/guardian auto");
		atCap.classifyImpl.fn = async () => verdict("allow", "x");
		await atCap.gate(writeCall("/outside/probe.txt", "P".repeat(cap - overhead)));
		expect(atCap.classify).toHaveBeenCalledTimes(1);

		const over = await loadGuardian("/proj");
		await over.run("/guardian auto");
		await over.gate(writeCall("/outside/probe.txt", "P".repeat(cap - overhead + 1)));
		expect(over.classify).not.toHaveBeenCalled();
	});

	it("43: §14 — write audit lines are auto-only", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("allow", "fine");
		await h.gate(writeCall("/outside/file.txt"));
		const logFile = path.join(fakeHome, ".imp", "guardian.log");
		expect(await readFile(logFile, "utf8")).toContain(
			"[auto] allow — write /outside/file.txt (anthropic/session-model)",
		);
		await h.gate(writeCall("/outside/big.txt", "x".repeat(CLASSIFY_MAX_INPUT_CHARS)));
		expect(await readFile(logFile, "utf8")).toContain(
			"[auto] not classified (request over the classify budget) — write /outside/big.txt",
		);

		const shadow = await loadGuardian("/proj");
		await shadow.run("/guardian shadow");
		await shadow.gate(writeCall("/outside/shadow-only.txt"));
		expect(await readFile(logFile, "utf8")).not.toContain("write /outside/shadow-only.txt");
	});

	it("44: §14 — shadow's write prompt carries the no-context marker", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian shadow");
		h.classifyImpl.fn = async () => verdict("allow", "x");
		await h.gate(writeCall("/outside/file.txt", "probe", { verifiedUserContext: false }));
		expect(h.classify).toHaveBeenCalledTimes(1);
		expect(String((h.classify.mock.calls[0]?.[0] as ClassifyRequest | undefined)?.prompt ?? "")).toContain(
			"note: no verified user context is attached — prefer ask",
		);
	});

	it("22: unresolvable targets are never classified in auto; shadow still observes", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		const decision = await h.gate({ args: { command: 'target="$HOME/.ssh"; rm -rf "$target"' } });
		expect(decision).toMatchObject({ block: true }); // confirm false
		expect(h.classify).not.toHaveBeenCalled();
		expect(String(h.confirm.mock.calls[0]?.[1])).toContain(
			"not classified: the command contains shell expansion or glob syntax",
		);

		const shadow = await loadGuardian("/proj");
		await shadow.run("/guardian shadow");
		shadow.classifyImpl.fn = async () => verdict("allow", "x");
		await shadow.gate({ args: { command: 'target="$HOME/.ssh"; rm -rf "$target"' } });
		expect(shadow.classify).toHaveBeenCalledTimes(1);
		expect(String(shadow.classify.mock.calls[0]?.[0].prompt)).toContain(
			"the command contains shell expansion or glob syntax — prefer ask",
		);
	});

	it("23: shadow's evaluation confirm is fresh too (no sessionKey/rememberLabel)", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian shadow");
		h.classifyImpl.fn = async () => verdict("allow", "looks fine");
		await h.gate({ args: { command: risky } });
		const options = h.confirm.mock.calls[0]?.[2];
		expect(options).not.toHaveProperty("sessionKey");
		expect(options).not.toHaveProperty("rememberLabel");
	});

	it("24: shadow counters separate allow+approved from allow+denied", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian shadow");
		h.classifyImpl.fn = async () => verdict("allow", "looks fine");
		h.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await h.gate({ args: { command: risky } });
		await h.gate({ args: { command: risky } });
		await h.run("/guardian status");
		const line = h.notes.at(-1) ?? "";
		expect(line).toContain("allow→human approved 1, denied 1");
		expect(line).toContain("classify 2 (allow 2, ask 0, unavailable 0)");
		expect(line).toContain("config "); // the config path is reported
		expect(line).toContain("manual-only 0% (targets 0, no-context 0, size 0, relaxed 0)");
	});

	// §13 (rev 2.1): the detector refinement — patterns past the matched
	// invocation no longer defeat auto; every conservative case stays so.
	it("28: §13 — a decorated command is classified when only its suffix carries metacharacters", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		h.classifyImpl.fn = async () => verdict("allow", "scratch dir matches");
		const decorated =
			"rm -rf -- /tmp/imp-verify && { [ -e /tmp/imp-verify ] && echo 'STILL EXISTS' || echo 'removed: /tmp/imp-verify'; }";
		expect(await h.gate({ args: { command: decorated } })).toBeUndefined(); // ran unprompted
		expect(h.classify).toHaveBeenCalledTimes(1);
		expect(h.confirm).not.toHaveBeenCalled();
		await h.run("/guardian status");
		expect(h.notes.at(-1)).toContain("relaxed 1");
	});

	it("29: §13 — the prefer-ask marker appears only when the detector really flags", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian shadow");
		h.classifyImpl.fn = async () => verdict("ask", "unsure");
		// the glob belongs to `ls`, not to the delete — classified without marker
		await h.gate({ args: { command: "rm -rf /tmp/x && ls /tmp/*.log" } });
		expect(h.classify).toHaveBeenCalledTimes(1);
		expect(String(h.classify.mock.calls[0]?.[0].prompt)).not.toContain("prefer ask");
		// an honest case still carries it
		await h.gate({ args: { command: "rm -rf /tmp/*.log" } });
		expect(String(h.classify.mock.calls[1]?.[0].prompt)).toContain("prefer ask");
	});

	it("30: §13 — the conservative cases stay manual-only (quote-aware walk, fallbacks)", async () => {
		const cases = [
			"rm -rf /tmp/*.log", // glob inside the region
			"rm -rf '/tmp/a;b' /tmp/*.log", // a naive [;&|] split ends inside the quotes
			"rm -rf /tmp/*.log '/tmp/a;b'", // both argument orders
			'rm -rf "/tmp/x && ls *', // unterminated quote → fallback
			"rm -rf /tmp/x; rm -rf /tmp/[ab]*", // the LAST match drives the span
			"[ -e /tmp/x ] && rm -rf /tmp/x", // patterns before the match stay in-region
			"rm -rf /tmp/dir* && { [ -e /tmp/dir ]; }", // decorated, but the target is a glob
			"rm -rf /tmp/x && cat <<EOF\nls /tmp/[ab]*\nEOF", // heredoc body, patterns only — the << fallback
			"rm -rf /tmp/x && cat <<EOF\nrm -rf /tmp/*.log\nEOF", // the body match also lands in-region
			'echo "rm -rf x" && ls /tmp/[ab]*', // a match inside quotes → fallback
			"rm -r -f /tmp/[ab]*", // split-flag path → whole command
			'rm -rf /tmp/x && echo "$(date)"', // expansion tier, whole command
		];
		for (const command of cases) {
			const h = await loadGuardian("/proj");
			await h.run("/guardian auto");
			h.classifyImpl.fn = async () => verdict("allow", "x");
			const decision = await h.gate({ args: { command } });
			expect(h.classify, command).not.toHaveBeenCalled();
			expect(decision, command).toMatchObject({ block: true }); // confirm false
			expect(String(h.confirm.mock.calls[0]?.[1]), command).toContain("not classified: the command contains");
		}
	});

	it("25: auto without verified context never classifies and asks fresh", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		await h.gate({ args: { command: risky }, verifiedUserContext: false });
		expect(h.classify).not.toHaveBeenCalled();
		expect(String(h.confirm.mock.calls[0]?.[1])).toContain("not classified: no verified user context");
		// an event without the field at all is equally “no context” (fail-safe)
		const h2 = await loadGuardian("/proj");
		await h2.run("/guardian auto");
		const bare = {
			type: "tool_call",
			toolCallId: "t2",
			name: "bash",
			args: { command: risky },
		} as ToolCallEvent;
		await h2.gateRaw(bare);
		expect(h2.classify).not.toHaveBeenCalled();
	});

	it("26: manual mode is byte-for-byte today's behavior (session memory intact)", async () => {
		const h = await loadGuardian("/proj");
		h.confirm.mockResolvedValueOnce(true);
		await h.gate({ args: { command: risky } });
		const options = h.confirm.mock.calls[0]?.[2] as { sessionKey?: string; rememberLabel?: string };
		expect(options.sessionKey).toContain("guardian:bash:");
		expect(options.rememberLabel).toBe("this command pattern");
		expect(h.classify).not.toHaveBeenCalled();
	});
});
