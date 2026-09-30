import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

// #guardian-auto-mode Wave 3: the guardian consumer against a fake api — the
// example-extension test pattern (no REPL, no LLM, no network). Tests 14-26 of
// the design's pin list, guardian side.

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

const verdict = (v: "allow" | "ask", reason: string): ClassifyResult => ({
	verdict: v,
	reason,
	model: "anthropic/session-model",
});

describe("guardian auto mode (#guardian-auto-mode Phase A)", () => {
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

	it("21: the write/edit tier stays manual in auto (no classify)", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		await h.gate({ name: "write", args: { path: "/outside/file.txt" }, cwd: "/proj" });
		expect(h.classify).not.toHaveBeenCalled();
		expect(h.confirm).toHaveBeenCalledTimes(1);
	});

	it("22: unresolvable targets are never classified in auto; shadow still observes", async () => {
		const h = await loadGuardian("/proj");
		await h.run("/guardian auto");
		const decision = await h.gate({ args: { command: 'target="$HOME/.ssh"; rm -rf "$target"' } });
		expect(decision).toMatchObject({ block: true }); // confirm false
		expect(h.classify).not.toHaveBeenCalled();
		expect(String(h.confirm.mock.calls[0]?.[1])).toContain(
			"not classified: target not statically resolvable",
		);

		const shadow = await loadGuardian("/proj");
		await shadow.run("/guardian shadow");
		shadow.classifyImpl.fn = async () => verdict("allow", "x");
		await shadow.gate({ args: { command: 'target="$HOME/.ssh"; rm -rf "$target"' } });
		expect(shadow.classify).toHaveBeenCalledTimes(1);
		expect(String(shadow.classify.mock.calls[0]?.[0].prompt)).toContain("cannot be statically resolved");
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
		expect(line).toContain("allow→human denied 1");
		expect(line).toContain("classify 2 (allow 2, ask 0, unavailable 0)");
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
