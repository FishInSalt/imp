import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { Tool } from "../src/core/tools/types.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { ExtensionSummary, RunEndEvent, ToolCallEvent, ToolEndEvent } from "../src/extensions/types.js";
import type { SlashCommand } from "../src/repl/commands.js";
import { assistant, ticks } from "./helpers/fakes.js";

const tool = (name: string, override: Partial<Tool> = {}): Tool => ({
	name,
	description: `test tool ${name}`,
	parameters: Type.Object({ message: Type.String() }),
	async execute(args) {
		return { output: String(args.message ?? name) };
	},
	...override,
});

const command = (name: string): SlashCommand => ({
	name,
	summary: "fixture command",
	allowedDuringRun: true,
	run: () => "handled",
});

/** Loads one extension by name through the registry's section lifecycle. */
function loadOne(
	registry: ExtensionRegistry,
	name: string,
	register: () => void,
	origin: "cli" | "project" | "global" = "cli",
): ExtensionSummary | null {
	registry.beginExtension(name, origin);
	register();
	return registry.commitExtension();
}

describe("extension registry — registration validation and conflicts (design §9/§12)", () => {
	it("case 4 (E5): a tool name taken by an earlier extension is rejected, first wins, both named; the rest of the extension stands", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "guardian", () => registry.registerTool(tool("deploy")));
		loadOne(registry, "clash", () => {
			registry.registerTool(tool("deploy"));
			registry.registerTool(tool("other"));
		});
		expect(lines).toEqual([
			'imp: extension clash could not register tool "deploy" — already registered by guardian',
		]);
		expect(registry.tools.map((t) => t.name)).toEqual(["deploy", "other"]);
	});

	it("case 4 (E6): command and context ids follow the same first-wins shape", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "one", () => {
			registry.registerCommand(command("notes"));
			registry.registerContext("notes", "first");
		});
		loadOne(registry, "two", () => {
			registry.registerCommand(command("notes"));
			registry.registerContext("notes", "second");
		});
		expect(lines).toEqual([
			'imp: extension two could not register command "notes" — already registered by one',
			'imp: extension two could not register context "notes" — already registered by one',
		]);
		expect(registry.commands.map((c) => c.command.name)).toEqual(["notes"]);
		expect(registry.commands[0]?.source).toBe("one");
		expect(registry.contextSections).toEqual([{ id: "notes", text: "first" }]);
	});

	it("case 4 (E7): built-in tool names are reserved — exact string; M16's ls is covered (review P1-1)", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "shadow", () => {
			registry.registerTool(tool("bash"));
			registry.registerTool(tool("ls")); // M16 review P1-1: this exact shadow shipped once
			registry.registerTool(tool("task")); // same drift class, pre-existing
			registry.registerTool(tool("fine"));
		});
		expect(lines).toEqual([
			'imp: extension shadow could not register tool "bash" — reserved by imp (built-in tools: bash read edit write grep find ls task)',
			'imp: extension shadow could not register tool "ls" — reserved by imp (built-in tools: bash read edit write grep find ls task)',
			'imp: extension shadow could not register tool "task" — reserved by imp (built-in tools: bash read edit write grep find ls task)',
		]);
		expect(registry.tools.map((t) => t.name)).toEqual(["fine"]);
	});

	it("case 4 (E7): built-in command names are reserved — exact string", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "meta", () => {
			registry.registerCommand(command("model"));
		});
		expect(lines).toEqual([
			'imp: extension meta could not register command "model" — reserved by imp (known: help exit new fork tree sessions resume model login logout think worktrees trust status mcp settings copy name compact)',
		]);
	});

	it("case 4 (E8): invalid names are rejected with the pattern in the message", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "weird", () => {
			registry.registerTool(tool("Bad_Name"));
			registry.registerCommand(command("9lives"));
		});
		expect(lines).toEqual([
			'imp: extension weird could not register tool "Bad_Name" — tool names must match /^[a-z][a-z0-9_-]{0,63}$/ (got "Bad_Name")',
			'imp: extension weird could not register command "9lives" — command names must match /^[a-z][a-z0-9_-]{0,63}$/ (got "9lives")',
		]);
	});

	it("case 4 (§8.1 sanity): empty description and a Value-crashing schema are rejected; a schema that merely returns false passes", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "sanity", () => {
			// required properties make Value.Check return false against {} — that
			// is NOT a failure (crash-guard semantics: passes = does not throw)
			registry.registerTool(tool("required_props"));
			registry.registerTool(tool("nodesc", { description: "   " }));
			registry.registerTool(tool("badschema", { parameters: undefined as unknown as Tool["parameters"] }));
			registry.registerTool(tool("garbage", { parameters: { type: 42 } as unknown as Tool["parameters"] }));
		});
		expect(lines).toEqual([
			'imp: extension sanity could not register tool "nodesc" — description must be a non-empty string',
			expect.stringMatching(
				/^imp: extension sanity could not register tool "badschema" — parameters schema is malformed: /,
			),
		]);
		// required_props registered; garbage schema { type: 42 } does not throw → accepted
		expect(registry.tools.map((t) => t.name)).toEqual(["required_props", "garbage"]);
	});

	it("same-extension duplicates: first registration stands, diagnostic names the extension itself", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "double", () => {
			registry.registerTool(tool("dup"));
			registry.registerTool(tool("dup"));
		});
		expect(lines).toEqual([
			'imp: extension double could not register tool "dup" — already registered by double',
		]);
		expect(registry.tools).toHaveLength(1);
	});

	it("atomic discard: a dropped section frees its names; the next extension may reuse them", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		registry.beginExtension("a", "cli");
		registry.registerTool(tool("t"));
		registry.discardExtension();
		expect(registry.tools).toEqual([]);
		loadOne(registry, "b", () => registry.registerTool(tool("t")));
		expect(lines).toEqual([]);
		expect(registry.tools.map((x) => x.name)).toEqual(["t"]);
	});
});

describe("extension registry — isolated emits (design §6.1/§7.2)", () => {
	it("case 5 (E10): a throwing tool_end handler reports one line; later handlers still run", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		const calls: string[] = [];
		loadOne(registry, "boom", () => {
			registry.subscribe("tool_end", () => {
				throw new Error("kaboom");
			});
			registry.subscribe("tool_end", (event: ToolEndEvent) => {
				calls.push(event.name);
			});
		});
		registry.emitToolEnd({
			type: "tool_end",
			toolCallId: "t1",
			name: "bash",
			output: "ok",
			isError: false,
		});
		expect(lines).toEqual(["imp: extension boom handler error (tool_end) — kaboom"]);
		expect(calls).toEqual(["bash"]);
	});

	it("case 5 (E10): an async-rejecting handler reports once rejected", async () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "late", () => {
			registry.subscribe("message_end", async () => {
				throw new Error("later");
			});
		});
		registry.emitMessageEnd({ type: "message_end", message: assistant([{ type: "text", text: "m" }]) });
		await ticks(2);
		expect(lines).toEqual(["imp: extension late handler error (message_end) — later"]);
	});

	it("tool_call chain: allow continues, the first block short-circuits the rest", async () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		const seen: string[] = [];
		loadOne(registry, "gate", () => {
			registry.subscribe("tool_call", (event: ToolCallEvent) => {
				seen.push(`one:${event.name}`);
			});
			registry.subscribe("tool_call", () => ({ block: true, reason: "not allowed" }));
			registry.subscribe("tool_call", () => {
				seen.push("three");
			});
		});
		const decision = await registry.emitToolCall({
			type: "tool_call",
			toolCallId: "t1",
			name: "bash",
			args: { command: "ls" },
		});
		// #confirm-prompt (Phase 3 D9): the registry attributes every decision it
		// returns to the extension whose handler produced it.
		expect(decision).toEqual({ block: true, reason: "not allowed", source: "gate" });
		expect(seen).toEqual(["one:bash"]);
		expect(lines).toEqual([]);
	});

	it("tool_call fail-safe (E9): a throwing handler blocks with a teaching reason", async () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "broken_gate", () => {
			registry.subscribe("tool_call", () => {
				throw new Error("gate broke");
			});
		});
		const decision = await registry.emitToolCall({
			type: "tool_call",
			toolCallId: "t1",
			name: "bash",
			args: {},
		});
		expect(decision).toEqual({ block: true, reason: "handler error — gate broke", source: "broken_gate" });
	});

	it("run_end handlers receive the payload; no handlers → emits are safe no-ops", async () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		const seen: unknown[] = [];
		loadOne(registry, "audit", () => {
			registry.subscribe("run_end", (event: RunEndEvent) => {
				seen.push({ stopReason: event.stopReason, turns: event.turns });
			});
		});
		registry.emitRunEnd({
			type: "run_end",
			stopReason: "completed",
			turns: 2,
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		registry.emitMessageEnd({ type: "message_end", message: assistant([{ type: "text", text: "m" }]) });
		expect(seen).toEqual([{ stopReason: "completed", turns: 2 }]);
		expect(lines).toEqual([]);

		const empty = new ExtensionRegistry();
		expect(await empty.emitToolCall({ type: "tool_call", toolCallId: "t", name: "x", args: {} })).toBe(
			undefined,
		);
		empty.emitToolEnd({ type: "tool_end", toolCallId: "t", name: "x", output: "", isError: false });
		empty.emitRunEnd({
			type: "run_end",
			stopReason: "aborted",
			turns: 0,
			usage: { inputTokens: 0, outputTokens: 0 },
		});
	});

	it("unknown events and non-function handlers are rejected with teaching lines", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "odd", () => {
			registry.subscribe("session_shutdown", () => {});
			registry.subscribe("tool_end", "not a function");
		});
		expect(lines).toEqual([
			'imp: extension odd could not subscribe to "session_shutdown" — known events: tool_call tool_end message_end run_start run_end',
			"imp: extension odd could not subscribe to tool_end — handler must be a function, got string",
		]);
	});
});

describe("ui.confirm plumbing (spec part 2)", () => {
	it("an injected handler receives message + detail and its resolution flows back", async () => {
		const asks: Array<{ message: string; detail?: string }> = [];
		const registry = new ExtensionRegistry({
			confirm: async (message, detail) => {
				asks.push({ message, detail });
				return message === "yes-question";
			},
		});
		await expect(registry.confirm("yes-question", "the detail")).resolves.toBe(true);
		await expect(registry.confirm("no-question")).resolves.toBe(false);
		expect(asks).toEqual([
			{ message: "yes-question", detail: "the detail" },
			{ message: "no-question", detail: undefined },
		]);
	});

	it("M10: the options bag (sessionKey) reaches the handler untouched", async () => {
		const calls: Array<[string, string | undefined, unknown]> = [];
		const registry = new ExtensionRegistry({
			confirm: async (message, detail, options) => {
				calls.push([message, detail, options]);
				return false;
			},
		});
		await expect(registry.confirm("m", "d", { sessionKey: "guardian:write:/proj" })).resolves.toBe(false);
		expect(calls).toEqual([["m", "d", { sessionKey: "guardian:write:/proj" }]]);
	});

	it("no handler: resolves false promptly (bounded) and writes one stderr teaching line — never hangs", async () => {
		const registry = new ExtensionRegistry();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			// bounded race: if confirm ever hangs, the timer answer ("hung") fails the assertion
			const answer = await Promise.race([
				registry.confirm("anyone there?"),
				new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
			]);
			expect(answer).toBe(false);
			expect(stderr).toHaveBeenCalledTimes(1);
			expect(String(stderr.mock.calls[0]?.[0])).toBe(
				"imp: extension asked for confirmation but no interactive prompt is available — declining\n",
			);
		} finally {
			stderr.mockRestore();
		}
	});

	it("M7 review: the no-handler stderr line is capped at once per registry — a chatty gate must not spam", async () => {
		const registry = new ExtensionRegistry();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			expect(await registry.confirm("first")).toBe(false);
			expect(await registry.confirm("second")).toBe(false);
			expect(await registry.confirm("third")).toBe(false);
			expect(stderr).toHaveBeenCalledTimes(1); // once, not once per call
		} finally {
			stderr.mockRestore();
		}
	});

	it("a throwing handler fails safe: false plus one teaching report line", async () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({
			report: (l) => lines.push(l),
			confirm: async () => {
				throw new Error("prompt exploded");
			},
		});
		await expect(registry.confirm("q")).resolves.toBe(false);
		expect(lines).toEqual(["imp: extension confirm handler error — prompt exploded"]);
	});
});

describe("run_start event (task-timer design §4.1)", () => {
	it("subscribes and receives the emit; observer isolation holds", () => {
		const lines: string[] = [];
		const seen: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "timer", () => {
			registry.subscribe("run_start", () => seen.push("first"));
		});
		loadOne(registry, "broken", () => {
			registry.subscribe("run_start", () => {
				throw new Error("boom");
			});
		});
		loadOne(registry, "later", () => {
			registry.subscribe("run_start", () => seen.push("second"));
		});
		registry.emitRunStart({ type: "run_start" });
		expect(seen).toEqual(["first", "second"]); // a throwing handler does not stop the chain
		expect(lines).toEqual(["imp: extension broken handler error (run_start) — boom"]);
	});
});

describe("extension status channel (task-timer design §4.2)", () => {
	it("stores, overwrites, clears, and composes entries sorted by bucket:key", () => {
		const registry = new ExtensionRegistry();
		registry.setExtensionStatus("global:b-ext", "timer", "running 0:01");
		registry.setExtensionStatus("cli:a-ext", "timer", "running 0:02");
		registry.setExtensionStatus("global:b-ext", "other", "x");
		// Same key in two buckets: both kept (namespacing).
		expect(registry.getExtensionStatusEntries().map((e) => `${e.bucket}:${e.key}=${e.text}`)).toEqual([
			"cli:a-ext:timer=running 0:02",
			"global:b-ext:other=x",
			"global:b-ext:timer=running 0:01",
		]);
		registry.setExtensionStatus("global:b-ext", "other", undefined);
		registry.setExtensionStatus("global:b-ext", "timer", "running 0:03"); // overwrite
		expect(registry.getExtensionStatusEntries().map((e) => `${e.bucket}:${e.key}=${e.text}`)).toEqual([
			"cli:a-ext:timer=running 0:02",
			"global:b-ext:timer=running 0:03",
		]);
		// Clearing the last key of a bucket removes the bucket; clearing an
		// unknown key is a quiet no-op.
		registry.setExtensionStatus("global:b-ext", "never-set", undefined);
		registry.setExtensionStatus("cli:a-ext", "timer", undefined);
		registry.setExtensionStatus("global:b-ext", "timer", undefined);
		expect(registry.getExtensionStatusEntries()).toEqual([]);
	});

	it("invalid keys and non-string texts become teaching diagnostics, never throws", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		registry.setExtensionStatus("cli:x", "", "v");
		registry.setExtensionStatus("cli:x", "  ", "v");
		registry.setExtensionStatus("cli:x", "k", 42 as unknown as string);
		expect(registry.getExtensionStatusEntries()).toEqual([]);
		expect(lines).toEqual([
			"imp: extension cli:x status dropped — key must be a non-empty string",
			"imp: extension cli:x status dropped — key must be a non-empty string",
			"imp: extension cli:x status dropped — text must be a string or undefined",
		]);
	});

	it("stored text is capped at 500 code points (silently truncated, never splits a surrogate pair)", () => {
		const registry = new ExtensionRegistry();
		registry.setExtensionStatus("cli:x", "k", "a".repeat(600));
		expect(registry.getExtensionStatusEntries()[0]?.text.length).toBe(500);
		// Astral characters count once and are never split into lone surrogates.
		registry.setExtensionStatus("cli:x", "e", "😀".repeat(600)); // 600 code points
		const stored = registry.getExtensionStatusEntries().find((entry) => entry.key === "e")?.text ?? "";
		expect([...stored]).toHaveLength(500);
		expect(stored).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	});

	it("the sink receives the recomposed line on every write; unbound means storage only", () => {
		const registry = new ExtensionRegistry();
		registry.setExtensionStatus("cli:x", "k", "before bind"); // no sink: no side effect
		const pushes: string[] = [];
		registry.setStatusSink((line) => pushes.push(line));
		registry.setExtensionStatus("cli:x", "k", "after bind");
		registry.setExtensionStatus("global:y", "k2", "second");
		registry.setExtensionStatus("global:y", "absent", undefined); // unknown key in a LIVE bucket: no-op, no push
		registry.setExtensionStatus("cli:x", "k", undefined); // clear → empty line
		registry.setExtensionStatus("cli:x", "never-set", undefined); // unknown bucket: no-op, no push
		expect(pushes).toEqual(["after bind", "after bind second", "second"]);
	});
});

describe("tool name colors (#tool-name-colors, design D1/D2)", () => {
	it("stores exact, wildcard and none; exact beats wildcard at lookup", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		const summary = loadOne(registry, "alpha", () => {
			registry.registerToolColor(["bash", "read"], "yellow");
			registry.registerToolColor("*", "blue");
			registry.registerToolColor("task", "none");
		});
		expect(lines).toEqual([]);
		expect(summary?.colorCount).toBe(4); // bash, read, *, task — name-based, not call-based
		expect(registry.toolColorFor("bash")).toBe("yellow");
		expect(registry.toolColorFor("read")).toBe("yellow");
		expect(registry.toolColorFor("task")).toBe("none");
		expect(registry.toolColorFor("grep")).toBe("blue");
		expect(registry.toolColorFor("unstyled")).toBe("blue");
		expect(registry.toolColorFor("task")).not.toBe("blue");
	});

	it("stores absolute tokens; hex normalizes to lowercase; none overrides them (A2)", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "hues", () => {
			registry.registerToolColor("bash", "#D97757");
			registry.registerToolColor("gated", "ansi256:173");
			registry.registerToolColor("*", "#E6DCC3");
			registry.registerToolColor("task", "none");
		});
		expect(lines).toEqual([]);
		expect(registry.toolColorFor("bash")).toBe("#d97757"); // stored lowercased
		expect(registry.toolColorFor("gated")).toBe("ansi256:173"); // exact beats the wildcard
		expect(registry.toolColorFor("other")).toBe("#e6dcc3");
		expect(registry.toolColorFor("task")).toBe("none"); // explicit opt-out wins
	});

	it("suggestions land below user registrations; the full order is user exact > user * > suggested exact > suggested * (A3)", () => {
		const registry = new ExtensionRegistry();
		loadOne(registry, "theme", () => registry.registerToolColor("bash", "green"));
		const summary = loadOne(registry, "search", () => {
			registry.suggestToolColor("gated", "#E6DCC3"); // absolute tokens work here too, canonicalized
			registry.suggestToolColor("*", "yellow");
		});
		expect(registry.toolColorFor("bash")).toBe("green"); // user exact
		expect(registry.toolColorFor("gated")).toBe("#e6dcc3"); // suggested exact beats suggested *
		expect(registry.toolColorFor("other")).toBe("yellow"); // suggested *
		expect(summary?.colorCount).toBe(1);
		expect(summary?.suggestedColorCount).toBe(2);
	});

	it("layer beats specificity: a user wildcard outranks an author's exact suggestion (A3)", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "theme", () => registry.registerToolColor("*", "blue"));
		loadOne(registry, "search", () => {
			registry.suggestToolColor("gated", "magenta");
			registry.suggestToolColor("bash", "red");
		});
		loadOne(registry, "theme2", () => registry.registerToolColor("bash", "green"));
		expect(lines).toEqual([]);
		expect(registry.toolColorFor("gated")).toBe("blue"); // user * beats the exact suggestion
		expect(registry.toolColorFor("bash")).toBe("green"); // user exact beats user * and the suggestion
		expect(registry.toolColorFor("other")).toBe("blue");
	});

	it("the same key may be registered and suggested in either order — cross-tier is not a conflict (A3)", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "search", () => registry.suggestToolColor("web_search", "#e6dcc3"));
		loadOne(registry, "theme", () => registry.registerToolColor("web_search", "red")); // suggest → register
		loadOne(registry, "theme2", () => registry.registerToolColor("url_read", "none"));
		loadOne(registry, "search2", () => registry.suggestToolColor("url_read", "#e6dcc3")); // register → suggest
		expect(lines).toEqual([]);
		expect(registry.toolColorFor("web_search")).toBe("red");
		expect(registry.toolColorFor("url_read")).toBe("none"); // user silence wins
	});

	it("suggestions conflict only within their tier — first wins, reported as already suggested (A3)", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "alpha", () => registry.suggestToolColor("bash", "red"));
		loadOne(registry, "beta", () => {
			registry.suggestToolColor("bash", "blue");
			registry.suggestToolColor("*", "white");
		});
		loadOne(registry, "gamma", () => registry.suggestToolColor("*", "black"));
		expect(lines).toEqual([
			'imp: extension beta could not suggest tool color for "bash" — already suggested by alpha',
			'imp: extension gamma could not suggest tool color for "*" — already suggested by beta',
		]);
		expect(registry.toolColorFor("bash")).toBe("red");
		expect(registry.toolColorFor("other")).toBe("white");
	});

	it("suggestion validation mirrors the user tier with suggest wording (all-or-nothing) (A3)", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "clumsy", () => {
			registry.suggestToolColor("bash", "orange" as never);
			registry.suggestToolColor("Bash", "red");
			registry.suggestToolColor(["Bash"], "orange" as never); // color checked before entry names
			registry.suggestToolColor(42 as never, "red");
			registry.suggestToolColor("*", "cyan"); // the one good call stands
		});
		expect(lines).toEqual([
			'imp: extension clumsy could not suggest tool color — unknown color (expected one of: black red green yellow blue magenta cyan white gray brightRed brightGreen brightYellow brightBlue brightMagenta brightCyan brightWhite none, ansi256:N (0-255), or #rrggbb, got "orange")',
			'imp: extension clumsy could not suggest tool color for "Bash" — names must match /^[a-z][a-z0-9_-]{0,63}$/ or be "*" (got "Bash")',
			'imp: extension clumsy could not suggest tool color — unknown color (expected one of: black red green yellow blue magenta cyan white gray brightRed brightGreen brightYellow brightBlue brightMagenta brightCyan brightWhite none, ansi256:N (0-255), or #rrggbb, got "orange")',
			"imp: extension clumsy could not suggest tool color — expected a name or an array of names, got number",
		]);
		expect(registry.toolColorFor("bash")).toBeUndefined();
		expect(registry.toolColorFor("other")).toBe("cyan");
	});

	it("a discarded section rolls suggestions back atomically; the key stays free (A3)", () => {
		const registry = new ExtensionRegistry();
		registry.beginExtension("doomed", "cli");
		registry.suggestToolColor("bash", "yellow");
		registry.discardExtension();
		expect(registry.toolColorFor("bash")).toBeUndefined();
		loadOne(registry, "next", () => registry.suggestToolColor("bash", "cyan"));
		expect(registry.toolColorFor("bash")).toBe("cyan"); // no owner leak
	});

	it("specificity is per key: a later exact registration beats an earlier wildcard silently; the same key conflicts loudly, first wins", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "alpha", () => registry.registerToolColor("*", "blue"));
		loadOne(registry, "beta", () => {
			registry.registerToolColor("bash", "green"); // specificity, not a conflict
			registry.registerToolColor("read", "red");
		});
		loadOne(registry, "gamma", () => registry.registerToolColor("bash", "black")); // same exact key
		loadOne(registry, "delta", () => registry.registerToolColor("*", "white")); // same wildcard key
		expect(registry.toolColorFor("bash")).toBe("green");
		expect(registry.toolColorFor("read")).toBe("red");
		expect(lines).toEqual([
			'imp: extension gamma could not register tool color for "bash" — already registered by beta',
			'imp: extension delta could not register tool color for "*" — already registered by alpha',
		]);
	});

	it("validates every malformed shape with one bounded report and stores nothing (all-or-nothing per call)", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "clumsy", () => {
			registry.registerToolColor("bash", "orange" as never);
			registry.registerToolColor("Bash", "red");
			registry.registerToolColor([42 as never], "red");
			registry.registerToolColor(["bash", "read"], "orange" as never);
			registry.registerToolColor(42 as never, "red");
			registry.registerToolColor([], "red"); // vacuous no-op, no report
			registry.registerToolColor(["ok", "ok2"], "red"); // the one good call stands
		});
		expect(lines).toEqual([
			'imp: extension clumsy could not register tool color — unknown color (expected one of: black red green yellow blue magenta cyan white gray brightRed brightGreen brightYellow brightBlue brightMagenta brightCyan brightWhite none, ansi256:N (0-255), or #rrggbb, got "orange")',
			'imp: extension clumsy could not register tool color for "Bash" — names must match /^[a-z][a-z0-9_-]{0,63}$/ or be "*" (got "Bash")',
			'imp: extension clumsy could not register tool color for "42" — names must match /^[a-z][a-z0-9_-]{0,63}$/ or be "*" (got "42")',
			'imp: extension clumsy could not register tool color — unknown color (expected one of: black red green yellow blue magenta cyan white gray brightRed brightGreen brightYellow brightBlue brightMagenta brightCyan brightWhite none, ansi256:N (0-255), or #rrggbb, got "orange")',
			"imp: extension clumsy could not register tool color — expected a name or an array of names, got number",
		]);
		// the failed call left nothing behind — no partial ["bash"] from the color rejection
		expect(registry.toolColorFor("bash")).toBeUndefined();
		expect(registry.toolColorFor("read")).toBeUndefined();
		expect(registry.toolColorFor("ok")).toBe("red");
		expect(registry.toolColorFor("ok2")).toBe("red");
	});

	it("a duplicate entry within one call is a conflict — the whole call is rejected", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "echo", () => registry.registerToolColor(["read", "read"], "red"));
		expect(lines).toEqual([
			'imp: extension echo could not register tool color for "read" — already registered by echo',
		]);
		expect(registry.toolColorFor("read")).toBeUndefined();
	});

	it("a discarded section rolls colors back atomically; the key stays free", () => {
		const registry = new ExtensionRegistry();
		registry.beginExtension("doomed", "cli");
		registry.registerToolColor("bash", "yellow");
		registry.discardExtension();
		expect(registry.toolColorFor("bash")).toBeUndefined();
		loadOne(registry, "next", () => registry.registerToolColor("bash", "cyan"));
		expect(registry.toolColorFor("bash")).toBe("cyan"); // no owner leak
	});
});
