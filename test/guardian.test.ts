// test/guardian.test.ts — behavior pins for the minimal guardian example
// extension (examples/extensions/guardian.mjs). Binding spec:
// docs/design/guardian-design.md (rev 3.0).
//
// Pattern: the real example runs against a fake api — a confirm spy, captured
// statuses, an audit-file reader, and the registered /guardian command
// dispatched as the REPL would.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApi, ToolCallEvent } from "../src/extensions/types.js";
import type { CommandContext, SlashCommand } from "../src/repl/commands.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";

let fakeHome = "";

beforeEach(async () => {
	fakeHome = await mkTempDirAsync("ink-guardian-");
	vi.stubEnv("HOME", fakeHome); // guardian computes config/log paths from homedir
});

afterEach(() => {
	vi.unstubAllEnvs();
});

const configPath = (): string => path.join(fakeHome, ".ink", "guardian.json");
const auditPath = (): string => path.join(fakeHome, ".ink", "guardian.log");

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
		if (handler === undefined) throw new Error("guardian did not register a tool_call handler");
		return await (handler as (e: ToolCallEvent) => Promise<unknown>)({
			type: "tool_call",
			toolCallId: "t1",
			name: "bash",
			args: {},
			...event,
		} as ToolCallEvent);
	};

	const runCommand = async (args: string): Promise<string[]> => {
		const command = commands.get("guardian");
		if (command === undefined) throw new Error("guardian did not register its command");
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
	const module = (await import(pathToFileURL(path.resolve("examples/extensions/guardian.mjs")).href)) as {
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

const fileCall = (
	name: "write" | "edit",
	target: string,
	extra: Partial<ToolCallEvent> = {},
): Partial<ToolCallEvent> => ({
	name,
	args: { path: target },
	...extra,
});

const blockOf = (decision: unknown): { block?: boolean; reason?: string } =>
	decision as { block?: boolean; reason?: string };

/* ------------------------------- config --------------------------------- */

describe("guardian config loading", () => {
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

	it("validation failures degrade: unknown keys, bad entries, bad regex/tool/flag combinations", async () => {
		const cases: unknown[] = [
			{ deny: [], ask: [], extra: [] },
			{ deny: [42] },
			{ deny: [{ regex: "(" }] }, // invalid regex
			{ deny: [{ pattern: "x", regex: "y" }] }, // both forms
			{ deny: [{}] }, // neither form
			{ deny: [{ pattern: "x", flags: "i" }] }, // flags only apply to regex
			{ ask: [{ regex: "x", flags: "gi" }] }, // g/y rejected
			{ deny: [""] },
			{ ask: ["   "] },
			{ deny: [{ pattern: "" }] },
			{ deny: [{ regex: "" }] },
			{ deny: "not-an-array" },
			{ deny: [null] },
			{ deny: [["nested"]] },
			{ deny: [{ pattern: "x", extra: true }] },
			{ ask: [{ regex: "x", flags: 5 }] },
			{ deny: [{ pattern: "x", tool: [] }] },
			{ deny: [{ pattern: "x", tool: "read" }] },
			{ deny: [{ pattern: "x", tool: 5 }] },
		];
		for (const config of cases) {
			const w = await boot({ config });
			expect(w.statuses.get("config")).toBe("config error");
			expect(auditBodies().at(-1)).toMatch(/^\[load\] config error — /u);
			expect(await w.gate(bash("x"))).toBeUndefined();
		}
	});

	it("an empty pattern can never arm a match-everything rule", async () => {
		const w = await boot({ config: { deny: [""] } });
		expect(w.statuses.get("config")).toBe("config error");
		expect(await w.gate(bash("ls -la"))).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
	});

	it("pins a full load-error line", async () => {
		const w = await boot({ config: { extra: [] } });
		expect(w.statuses.get("config")).toBe("config error");
		expect(auditBodies()).toEqual(['[load] config error — unknown key "extra"']);
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

describe("guardian deny", () => {
	it("blocks with the custom reason; no confirm; audit line pinned", async () => {
		const w = await boot({ config: { deny: [{ pattern: "rm -rf", reason: "do not delete here" }] } });
		const result = blockOf(await w.gate(bash("rm -rf /tmp/x")));
		expect(result.block).toBe(true);
		expect(result.reason).toBe("do not delete here");
		expect(w.confirm).not.toHaveBeenCalled();
		expect(auditBodies()).toEqual(["[deny] rm -rf — rm -rf /tmp/x — blocked"]);
	});

	it("the default reason names the source", async () => {
		const w = await boot({ config: { deny: ["rm -rf"] } });
		expect(blockOf(await w.gate(bash("rm -rf /tmp/x"))).reason).toBe("blocked by guardian rule: rm -rf");
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

describe("guardian ask", () => {
	it("confirm carries the reason, the shared sessionKey/rememberLabel, and the preview", async () => {
		const w = await boot({ config: { ask: [{ pattern: "sudo", reason: "running as root" }] } });
		await w.gate(bash("sudo ls"));
		expect(w.confirm).toHaveBeenCalledWith("allow this bash command?", "running as root", {
			sessionKey: "guardian:session",
			rememberLabel: "all guardian ask prompts this session",
			preview: { kind: "command", tool: "bash", text: "sudo ls", warnSpans: [[0, 4]] },
		});
	});

	it("the preview highlights the matched span: wildcard covers first segment start … last segment end", async () => {
		const w = await boot({ config: { ask: ["rm * ~"] } });
		await w.gate(bash("rm -rf ~/x"));
		expect(w.confirm).toHaveBeenCalledWith("allow this bash command?", "guardian ask rule: rm * ~", {
			sessionKey: "guardian:session",
			rememberLabel: "all guardian ask prompts this session",
			preview: { kind: "command", tool: "bash", text: "rm -rf ~/x", warnSpans: [[0, 8]] },
		});
	});

	it("a leading `*` anchors the span at the first literal segment", async () => {
		const w = await boot({ config: { ask: ["*cfg"] } });
		await w.gate(bash("cat /etc/x.cfg"));
		expect(w.confirm).toHaveBeenCalledWith("allow this bash command?", "guardian ask rule: *cfg", {
			sessionKey: "guardian:session",
			rememberLabel: "all guardian ask prompts this session",
			preview: { kind: "command", tool: "bash", text: "cat /etc/x.cfg", warnSpans: [[11, 14]] },
		});
	});

	it("a regex rule highlights its exec span", async () => {
		const w = await boot({
			config: { ask: [{ regex: "git\\s+push\\b[^\\n]*(-f\\b|--force(?!-with-lease))" }] },
		});
		await w.gate(bash("git push --force origin main"));
		expect(w.confirm).toHaveBeenCalledWith(
			"allow this bash command?",
			"guardian ask rule: git\\s+push\\b[^\\n]*(-f\\b|--force(?!-with-lease))",
			{
				sessionKey: "guardian:session",
				rememberLabel: "all guardian ask prompts this session",
				preview: {
					kind: "command",
					tool: "bash",
					text: "git push --force origin main",
					warnSpans: [[0, 16]],
				},
			},
		);
	});

	it("a multi-segment wildcard spans its middle segments too", async () => {
		const w = await boot({ config: { ask: ["a*b*c"] } });
		await w.gate(bash("xaXbYcZ"));
		expect(w.confirm).toHaveBeenCalledWith("allow this bash command?", "guardian ask rule: a*b*c", {
			sessionKey: "guardian:session",
			rememberLabel: "all guardian ask prompts this session",
			preview: { kind: "command", tool: "bash", text: "xaXbYcZ", warnSpans: [[1, 6]] },
		});
	});

	it("a match with no literal span (pattern `*`) carries no warnSpans", async () => {
		const w = await boot({ config: { ask: ["*"] } });
		await w.gate(bash("echo hi"));
		expect(w.confirm).toHaveBeenCalledWith("allow this bash command?", "guardian ask rule: *", {
			sessionKey: "guardian:session",
			rememberLabel: "all guardian ask prompts this session",
			preview: { kind: "command", tool: "bash", text: "echo hi" },
		});
	});

	it("approved → runs; audit approved", async () => {
		const w = await boot({ config: { ask: ["sudo"] } });
		w.confirm.mockResolvedValueOnce(true);
		expect(await w.gate(bash("sudo ls"))).toBeUndefined();
		expect(auditBodies()).toEqual(["[ask] sudo — sudo ls — approved"]);
	});

	it("declined → blocks with the rule reason; audit denied", async () => {
		const w = await boot({ config: { ask: [{ pattern: "sudo", reason: "running as root" }] } });
		const result = blockOf(await w.gate(bash("sudo ls")));
		expect(result.block).toBe(true);
		expect(result.reason).toBe("running as root — the user declined this call");
		expect(auditBodies()).toEqual(["[ask] sudo — sudo ls — denied"]);
	});

	it("string shorthand + the default ask reason", async () => {
		const w = await boot({ config: { ask: ["sudo"] } });
		const result = blockOf(await w.gate(bash("sudo ls")));
		expect(w.confirm).toHaveBeenCalledWith(
			"allow this bash command?",
			"guardian ask rule: sudo",
			expect.anything(),
		);
		expect(result.reason).toBe("the user declined this call");
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

	it("regex entries accept non-stateful flags", async () => {
		const w = await boot({ config: { ask: [{ regex: "sudo", flags: "i" }] } });
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash("SUDO ls"));
		expect(w.confirm).toHaveBeenCalledTimes(1);
	});

	it("an internal error falls back to a keyless confirm with detail and preview, and is audited", async () => {
		const w = await boot({ config: { ask: ["ls"] } });
		w.confirm.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(true);
		expect(await w.gate(bash("ls"))).toBeUndefined();
		expect(w.confirm).toHaveBeenCalledTimes(2);
		const fallback = w.confirm.mock.calls[1] as unknown[];
		expect(fallback[0]).toBe("guardian hit an internal error — allow this call?");
		expect(fallback[1]).toBe("ls");
		expect(fallback[2]).toEqual({ preview: { kind: "command", tool: "bash", text: "ls" } });
		expect(auditBodies()).toEqual(["[ask] internal error — ls — approved"]);
	});
});

/* --------------------------- wildcard semantics -------------------------- */

describe("guardian wildcard semantics", () => {
	it("plain text is literal: `a.b` does not match `axb`", async () => {
		const w = await boot({ config: { ask: ["a.b"] } });
		expect(await w.gate(bash("echo axb"))).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
		await w.gate(bash("echo a.b"));
		expect(w.confirm).toHaveBeenCalledTimes(1);
	});

	it("`*` spans any run of characters, including newlines", async () => {
		const w = await boot({ config: { ask: ["a*c"] } });
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash("a\nb\nc"));
		expect(w.confirm).toHaveBeenCalledTimes(1);
	});

	it("matching is linear: a many-star pattern against a long miss completes instantly", async () => {
		const w = await boot({ config: { ask: ["*a*a*a*a*a*a*a*a*a*a*b"] } });
		expect(await w.gate(bash("a".repeat(80)))).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
	});

	it("`rm * ~` covers the flag variants; a plain path misses", async () => {
		const w = await boot({ config: { deny: ["rm * ~"] } });
		expect(blockOf(await w.gate(bash("rm -rf ~"))).block).toBe(true);
		expect(blockOf(await w.gate(bash("rm -fr ~"))).block).toBe(true);
		expect(blockOf(await w.gate(bash("rm -r -f ~"))).block).toBe(true);
		expect(await w.gate(bash("rm -rf /tmp/x"))).toBeUndefined();
	});

	it("matching is contains-style: `sudo` anywhere in the command fires", async () => {
		const w = await boot({ config: { ask: ["sudo"] } });
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash("echo pre sudo post"));
		expect(w.confirm).toHaveBeenCalledTimes(1);
	});

	it("a v0 regex string is inert now (breaking change, documented)", async () => {
		const w = await boot({ config: { ask: ["\\bsudo\\b"] } });
		expect(await w.gate(bash("sudo ls"))).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
	});
});

/* ------------------------------ tool scoping ----------------------------- */

describe("guardian tool scoping", () => {
	it("a bash rule never matches write/edit calls", async () => {
		const w = await boot({ config: { deny: ["rm -rf"] } });
		expect(await w.gate(fileCall("write", "rm -rf/x"))).toBeUndefined();
		expect(auditBodies()).toEqual([]);
	});

	it("a file rule never matches bash calls", async () => {
		const w = await boot({ config: { deny: [{ tool: "write", pattern: "/etc/" }] } });
		expect(await w.gate(bash("cat /etc/hosts"))).toBeUndefined();
	});

	it("write rules match the resolved path; the audit carries it", async () => {
		const w = await boot({ config: { deny: [{ tool: "write", pattern: "/etc/" }] } });
		const result = blockOf(await w.gate(fileCall("write", "/etc/hosts")));
		expect(result.block).toBe(true);
		expect(result.reason).toBe("blocked by guardian rule: /etc/");
		expect(auditBodies()).toEqual(["[deny] /etc/ — /etc/hosts — blocked"]);
	});

	it("tool arrays cover both file tools; relative paths resolve against the caller cwd", async () => {
		const w = await boot({ config: { deny: [{ tool: ["write", "edit"], pattern: "secrets/" }] } });
		expect(blockOf(await w.gate(fileCall("edit", "secrets/key.pem"))).block).toBe(true);
		expect(blockOf(await w.gate(fileCall("write", "./secrets/key.pem"))).block).toBe(true);
	});

	it("an event.cwd different from api.cwd wins the resolution", async () => {
		const w = await boot({ config: { deny: [{ tool: "write", pattern: "/tmp/other/" }] }, cwd: "/base" });
		expect(blockOf(await w.gate(fileCall("write", "x.txt", { cwd: "/tmp/other" }))).block).toBe(true);
	});

	it("ask file flow: message, detail, no preview; declined blocks", async () => {
		const w = await boot({
			config: { ask: [{ tool: ["write", "edit"], pattern: "/etc/", reason: "config dir" }] },
		});
		w.confirm.mockResolvedValueOnce(true);
		expect(await w.gate(fileCall("write", "/etc/hosts"))).toBeUndefined();
		expect(w.confirm).toHaveBeenCalledWith("allow this write?", "/etc/hosts\nconfig dir", {
			sessionKey: "guardian:session",
			rememberLabel: "all guardian ask prompts this session",
		});
		expect(auditBodies()).toEqual(["[ask] /etc/ — /etc/hosts — approved"]);

		w.confirm.mockClear();
		const declined = blockOf(await w.gate(fileCall("edit", "/etc/hosts")));
		expect(declined.block).toBe(true);
		expect(declined.reason).toBe("config dir — the user declined this call");
		expect(w.confirm).toHaveBeenCalledWith("allow this edit?", "/etc/hosts\nconfig dir", {
			sessionKey: "guardian:session",
			rememberLabel: "all guardian ask prompts this session",
		});
	});

	it("the internal-error fallback works for file calls: detail is the path, no preview", async () => {
		const w = await boot({ config: { ask: [{ tool: "write", pattern: "/etc/" }] } });
		w.confirm.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(true);
		expect(await w.gate(fileCall("write", "/etc/hosts"))).toBeUndefined();
		const fallback = w.confirm.mock.calls[1] as unknown[];
		expect(fallback[0]).toBe("guardian hit an internal error — allow this call?");
		expect(fallback[1]).toBe("/etc/hosts");
		expect(fallback[2]).toEqual({});
		expect(auditBodies()).toEqual(["[ask] internal error — /etc/hosts — approved"]);
	});
});

/* ----------------------------- pass-through ------------------------------ */

describe("guardian pass-through", () => {
	it("unmatched calls pass: no confirm, no audit", async () => {
		const w = await boot({ config: { ask: ["sudo"], deny: ["rm * ~"] } });
		expect(await w.gate(bash("ls -la"))).toBeUndefined();
		expect(w.confirm).not.toHaveBeenCalled();
		expect(auditBodies()).toEqual([]);
	});

	it("unsupported tools and non-string args pass untouched", async () => {
		const w = await boot({ config: { deny: ["."] } });
		expect(await w.gate({ name: "read", args: { path: "/etc/hosts" } })).toBeUndefined();
		expect(await w.gate({ name: "write", args: { path: 123 } })).toBeUndefined();
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

describe("guardian audit formats", () => {
	it("whitespace is flattened and the match text is capped at 160 chars including the ellipsis", async () => {
		const short = await boot({ config: { ask: ["ls"] } });
		await short.gate(bash("ls\nrm"));
		expect(auditBodies()).toEqual(["[ask] ls — ls rm — denied"]);

		const long = await boot({ config: { ask: ["echo"] } });
		await long.gate(bash(`echo ${"a".repeat(300)}\nrm`));
		const body = auditBodies().at(-1) ?? "";
		expect(body).toMatch(/^\[ask\] echo — .{160} — denied$/u);
		expect(body).toContain("…");
	});

	it("audit lines carry an ISO timestamp prefix", async () => {
		const w = await boot({ config: { deny: ["rm -rf"] } });
		await w.gate(bash("rm -rf /tmp/x"));
		const raw = readFileSync(auditPath(), "utf8").trimEnd().split("\n")[0] ?? "";
		expect(raw).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u);
	});

	it("the log file is created 0600", async () => {
		const w = await boot({ config: { deny: ["rm -rf"] } });
		await w.gate(bash("rm -rf /tmp/x"));
		expect((await stat(auditPath())).mode & 0o777).toBe(0o600);
	});
});

describe("guardian command", () => {
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
		expect((await w.runCommand("bogus")).join("\n")).toContain("/guardian [status|reload]");
	});
});

/* ------------------------------ ask timeout ------------------------------ */

describe("guardian #ask-timeout", () => {
	it("askTimeoutMs rides every ask confirm; unconfigured keeps the option bag byte-identical", async () => {
		const configured = await boot({ config: { ask: ["sudo"], askTimeoutMs: 600000 } });
		await configured.gate(bash("sudo ls"));
		expect(configured.confirm).toHaveBeenCalledWith("allow this bash command?", "guardian ask rule: sudo", {
			sessionKey: "guardian:session",
			rememberLabel: "all guardian ask prompts this session",
			timeoutMs: 600000,
			preview: { kind: "command", tool: "bash", text: "sudo ls", warnSpans: [[0, 4]] },
		});
		const bare = await boot({ config: { ask: ["sudo"] } });
		await bare.gate(bash("sudo ls"));
		const options = (bare.confirm.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
		expect("timeoutMs" in options).toBe(false);
	});

	it("a timed-out ask blocks with the timeout wording — audited as timeout, not denied", async () => {
		const w = await boot({ config: { ask: ["sudo"], askTimeoutMs: 600000 } });
		w.confirm.mockResolvedValueOnce("timeout");
		const result = blockOf(await w.gate(bash("sudo ls")));
		expect(result.block).toBe(true);
		expect(result.reason).toBe("the confirmation timed out after 10 minutes — the call was not approved");
		expect(auditBodies()).toEqual(["[ask] sudo — sudo ls — timeout"]);
	});

	it("a timed-out ask with a rule reason prefixes the reason, like a decline does", async () => {
		const w = await boot({
			config: { ask: [{ pattern: "sudo", reason: "running as root" }], askTimeoutMs: 600000 },
		});
		w.confirm.mockResolvedValueOnce("timeout");
		const result = blockOf(await w.gate(bash("sudo ls")));
		expect(result.reason).toBe(
			"running as root — the confirmation timed out after 10 minutes — the call was not approved",
		);
		expect(auditBodies()).toEqual(["[ask] sudo — sudo ls — timeout"]);
	});

	it("humanDuration boundaries shape the timeout wording", async () => {
		const cases: Array<[number, string]> = [
			[999, "1 second"],
			[1000, "1 second"],
			[59999, "60 seconds"],
			[60000, "1 minute"],
			[90000, "2 minutes"],
			[600000, "10 minutes"],
		];
		for (const [ms, wording] of cases) {
			const w = await boot({ config: { ask: ["sudo"], askTimeoutMs: ms } });
			w.confirm.mockResolvedValueOnce("timeout");
			const result = blockOf(await w.gate(bash("sudo ls")));
			expect(result.reason).toBe(`the confirmation timed out after ${wording} — the call was not approved`);
		}
	});

	it("an invalid askTimeoutMs is a config error (no rules active, flag set, audited)", async () => {
		for (const bad of ["600000", 0, -5, 1.5, true, 2147483648]) {
			const w = await boot({ config: { ask: ["sudo"], askTimeoutMs: bad } });
			expect(w.statuses.get("config")).toBe("config error");
			expect(await w.gate(bash("sudo ls"))).toBeUndefined(); // no rules active
			expect(w.confirm).not.toHaveBeenCalled();
			expect(auditBodies().at(-1)).toContain(
				"[load] config error — askTimeoutMs must be a positive integer of milliseconds",
			);
		}
	});

	it("reload swaps the deadline atomically: a new config replaces it, a failed load keeps it", async () => {
		const w = await boot({ config: { ask: ["sudo"], askTimeoutMs: 600000 } });
		// a failed reload keeps the last valid deadline
		await writeConfig("nope");
		await w.runCommand("reload");
		await w.gate(bash("sudo ls"));
		expect((w.confirm.mock.calls.at(-1) as unknown[])[2]).toMatchObject({ timeoutMs: 600000 });
		// a successful reload replaces it (here: drops it)
		await writeConfig({ ask: ["sudo"] });
		await w.runCommand("reload");
		await w.gate(bash("sudo ls"));
		const options = (w.confirm.mock.calls.at(-1) as unknown[])[2] as Record<string, unknown>;
		expect("timeoutMs" in options).toBe(false);
		expect(w.statuses.get("config")).toBeUndefined();
	});

	it("the platform timer ceiling (2147483647 ms) is the accepted maximum", async () => {
		const w = await boot({ config: { ask: ["sudo"], askTimeoutMs: 2147483647 } });
		expect(w.statuses.get("config")).toBeUndefined();
		await w.gate(bash("sudo ls"));
		expect((w.confirm.mock.calls[0] as unknown[])[2]).toMatchObject({ timeoutMs: 2147483647 });
	});

	it("an ENOENT reload clears the deadline together with the rules", async () => {
		const w = await boot({ config: { ask: ["sudo"], askTimeoutMs: 600000 } });
		await rm(configPath());
		await w.runCommand("reload"); // missing file: rules AND deadline reset
		await writeConfig({ ask: ["sudo"] }); // a fresh config without the field
		await w.runCommand("reload");
		await w.gate(bash("sudo ls"));
		const options = (w.confirm.mock.calls.at(-1) as unknown[])[2] as Record<string, unknown>;
		expect("timeoutMs" in options).toBe(false);
		expect(w.statuses.get("config")).toBeUndefined();
	});

	it("a host reporting timeout without a configured deadline gets the fallback wording", async () => {
		const w = await boot({ config: { ask: ["sudo"] } }); // no askTimeoutMs
		w.confirm.mockResolvedValueOnce("timeout"); // a contract-violating host
		const result = blockOf(await w.gate(bash("sudo ls")));
		expect(result.reason).toBe("the confirmation timed out — the call was not approved");
		expect(auditBodies()).toEqual(["[ask] sudo — sudo ls — timeout"]);
	});

	it("the internal-error fallback carries the deadline; a fallback timeout keeps the historical reason", async () => {
		const w = await boot({ config: { ask: ["ls"], askTimeoutMs: 600000 } });
		w.confirm.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("timeout");
		const result = blockOf(await w.gate(bash("ls")));
		expect(result.block).toBe(true);
		expect(result.reason).toBe("guardian internal error — the call was not allowed");
		const fallback = w.confirm.mock.calls[1] as unknown[];
		expect(fallback[2]).toEqual({
			preview: { kind: "command", tool: "bash", text: "ls" },
			timeoutMs: 600000,
		});
		expect(auditBodies()).toEqual(["[ask] internal error — ls — timeout"]);
	});
});

/* -------------------------------- template ------------------------------- */

describe("guardian template", () => {
	const template = JSON.parse(
		readFileSync(path.resolve("examples/extensions/guardian.template.json"), "utf8"),
	) as unknown;

	it("validates cleanly and the shipped cases behave as documented", async () => {
		const w = await boot({ config: template });
		expect(w.statuses.get("config")).toBeUndefined();
		// whole-home wipes, both portable spellings (plus the quoted form)
		expect(blockOf(await w.gate(bash("rm -rf ~"))).block).toBe(true);
		expect(blockOf(await w.gate(bash("rm -fr ~/"))).block).toBe(true);
		expect(blockOf(await w.gate(bash(`rm -rf \${HOME}`))).block).toBe(true);
		expect(blockOf(await w.gate(bash('rm -rf "$HOME"/*'))).block).toBe(true);
		// the filesystem root and raw disk tools
		expect(blockOf(await w.gate(bash("rm -rf /"))).block).toBe(true);
		expect(blockOf(await w.gate(bash("diskutil eraseDisk JHFS+ x /dev/disk2"))).block).toBe(true);
		expect(blockOf(await w.gate(bash("diskutil apfs deleteVolume disk3s1"))).block).toBe(true);
		expect(blockOf(await w.gate(bash("dd if=/dev/zero of=/dev/disk4 bs=1m count=1"))).block).toBe(true);
		// the .ssh folder as a whole is denied; deeper paths stay the user's call
		expect(blockOf(await w.gate(bash("rm -rf ~/.ssh"))).block).toBe(true);
		expect(blockOf(await w.gate(bash("rm -rf $HOME/.ssh/"))).block).toBe(true);
		expect(await w.gate(bash("rm ~/.ssh/known_hosts"))).toBeUndefined();
		// everyday calls pass: scratch deletes and lease-guarded pushes
		expect(await w.gate(bash("rm -rf /tmp/x"))).toBeUndefined();
		expect(await w.gate(bash("git push --force-with-lease"))).toBeUndefined();
		// the two asks; the shipped askTimeoutMs rides every confirm
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash("git push -f origin main"));
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash("git push --force origin main"));
		w.confirm.mockResolvedValueOnce(true);
		await w.gate(bash("gh repo delete owner/repo --yes"));
		expect(w.confirm).toHaveBeenCalledTimes(3);
		for (const call of w.confirm.mock.calls) {
			expect((call as unknown[])[2]).toMatchObject({ timeoutMs: 600000 });
		}
	});
});

/* ------------------------------ static pin ------------------------------- */

describe("guardian static pins", () => {
	it("no model or host-seam calls in the source", () => {
		const src = readFileSync(path.resolve("examples/extensions/guardian.mjs"), "utf8");
		for (const token of ["api.classify", "api.complete", "api.snapshot", "api.note"]) {
			expect(src.includes(token)).toBe(false);
		}
	});
});
