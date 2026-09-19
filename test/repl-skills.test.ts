/**
 * Skills — invocation plane (M12 batch 2, design §11): /skill:name commands,
 * exact expansion bytes, display override, replay collapse, progressive
 * disclosure e2e.
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import type { SessionStore } from "../src/core/session/store.js";
import {
	buildSkillCommands,
	expandSkillBlock,
	loadSkills,
	type Skill,
	skillBlockSummary,
	skillDisplayLine,
} from "../src/core/skills.js";
import type { RegisteredExtensionCommand } from "../src/extensions/types.js";
import type { LLMRequest } from "../src/provider/types.js";
import { type CommandContext, dispatchCommand, helpText } from "../src/repl/commands.js";
import { replaySession } from "../src/repl/replay.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";

beforeEach(() => {
	vi.stubEnv("IMP_LOG", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

const ROOTS: string[] = [];
function tmp(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `imp-skill2-${name}-`));
	ROOTS.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of ROOTS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BODY =
	"Keep PROJECT_PLAN.md as an append-only ledger.\n\nRead references/templates.md for entry shapes.";

function makeSkillFixture(dirName = "ledger"): { root: string; file: string; skill: Skill } {
	const root = tmp(dirName);
	mkdirSync(join(root, dirName), { recursive: true });
	const file = join(root, dirName, "SKILL.md");
	writeFileSync(
		file,
		`---\nname: ${dirName}\ndescription: Ledger bookkeeping for PROJECT_PLAN.md\n---\n${BODY}\n`,
		"utf8",
	);
	const result = loadSkills({
		cwd: tmp("cwd"),
		home: tmp("home"),
		projectTrusted: false,
		noSkills: false,
		explicitPaths: [root],
	});
	expect(result.skills).toHaveLength(1);
	const loaded = result.skills[0];
	if (loaded === undefined) throw new Error("fixture did not load");
	return { root, file, skill: loaded };
}

/** dispatchCommand-ready fake ctx recording submissions + displays + output. */
function makeCtx(runner: unknown): {
	ctx: CommandContext;
	submitted: Array<{ text: string; display?: string }>;
	out: () => string;
} {
	const submitted: Array<{ text: string; display?: string }> = [];
	const captured = makeRenderer();
	const out = (): string => captured.output();
	return {
		submitted,
		out,
		ctx: {
			runner: runner as CommandContext["runner"],
			renderer: captured.renderer,
			isActive: () => false,
			requestExit: () => {},
			abortActive: () => true,
			replay: () => 0,
			submitPrompt: (text, opts) => submitted.push({ text, display: opts?.display }),
		},
	};
}

describe("expandSkillBlock — exact pi-parity bytes (§11.2)", () => {
	it("without args: block only, no trailing blank line", () => {
		const { skill } = makeSkillFixture();
		expect(expandSkillBlock(skill, "")).toBe(
			`<skill name="ledger" location="${skill.filePath}">\n` +
				`References are relative to ${skill.baseDir}.\n\n` +
				`${BODY}\n</skill>`,
		);
		expect(expandSkillBlock(skill, "   ")).toBe(expandSkillBlock(skill, "")); // blank args = no args
	});

	it("with args: one blank line, then the trimmed args", () => {
		const { skill } = makeSkillFixture();
		expect(expandSkillBlock(skill, "add an entry  ")).toBe(`${expandSkillBlock(skill, "")}\n\nadd an entry`);
	});

	it("frontmatter is stripped; read failure throws", () => {
		const { skill, file } = makeSkillFixture();
		expect(expandSkillBlock(skill, "")).not.toContain("description:");
		unlinkSync(file);
		expect(() => expandSkillBlock(skill, "")).toThrow();
	});
});

describe("skillDisplayLine / skillBlockSummary (§11.3)", () => {
	it("summary line: name only, or name (args)", () => {
		expect(skillDisplayLine("ledger", "")).toBe("▪ skill: ledger");
		expect(skillDisplayLine("ledger", "  add entry ")).toBe("▪ skill: ledger (add entry)");
	});

	it("a user message that IS an expanded block collapses; anything else is null", () => {
		const block =
			'<skill name="ledger" location="/x/SKILL.md">\nReferences are relative to /x.\n\nBody\n</skill>';
		expect(skillBlockSummary(block)).toBe("▪ skill: ledger");
		expect(skillBlockSummary("plain text")).toBeNull();
		expect(skillBlockSummary('<skill name="" location="/x">')).toBeNull(); // empty name
		expect(skillBlockSummary('not <skill name="x" at the start')).toBeNull();
	});
});

describe("buildSkillCommands (§11.1)", () => {
	it("registers skill:NAME riding the md-command shape; disable-model-invocation still registers", () => {
		const { root } = makeSkillFixture();
		mkdirSync(join(root, "private"), { recursive: true });
		writeFileSync(
			join(root, "private", "SKILL.md"),
			"---\ndescription: user-only invocation\n---\nSecret body.\n",
			"utf8",
		);
		const skills = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		}).skills;
		const commands = buildSkillCommands(skills, { enabled: true, reserved: new Set() });
		expect(commands.map((c) => c.command.name)).toEqual(["skill:ledger", "skill:private"]);
		expect(commands.every((c) => c.source === "skill")).toBe(true);
		expect(commands.every((c) => c.command.allowedDuringRun === false)).toBe(true);
		const first = commands[0];
		if (first === undefined) throw new Error("not registered");
		expect(first.command.summary).toBe("Ledger bookkeeping for PROJECT_PLAN.md");
	});

	it("summary collapses whitespace and caps at 80 chars", () => {
		const { skill } = makeSkillFixture();
		skill.description = `line one\n   line ${"two ".repeat(40)}`;
		const [command] = buildSkillCommands([skill], { enabled: true, reserved: new Set() });
		if (command === undefined) throw new Error("not registered");
		expect(command.command.summary.length).toBe(81); // 80 + ellipsis
		expect(command.command.summary.endsWith("…")).toBe(true);
		expect(command.command.summary).not.toContain("\n");
	});

	it("enabled=false registers nothing; reserved names yield with a diagnostic", () => {
		const { skill } = makeSkillFixture();
		expect(buildSkillCommands([skill], { enabled: false, reserved: new Set() })).toEqual([]);
		const diagnostics: string[] = [];
		const commands = buildSkillCommands([skill], {
			enabled: true,
			reserved: new Set(["skill:ledger"]),
			onDiagnostic: (line) => diagnostics.push(line),
		});
		expect(commands).toEqual([]);
		expect(diagnostics).toEqual([
			"imp: skill command /skill:ledger skipped — a command with that name is already registered",
		]);
	});
});

describe("/skill:name dispatch", () => {
	function register(skill: Skill): RegisteredExtensionCommand[] {
		return buildSkillCommands([skill], { enabled: true, reserved: new Set() });
	}

	it("submits the exact block with the one-line display override", async () => {
		const { skill } = makeSkillFixture();
		const { ctx, submitted } = makeCtx(null);
		const outcome = await dispatchCommand("/skill:ledger add an entry", ctx, register(skill));
		expect(outcome).toBe("handled");
		expect(submitted).toHaveLength(1);
		const only = submitted[0];
		if (only === undefined) throw new Error("nothing submitted");
		expect(only.text).toBe(expandSkillBlock(skill, "add an entry"));
		expect(only.display).toBe("▪ skill: ledger (add an entry)");
	});

	it("allowedDuringRun=false: a running turn rejects with the teaching line", async () => {
		const { skill } = makeSkillFixture();
		const { ctx, submitted, out } = makeCtx(null);
		(ctx.isActive as () => boolean) = () => true;
		const outcome = await dispatchCommand("/skill:ledger x", ctx, register(skill));
		expect(outcome).toBe("handled");
		expect(submitted).toHaveLength(0);
		expect(out()).toContain("/skill:ledger waits for the running turn");
	});

	it("read failure at invocation time: teaching error, nothing submitted (Appendix A)", async () => {
		const { skill, file } = makeSkillFixture();
		const { ctx, submitted, out } = makeCtx(null);
		unlinkSync(file);
		const outcome = await dispatchCommand("/skill:ledger", ctx, register(skill));
		expect(outcome).toBe("handled");
		expect(submitted).toHaveLength(0);
		const text = out();
		expect(text).toContain("imp: /skill:ledger failed to read");
		expect(text).not.toContain("ledger bookkeeping"); // no raw forwarding
	});

	it("unknown /skill:x falls through to the unknown-command teaching error", async () => {
		const { skill } = makeSkillFixture();
		const { ctx, out } = makeCtx(null);
		await dispatchCommand("/skill:nope", ctx, register(skill));
		const text = out();
		expect(text).toContain('imp: unknown command "/skill:nope"');
		expect(text).toContain("/skill:ledger"); // listed among the known commands
	});

	it("/help lists skill rows tagged [skill]", () => {
		const { skill } = makeSkillFixture();
		const text = helpText(buildSkillCommands([skill], { enabled: true, reserved: new Set() }), (t) => t);
		expect(text).toContain("/skill:ledger");
		expect(text).toContain("Ledger bookkeeping for PROJECT_PLAN.md");
		expect(text).toContain("[skill]");
	});
});

describe("replay collapses expanded skill blocks (§11.3)", () => {
	const fakeSession = (messages: AgentMessage[]): SessionStore =>
		({ buildContext: () => ({ messages, compacted: false }) }) as unknown as SessionStore;

	it("a block user message renders as the summary note, not the body", () => {
		const block =
			'<skill name="ledger" location="/x/SKILL.md">\nReferences are relative to /x.\n\nKeep the ledger.\n</skill>\n\nadd an entry';
		const chunks: string[] = [];
		replaySession(
			{ write: (s) => chunks.push(s), ansi: false, markdown: false },
			fakeSession([{ role: "user", content: block }]),
		);
		const text = chunks.join("");
		expect(text).toContain("▪ skill: ledger");
		expect(text).not.toContain("Keep the ledger.");
		expect(text).not.toContain("add an entry"); // args stay folded into the session, not the echo
	});

	it("plain user messages keep the existing preview shape", () => {
		const chunks: string[] = [];
		replaySession(
			{ write: (s) => chunks.push(s), ansi: false, markdown: false },
			fakeSession([{ role: "user", content: "just talking" }]),
		);
		expect(chunks.join("")).toContain("just talking");
	});
});

describe("e2e — progressive disclosure through real tool calls (§14)", () => {
	it("the catalog carries the location; the model reads SKILL.md then its reference", async () => {
		const root = tmp("e2e");
		const skillDir = join(root, "quiz");
		const refs = join(skillDir, "references");
		mkdirSync(refs, { recursive: true });
		const skillFile = join(skillDir, "SKILL.md");
		writeFileSync(
			skillFile,
			"---\nname: quiz\ndescription: Answer from the sealed reference file\n---\nRead references/answer.txt and reply with exactly its contents.\n",
			"utf8",
		);
		writeFileSync(join(refs, "answer.txt"), "FORTY-TWO\n", "utf8");
		const skills = loadSkills({
			cwd: tmp("cwd"),
			home: tmp("home"),
			projectTrusted: false,
			noSkills: false,
			explicitPaths: [root],
		}).skills;
		expect(skills).toHaveLength(1);
		const quiz = skills[0];
		if (quiz === undefined) throw new Error("fixture did not load");

		const requests: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				// step 1: the model reads the SKILL.md from the catalog location
				assistant(
					[{ type: "toolCall", id: "t1", name: "read", arguments: { path: quiz.filePath } }],
					"tool_use",
				),
				// step 2: it resolves the reference relative to the skill dir
				assistant(
					[
						{
							type: "toolCall",
							id: "t2",
							name: "read",
							arguments: { path: join(quiz.baseDir, "references", "answer.txt") },
						},
					],
					"tool_use",
				),
				// step 3: it answers from what it read
				assistant([{ type: "text", text: "FORTY-TWO" }]),
			],
			requests,
		);
		const renderer = makeRenderer().renderer;
		const runner = await createRunner({
			cwd: tmp("cwd2"),
			argv: [],
			model: "test-model",
			maxTokens: 1024,
			maxTurns: 10,
			noContextFiles: true,
			noSession: false,
			sessionBaseDir: tmp("sessions"),
			renderer,
			provider,
			skills,
		});
		const result = await runner.runTurn({ userMessage: "what is the answer?" });
		expect(result.stopReason).toBe("completed");
		// the final assistant text landed in the session (the turn's own history)
		const final = runner.session?.buildContext().messages.at(-1);
		expect(final?.role).toBe("assistant");
		expect(JSON.stringify(final)).toContain("FORTY-TWO");
		// the first request's system prompt carried the catalog (name+
		// description+location), never the body
		const [first, second, third] = requests;
		if (first === undefined || second === undefined || third === undefined)
			throw new Error("fewer than 3 provider calls");
		expect(first.system).toContain("<available_skills>");
		expect(first.system).toContain(quiz.filePath);
		expect(first.system).not.toContain("reply with exactly its contents");
		// the reads really happened through the tool pipeline (the SKILL.md
		// body then the reference's contents entered the follow-up requests)
		expect(second.messages.some((m) => JSON.stringify(m).includes("reply with exactly its contents"))).toBe(
			true,
		);
		expect(third.messages.some((m) => JSON.stringify(m).includes("FORTY-TWO"))).toBe(true);
		runner.close();
	});
});
