import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { Tool } from "../src/core/tools/types.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { ExtensionSummary } from "../src/extensions/types.js";
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

	it("case 4 (E7): built-in tool names are reserved — exact string", () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		loadOne(registry, "shadow", () => {
			registry.registerTool(tool("bash"));
			registry.registerTool(tool("fine"));
		});
		expect(lines).toEqual([
			'imp: extension shadow could not register tool "bash" — reserved by imp (built-in tools: bash read edit write grep find)',
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
			'imp: extension meta could not register command "model" — reserved by imp (known: help exit new model compact)',
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
			registry.subscribe("tool_end", (event) => {
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
			registry.subscribe("tool_call", (event) => {
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
		expect(decision).toEqual({ block: true, reason: "not allowed" });
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
		expect(decision).toEqual({ block: true, reason: "handler error — gate broke" });
	});

	it("run_end handlers receive the payload; no handlers → emits are safe no-ops", async () => {
		const lines: string[] = [];
		const registry = new ExtensionRegistry({ report: (l) => lines.push(l) });
		const seen: unknown[] = [];
		loadOne(registry, "audit", () => {
			registry.subscribe("run_end", (event) => {
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
			'imp: extension odd could not subscribe to "session_shutdown" — known events: tool_call tool_end message_end run_end',
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
