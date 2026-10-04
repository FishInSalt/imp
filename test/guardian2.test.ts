// test/guardian2.test.ts — behavior pins for the minimal guardian2 example
// extension (examples/extensions/guardian2.mjs). Binding spec:
// docs/guardian2-design.md (rev 2.3).
//
// Pattern: the real example runs against a fake api — a confirm spy, captured
// statuses, an audit-file reader, and the registered /guardian2 command
// dispatched as the REPL would.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApi, ToolCallEvent } from "../src/extensions/types.js";
import type { CommandContext, SlashCommand } from "../src/repl/commands.js";

let fakeHome = "";

beforeEach(async () => {
	fakeHome = await mkdtemp(path.join(os.tmpdir(), "imp-guardian2-"));
	vi.stubEnv("HOME", fakeHome); // guardian2 computes config/log paths from homedir
});

afterEach(() => {
	vi.unstubAllEnvs();
});

const configPath = (): string => path.join(fakeHome, ".imp", "guardian2.json");
const auditPath = (): string => path.join(fakeHome, ".imp", "guardian2.log");

/** Audit file minus the ISO timestamp; one entry per line, in write order. */
const auditBodies = (): string[] => {
	if (!existsSync(auditPath())) return [];
	return readFileSync(auditPath(), "utf8")
		.trimEnd()
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => line.slice(line.indexOf(" ") + 1));
};

const writeConfig = async (value: unknown): Promise<void> => {
	await mkdir(path.dirname(configPath()), { recursive: true });
	await writeFile(configPath(), typeof value === "string" ? value : JSON.stringify(value));
};

/* ------------------------------ fake api -------------------------------- */

interface Wire {
	api: ExtensionApi;
	gate: (event?: Partial<ToolCallEvent>) => Promise<unknown>;
	confirm: ReturnType<typeof vi.fn>;
	statuses: Map<string, string | undefined>;
	commands: Map<string, SlashCommand>;
	runCommand: (args: string) => Promise<string[]>;
}

function fakeApi(cwd: string): Wire {
	const handlers = new Map<string, (event: never) => unknown>();
	const confirm = vi.fn(async (..._args: unknown[]) => false);
	const statuses = new Map<string, string | undefined>();
	const commands = new Map<string, SlashCommand>();

	const api = {
		cwd,
		version: "test",
		origin: "project",
		registerTool: () => {},
		registerCommand: (command: SlashCommand) => {
			commands.set(command.name, command);
		},
		registerContext: () => {},
		registerToolColor: () => {},
		suggestToolColor: () => {},
		setStatus: (key: string, text: string | undefined) => {
			statuses.set(key, text);
		},
		on: (event: string, handler: (event: never) => unknown) => {
			handlers.set(event, handler);
		},
		confirm,
	} as unknown as ExtensionApi;

	const gate = async (event: Partial<ToolCallEvent> = {}): Promise<unknown> => {
		const handler = handlers.get("tool_call");
		if (handler === undefined) throw new Error("guardian2 did not register a tool_call handler");
		return await (handler as (e: ToolCallEvent) => Promise<unknown>)({
			type: "tool_call",
			toolCallId: "t1",
			name: "bash",
			args: {},
			...event,
		} as ToolCallEvent);
	};

	const runCommand = async (args: string): Promise<string[]> => {
		const command = commands.get("guardian2");
		if (command === undefined) throw new Error("guardian2 did not register its command");
		const commandNotes: string[] = [];
		await command.run(args, {
			renderer: {
				note: (line: string) => {
					commandNotes.push(line);
				},
			},
		} as unknown as CommandContext);
		return commandNotes;
	};

	return { api, gate, confirm, statuses, commands, runCommand };
}

const loadFactory = async (): Promise<(api: ExtensionApi) => unknown> => {
	const module = (await import(pathToFileURL(path.resolve("examples/extensions/guardian2.mjs")).href)) as {
		default: (api: ExtensionApi) => unknown;
	};
	return module.default;
};

/** Wire the real module to a fresh fake api; `config` absent ⇒ missing file. */
const boot = async (options: { config?: unknown; cwd?: string } = {}): Promise<Wire> => {
	if (options.config !== undefined) await writeConfig(options.config);
	const wire = fakeApi(options.cwd ?? "/tmp/project");
	const factory = await loadFactory();
	factory(wire.api);
	return wire;
};

const bash = (command: string, extra: Partial<ToolCallEvent> = {}): Partial<ToolCallEvent> => ({
	name: "bash",
	args: { command },
	...extra,
});

const blockOf = (decision: unknown): { block?: boolean; reason?: string } =>
	decision as { block?: boolean; reason?: string };

/* ------------------------------- config --------------------------------- */

describe("guardian2 config loading", () => {
	it("missing file → zero rules: everything passes, no confirm, no audit", async () => {
		const w = await boot();
		expect(await w.gate(bash("rm -rf /"))).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
		expect(auditBodies()).toEqual([]);
		expect(w.statuses.get("config")).toBeUndefined();
	});

	it("invalid JSON → footer flag + load audit line; rules stay empty", async () => {
		const w = await boot({ config: "{ not json" });
		expect(w.statuses.get("config")).toBe("config error");
		expect(auditBodies()[0]).toMatch(/^\[load\] config error — /u);
		expect(await w.gate(bash("rm -rf /"))).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
	});

	it("validation failures degrade: unknown key, bad entry, invalid regex, g/y flags", async () => {
		const cases: unknown[] = [
			{ deny: [], ask: [], extra: [] },
			{ deny: [42] },
			{ deny: [{ pattern: "(" }] },
			{ ask: [{ pattern: "x", flags: "gi" }] },
		];
		for (const config of cases) {
			const w = await boot({ config });
			expect(w.statuses.get("config")).toBe("config error");
			expect(auditBodies().at(-1)).toMatch(/^\[load\] config error — /u);
			expect(await w.gate(bash("x"))).toBeUndefined();
		}
	});

	it("an invalid reload keeps the last valid rules; a fixed reload recovers", async () => {
		const w = await boot({ config: { deny: [{ pattern: "rm -rf", reason: "never" }] } });
		expect(blockOf(await w.gate(bash("rm -rf /tmp/x"))).block).toBe(true);

		await writeConfig({ deni: [] });
		const failed = await w.runCommand("reload");
		expect(failed.join("\n")).toContain("reload failed");
		expect(w.statuses.get("config")).toBe("config error");
		expect(blockOf(await w.gate(bash("rm -rf /tmp/x"))).block).toBe(true); // last valid still applies

		await writeConfig({ deny: ["rm -rf"] });
		const recovered = await w.runCommand("reload");
		expect(recovered.join("\n")).toContain("config reloaded — deny 1, ask 0");
		expect(w.statuses.get("config")).toBeUndefined();
	});

	it("the footer flag is set on a degraded load and cleared on a good one", async () => {
		const w = await boot({ config: "{" });
		expect(w.statuses.get("config")).toBe("config error");
		await writeConfig({ ask: [] });
		await w.runCommand("reload");
		expect(w.statuses.get("config")).toBeUndefined();
	});
});

/* -------------------------------- deny ---------------------------------- */

describe("guardian2 deny", () => {
	it("blocks with the custom reason; no confirm; audit line pinned", async () => {
		const w = await boot({ config: { deny: [{ pattern: "rm -rf", reason: "do not delete here" }] } });
		const result = blockOf(await w.gate(bash("rm -rf /tmp/x")));
		expect(result.block).toBe(true);
		expect(result.reason).toBe("do not delete here");
		expect(w.confirm).not.toHaveBeenCalled();
		expect(auditBodies()).toEqual(["[deny] rm -rf — rm -rf /tmp/x — blocked"]);
	});

	it("the default reason names the pattern", async () => {
		const w = await boot({ config: { deny: ["rm -rf"] } });
		expect(blockOf(await w.gate(bash("rm -rf /tmp/x"))).reason).toBe("blocked by guardian2 rule: rm -rf");
	});

	it("first matching deny rule wins (config order)", async () => {
		const w = await boot({
			config: {
				deny: [
					{ pattern: "rm", reason: "first" },
					{ pattern: "rm -rf", reason: "second" },
				],
			},
		});
		expect(blockOf(await w.gate(bash("rm -rf /tmp/x"))).reason).toBe("first");
	});

	it("deny beats ask when both match", async () => {
		const w = await boot({ config: { deny: ["rm -rf"], ask: ["rm"] } });
		expect(blockOf(await w.gate(bash("rm -rf /tmp/x"))).block).toBe(true);
		expect(w.confirm).not.toHaveBeenCalled();
	});
});

/* --------------------------------- ask ---------------------------------- */

describe("guardian2 ask", () => {
	it("confirm carries the reason, the shared sessionKey/rememberLabel, and the preview", async () => {
		const w = await boot({ config: { ask: [{ pattern: "\\bsudo\\b", reason: "running as root" }] } });
		await w.gate(bash("sudo ls"));
		expect(w.confirm).toHaveBeenCalledWith("allow this bash command?", "running as root", {
			sessionKey: "guardian2:session",
			rememberLabel: "all guardian2 ask prompts this session",
			preview: { kind: "command", tool: "bash", text: "sudo ls" },
		});
	});

	it("approved → runs; audit approved", async () => {
		const w = await boot({ config: { ask: ["\\bsudo\\b"] } });
		w.confirm.mockResolvedValueOnce(true);
		expect(await w.gate(bash("sudo ls"))).toBeUndefined();
		expect(auditBodies()).toEqual(["[ask] \\bsudo\\b — sudo ls — approved"]);
	});

	it("declined → blocks with the rule reason; audit denied", async () => {
		const w = await boot({ config: { ask: [{ pattern: "\\bsudo\\b", reason: "running as root" }] } });
		const result = blockOf(await w.gate(bash("sudo ls")));
		expect(result.block).toBe(true);
		expect(result.reason).toBe("running as root");
		expect(auditBodies()).toEqual(["[ask] \\bsudo\\b — sudo ls — denied"]);
	});

	it("string shorthand + the default ask reason", async () => {
		const w = await boot({ config: { ask: ["\\bsudo\\b"] } });
		const result = blockOf(await w.gate(bash("sudo ls")));
		expect(w.confirm).toHaveBeenCalledWith(
			"allow this bash command?",
			"guardian2 ask rule: \\bsudo\\b",
			expect.anything(),
		);
		expect(result.reason).toBe("blocked by guardian2 — the confirmation was declined");
	});

	it("first matching ask rule wins (config order)", async () => {
		const w = await boot({
			config: {
				ask: [
					{ pattern: "sudo", reason: "first" },
					{ pattern: "sudo ls", reason: "second" },
				],
			},
		});
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash("sudo ls"));
		expect(w.confirm).toHaveBeenCalledWith("allow this bash command?", "first", expect.anything());
	});
});

/* ----------------------------- pass-through ------------------------------ */

describe("guardian2 pass-through", () => {
	it("unmatched commands pass: no confirm, no audit", async () => {
		const w = await boot({ config: { ask: ["\\bsudo\\b"], deny: ["rm -rf"] } });
		expect(await w.gate(bash("ls -la"))).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
		expect(auditBodies()).toEqual([]);
	});

	it("non-bash tools and non-string commands pass untouched", async () => {
		const w = await boot({ config: { deny: ["."] } });
		expect(await w.gate({ name: "write", args: { path: "/etc/hosts", content: "x" } })).toBeUndefined();
		expect(await w.gate({ name: "bash", args: { command: 123 } })).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
		expect(auditBodies()).toEqual([]);
	});

	it("raw-string matching: quoted text that looks dangerous matches (documented limit)", async () => {
		const w = await boot({ config: { ask: ["rm -rf"] } });
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash('git commit -m "fix rm -rf handling"'));
		expect(w.confirm).toHaveBeenCalledTimes(1);
	});

	it("the child marker rides the audit line", async () => {
		const w = await boot({ config: { deny: ["rm -rf"] } });
		await w.gate(bash("rm -rf /tmp/x", { subagent: true, agent: "review" }));
		expect(auditBodies()).toEqual(["[deny] rm -rf — rm -rf /tmp/x — blocked (child:review)"]);
	});
});

/* ---------------------------- audit + surfaces --------------------------- */

describe("guardian2 audit formats", () => {
	it("the command is capped at 160 chars and newlines are flattened", async () => {
		const w = await boot({ config: { ask: ["echo"] } });
		await w.gate(bash(`echo ${"a".repeat(300)}\nrm`));
		const body = auditBodies()[0] ?? "";
		expect(body).toMatch(/^\[ask\] echo — .{160} — denied$/u);
		expect(body).toContain("…");
	});

	it("the log file is created 0600", async () => {
		const w = await boot({ config: { deny: ["rm -rf"] } });
		await w.gate(bash("rm -rf /tmp/x"));
		expect((await stat(auditPath())).mode & 0o777).toBe(0o600);
	});
});

describe("guardian2 command", () => {
	it("status reports counts and the config path", async () => {
		const w = await boot({ config: { deny: ["rm"], ask: ["sudo", "git push"] } });
		const out = (await w.runCommand("status")).join("\n");
		expect(out).toContain("deny 1, ask 2");
		expect(out).toContain(configPath());
		expect(out).not.toContain("config error");
	});

	it("status carries the degraded note after an invalid reload", async () => {
		const w = await boot({ config: { ask: [] } });
		await writeConfig("nope");
		await w.runCommand("reload");
		expect((await w.runCommand("status")).join("\n")).toContain("config error");
	});

	it("reload reports a missing file as zero rules", async () => {
		const w = await boot({ config: { ask: ["x"] } });
		await rm(configPath());
		const out = (await w.runCommand("reload")).join("\n");
		expect(out).toContain("no config file — zero rules");
	});

	it("an unknown argument prints the usage", async () => {
		const w = await boot();
		expect((await w.runCommand("bogus")).join("\n")).toContain("/guardian2 [status|reload]");
	});
});

/* -------------------------------- template ------------------------------- */

describe("guardian2 template", () => {
	const template = JSON.parse(
		readFileSync(path.resolve("examples/extensions/guardian2.template.json"), "utf8"),
	) as unknown;

	it("validates cleanly and the shipped cases behave as documented", async () => {
		const w = await boot({ config: template });
		expect(w.statuses.get("config")).toBeUndefined();
		expect(blockOf(await w.gate(bash("rm -fr ~"))).block).toBe(true);
		expect(blockOf(await w.gate(bash("rm -r -f $HOME/x"))).block).toBe(true);
		expect(await w.gate(bash("rm -rf /tmp/x"))).toBeUndefined();
		expect(await w.gate(bash("git push --force-with-lease"))).toBeUndefined();
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash("git push -f origin main"));
		expect(w.confirm).toHaveBeenCalledTimes(1);
	});
});

/* ------------------------------ static pin ------------------------------- */

describe("guardian2 static pins", () => {
	it("no model or host-seam calls in the source", () => {
		const src = readFileSync(path.resolve("examples/extensions/guardian2.mjs"), "utf8");
		for (const token of ["api.classify", "api.complete", "api.snapshot", "api.note"]) {
			expect(src.includes(token)).toBe(false);
		}
	});
});
