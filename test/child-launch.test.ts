import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildChildLaunch,
	CHILD_LAUNCH_VERSION,
	findChildByLaunch,
	listChildLaunches,
	normalizeSystemText,
	parseChildLaunch,
} from "../src/core/child-launch.js";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { loadExtensions } from "../src/extensions/loader.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const bytes = (text: string): string => createHash("sha256").update(Buffer.from(text)).digest("hex");

const MODEL = {
	providerName: "anthropic",
	wireModelId: "claude-sonnet-4-6",
	reference: "anthropic/claude-sonnet-4-6",
} as const;

function buildInput() {
	return {
		parentSessionId: "parent-1",
		childId: "child-1",
		impVersion: "9.9.9",
		agent: { name: "scout", system: "You are scout.", source: "/agents/scout.md" },
		model: { ...MODEL },
		cwd: "/tmp/exec-cwd",
		worktree: {
			repoRoot: "/tmp/repo",
			baseline: "a".repeat(40),
			path: "/tmp/wt",
			branch: "imp/task-x",
			creationReflog: [`${"a".repeat(40)} branch: Created from HEAD`],
		},
		tools: [{ name: "web_search", mcpServer: "searx" }, { name: "read" }],
		systemText: "You are imp.\n\n- Date: 2026-09-28\n\nrest",
		contextFiles: [{ path: "/p/AGENTS.md", content: "hello" }],
		promptFiles: [{ kind: "override" as const, path: "/p/.imp/SYSTEM.md", text: "sys" }],
		extensionContexts: [{ id: "ctx", text: "ext ctx" }],
		extensions: [{ name: "foo", origin: "global" as const, path: "/p/foo.mjs", sha256: "b".repeat(64) }],
	};
}

describe("child launch record — build", () => {
	it("stamps the version and produces exactly the schema key set (no secrets, scalars only)", () => {
		const record = buildChildLaunch(buildInput());
		expect(record.version).toBe(CHILD_LAUNCH_VERSION);
		expect(Object.keys(record).sort()).toEqual([
			"agent",
			"childId",
			"cwd",
			"extensions",
			"impVersion",
			"model",
			"parentSessionId",
			"system",
			"tools",
			"version",
			"worktree",
		]);
		// Round-trip: the record is plain JSON data — no functions, no class
		// instances, nothing that could smuggle a runtime object.
		expect(JSON.parse(JSON.stringify(record))).toEqual(record);
	});

	it("omits optional blocks (generic child, shared cwd) instead of writing undefined keys", () => {
		const input = buildInput();
		const { agent: _agent, worktree: _wt, ...rest } = input;
		const record = buildChildLaunch(rest);
		expect("agent" in record).toBe(false);
		expect("worktree" in record).toBe(false);
		expect(Object.keys(record).sort()).toEqual([
			"childId",
			"cwd",
			"extensions",
			"impVersion",
			"model",
			"parentSessionId",
			"system",
			"tools",
			"version",
		]);
	});

	it("hashes the role body, system text (normalized), and every source component", () => {
		const record = buildChildLaunch(buildInput());
		expect(record.agent?.roleSha256).toBe(sha("You are scout."));
		expect(record.agent?.source).toBe("/agents/scout.md");
		expect(record.system.sha256).toBe(sha(normalizeSystemText("You are imp.\n\n- Date: 2026-09-28\n\nrest")));
		expect(record.system.contextFiles).toEqual([{ path: "/p/AGENTS.md", sha256: sha("hello") }]);
		expect(record.system.promptFiles).toEqual([
			{ kind: "override", path: "/p/.imp/SYSTEM.md", sha256: sha("sys") },
		]);
		expect(record.system.extensionContexts).toEqual([{ id: "ctx", sha256: sha("ext ctx") }]);
		expect(record.extensions).toEqual([
			{ name: "foo", origin: "global", path: "/p/foo.mjs", sha256: "b".repeat(64) },
		]);
	});

	it("canonicalizes tools: sorted by name, mcpServer kept when present and absent when not", () => {
		const record = buildChildLaunch(buildInput());
		expect(record.tools).toEqual([{ name: "read" }, { name: "web_search", mcpServer: "searx" }]);
		expect("mcpServer" in (record.tools[0] as object)).toBe(false);
	});

	it("carries the worktree identity including the SA-01 reflog snapshot when capturable", () => {
		const record = buildChildLaunch(buildInput());
		expect(record.worktree).toEqual({
			repoRoot: "/tmp/repo",
			baseline: "a".repeat(40),
			path: "/tmp/wt",
			branch: "imp/task-x",
			creationReflog: [`${"a".repeat(40)} branch: Created from HEAD`],
		});
	});
});

describe("child launch record — normalization", () => {
	it("replaces exactly the Date line and nothing else", () => {
		const text = "line one\n- Date: 2026-09-28\nprefix - Date: 2026-09-28\n- Date: 2025-01-02";
		expect(normalizeSystemText(text)).toBe(
			"line one\n- Date: <normalized>\nprefix - Date: 2026-09-28\n- Date: <normalized>",
		);
	});

	it("leaves text without a date line byte-identical (override-mode prompts)", () => {
		const text = "custom override\n\nCurrent working directory: /p";
		expect(normalizeSystemText(text)).toBe(text);
	});
});

describe("child launch record — parse", () => {
	const good = (): unknown => buildChildLaunch(buildInput());

	it("accepts a builder-produced record", () => {
		const parsed = parseChildLaunch(good());
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.launch.version).toBe(CHILD_LAUNCH_VERSION);
	});

	it("rejects unknown versions and every structural violation", () => {
		const cases: unknown[] = [
			undefined,
			null,
			"nope",
			{ ...(good() as object), version: 2 },
			{ ...(good() as object), impVersion: undefined },
			{ ...(good() as object), cwd: "relative/path" },
			{ ...(good() as object), tools: "read" },
			{
				...(good() as object),
				system: { sha256: "not-hex", contextFiles: [], promptFiles: [], extensionContexts: [] },
			},
			{
				...(good() as object),
				agent: { name: "x", source: "/x", roleSha256: "zz" },
			},
			{ ...(good() as object), model: { providerName: "a" } },
			{ ...(good() as object), agent: { name: "x", source: "relative.md", roleSha256: "a".repeat(64) } },
			{
				...(good() as object),
				worktree: { repoRoot: ".", baseline: "a".repeat(40), path: "/tmp/wt", branch: "b" },
			},
			{
				...(good() as object),
				worktree: { repoRoot: "/repo", baseline: "a".repeat(40), path: "../elsewhere", branch: "b" },
			},
			{
				...(good() as object),
				system: {
					sha256: "a".repeat(64),
					contextFiles: [{ path: "../AGENTS.md", sha256: "b".repeat(64) }],
					promptFiles: [],
					extensionContexts: [],
				},
			},
			{
				...(good() as object),
				system: {
					sha256: "a".repeat(64),
					contextFiles: [],
					promptFiles: [{ kind: "override", path: "relative", sha256: "b".repeat(64) }],
					extensionContexts: [],
				},
			},
		];
		for (const value of cases) {
			expect(parseChildLaunch(value).ok, JSON.stringify(value)?.slice(0, 80)).toBe(false);
		}
	});

	it("tolerates unknown extra fields (readers-ignore convention)", () => {
		const withExtra = { ...(good() as object), futureField: { anything: true } };
		expect(parseChildLaunch(withExtra).ok).toBe(true);
	});
});

// --- lookup fixtures -------------------------------------------------------

function makeParent(base: string): SessionStore {
	const cwd = mkdtempSync(path.join(tmpdir(), "imp-cl-cwd-"));
	const parent = createSession(cwd, base);
	parent.appendMessage({ role: "user", content: "parent message" });
	return parent;
}

function childPathFor(parent: SessionStore, name = "child.jsonl"): string {
	return path.join(path.dirname(parent.filePath), "children", name);
}

function writeChild(
	parent: SessionStore,
	childId: string,
	launch: unknown | undefined,
	name = "child.jsonl",
	headerParent = parent.header.id,
): string {
	const filePath = childPathFor(parent, name);
	mkdirSync(path.dirname(filePath), { recursive: true });
	const store = SessionStore.create(filePath, parent.header.cwd, childId, headerParent, launch as never);
	store.appendMessage({ role: "user", content: "child prompt" });
	return filePath;
}

function writeRaw(filePath: string, lines: string[]): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

describe("child launch — managed lookup", () => {
	it("finds the child by HEADER id even when the file name says nothing", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const launch = buildChildLaunch({
			...buildInput(),
			parentSessionId: parent.header.id,
			childId: "child-9",
		});
		writeChild(parent, "child-9", launch, "totally-unrelated-name.jsonl");
		const found = findChildByLaunch(parent, "child-9");
		expect(found.ok).toBe(true);
		if (found.ok) {
			expect(found.file.launch.childId).toBe("child-9");
			expect(found.file.messageCount).toBe(1);
			expect(found.file.store.header.id).toBe("child-9");
		}
	});

	it("does not resolve a child of another parent (foreign-parent copy refused)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const launch = buildChildLaunch({
			...buildInput(),
			parentSessionId: "some-other-parent",
			childId: "child-x",
		});
		writeChild(parent, "child-x", launch, "foreign.jsonl", "some-other-parent");
		const found = findChildByLaunch(parent, "child-x");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("not-owned");
	});

	it("refuses duplicate ids (hand-copied files) as ambiguous", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const launch = buildChildLaunch({ ...buildInput(), parentSessionId: parent.header.id, childId: "dup" });
		writeChild(parent, "dup", launch, "a.jsonl");
		writeChild(parent, "dup", launch, "b.jsonl");
		const found = findChildByLaunch(parent, "dup");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("ambiguous");
	});

	it("returns not-found (with diagnostics) when no readable candidate matches", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		writeRaw(childPathFor(parent, "junk.jsonl"), ["this is not json"]);
		const missing = findChildByLaunch(parent, "never-existed");
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.code).toBe("not-found");
			expect(missing.message).toContain("junk.jsonl");
		}
	});

	it("refuses whitespace-only and torn first lines as malformed", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		writeRaw(childPathFor(parent, "blank.jsonl"), ["   "]);
		writeFileSync(childPathFor(parent, "torn.jsonl"), '{"type":"session","version":1,"id":"to', "utf8");
		const statuses = new Map(
			listChildLaunches(parent).map((entry) => [path.basename(entry.filePath), entry.status]),
		);
		expect(statuses.get("blank.jsonl")).toBe("malformed");
		expect(statuses.get("torn.jsonl")).toBe("malformed");
	});

	it("tolerates a torn appended line like the store does (final line dropped)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const launch = buildChildLaunch({
			...buildInput(),
			parentSessionId: parent.header.id,
			childId: "torn-tail",
		});
		const filePath = writeChild(parent, "torn-tail", launch, "torn-tail.jsonl");
		appendFileSync(filePath, '{"type":"message","id":"torn', "utf8");
		const found = findChildByLaunch(parent, "torn-tail");
		expect(found.ok).toBe(true);
		if (found.ok) expect(found.file.messageCount).toBe(1); // the parsed view drops the tail
	});

	it("handles an absent children directory as not-found", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const missing = findChildByLaunch(parent, "nope");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.code).toBe("not-found");
	});

	it("the launch block survives both first-write paths (seedModel and setModel)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const launchFor = (childId: string) =>
			buildChildLaunch({ ...buildInput(), parentSessionId: parent.header.id, childId });
		// Path 1: seedModel — the model rides the header on the same first write.
		const seededPath = childPathFor(parent, "seeded.jsonl");
		mkdirSync(path.dirname(seededPath), { recursive: true });
		const seeded = SessionStore.create(
			seededPath,
			parent.header.cwd,
			"seeded",
			parent.header.id,
			launchFor("seeded") as never,
		);
		seeded.seedModel({ provider: "anthropic", modelId: "wire-1" });
		seeded.appendMessage({ role: "user", content: "first" });
		const seededLines = readFileSync(seededPath, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "");
		const seededHeader = JSON.parse(seededLines[0] as string) as { launch?: { childId?: string } };
		expect(seededHeader.launch?.childId).toBe("seeded");
		expect(findChildByLaunch(parent, "seeded").ok).toBe(true);
		// Path 2: setModel (explicit) — header + a session_model line first.
		const setPath = childPathFor(parent, "set.jsonl");
		const setStore = SessionStore.create(
			setPath,
			parent.header.cwd,
			"set",
			parent.header.id,
			launchFor("set") as never,
		);
		setStore.setModel({ provider: "anthropic", modelId: "wire-2" });
		setStore.appendMessage({ role: "user", content: "first" });
		const setLines = readFileSync(setPath, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "");
		const setHeader = JSON.parse(setLines[0] as string) as { launch?: { childId?: string } };
		expect(setHeader.launch?.childId).toBe("set");
		expect((JSON.parse(setLines[1] as string) as { type?: string }).type).toBe("session_model");
		expect(findChildByLaunch(parent, "set").ok).toBe(true);
	});

	it("a symlinked children directory beside the parent file still resolves its children", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const realDir = await mkdtemp(path.join(tmpdir(), "imp-cl-real-"));
		symlinkSync(realDir, path.join(path.dirname(parent.filePath), "children"));
		const launch = buildChildLaunch({
			...buildInput(),
			parentSessionId: parent.header.id,
			childId: "linked",
		});
		const store = SessionStore.create(
			path.join(realDir, "c.jsonl"),
			parent.header.cwd,
			"linked",
			parent.header.id,
			launch as never,
		);
		store.appendMessage({ role: "user", content: "hi" });
		// Beside the parent file (the design's precondition), a symlinked
		// children dir is the user's own arrangement — and it works.
		expect(listChildLaunches(parent).map((entry) => entry.status)).toEqual(["ok"]);
		const found = findChildByLaunch(parent, "linked");
		expect(found.ok).toBe(true);
		if (found.ok) expect(found.file.launch.childId).toBe("linked");
	});

	it("treats a legacy child (no launch block) as missing-launch — readable, not resumable", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		writeChild(parent, "legacy", undefined, "legacy.jsonl");
		const found = findChildByLaunch(parent, "legacy");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("missing-launch");
	});

	it("refuses a tampered launch block as invalid-launch", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const launch = buildChildLaunch({
			...buildInput(),
			parentSessionId: parent.header.id,
			childId: "tampered",
		});
		writeChild(parent, "tampered", { ...launch, cwd: 42 }, "tampered.jsonl");
		const found = findChildByLaunch(parent, "tampered");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("invalid-launch");
	});

	it("refuses a broken parent chain inside the child file as malformed, without throwing", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const filePath = childPathFor(parent, "broken.jsonl");
		const header = {
			type: "session",
			version: 1,
			id: "broken",
			timestamp: new Date().toISOString(),
			cwd: parent.header.cwd,
			parent: parent.header.id,
		};
		const entry = (id: string, parentId: string | null) => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "x" },
		});
		writeRaw(filePath, [
			JSON.stringify(header),
			JSON.stringify(entry("aaaaaaaa", null)),
			JSON.stringify(entry("bbbbbbbb", "deadbeef")),
		]);
		expect(() => findChildByLaunch(parent, "broken")).not.toThrow();
		const found = findChildByLaunch(parent, "broken");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("malformed");
	});

	it("refuses a launch block whose childId does not match the file's header id", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		// Header id "file-child"; the record claims another child's id — the
		// old behavior would borrow that other child's settled record.
		const launch = buildChildLaunch({
			...buildInput(),
			parentSessionId: parent.header.id,
			childId: "borrowed",
		});
		writeChild(parent, "file-child", launch, "borrowed.jsonl");
		const found = findChildByLaunch(parent, "file-child");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("invalid-launch");
		const listed = listChildLaunches(parent).find(
			(entry) => path.basename(entry.filePath) === "borrowed.jsonl",
		);
		expect(listed?.status).toBe("invalid-launch");
	});

	it("refuses a launch block whose parentSessionId does not match the file's header parent", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const launch = buildChildLaunch({ ...buildInput(), parentSessionId: "foreign-parent", childId: "mine" });
		writeChild(parent, "mine", launch, "mine.jsonl");
		const found = findChildByLaunch(parent, "mine");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("not-owned");
	});

	it("refuses a cyclic parentId chain without hanging, as malformed", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const filePath = childPathFor(parent, "cycle.jsonl");
		const header = {
			type: "session",
			version: 1,
			id: "cycle",
			timestamp: new Date().toISOString(),
			cwd: parent.header.cwd,
			parent: parent.header.id,
		};
		const entry = {
			type: "message",
			id: "mmmmmmmm",
			parentId: "mmmmmmmm",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "x" },
		};
		writeRaw(filePath, [JSON.stringify(header), JSON.stringify(entry)]);
		// A hang would time this test out; getBranch's cycle guard throws instead.
		const found = findChildByLaunch(parent, "cycle");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("malformed");
	});

	it("refuses a structurally unusable compaction entry (missing retainedTail) as malformed", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const filePath = childPathFor(parent, "bad-compaction.jsonl");
		const header = {
			type: "session",
			version: 1,
			id: "bad-compaction",
			timestamp: new Date().toISOString(),
			cwd: parent.header.cwd,
			parent: parent.header.id,
		};
		const message = {
			type: "message",
			id: "aaaaaaaa",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "x" },
		};
		const compaction = {
			type: "compaction",
			id: "bbbbbbbb",
			parentId: "aaaaaaaa",
			timestamp: new Date().toISOString(),
			summary: "s",
		};
		writeRaw(filePath, [JSON.stringify(header), JSON.stringify(message), JSON.stringify(compaction)]);
		// open() tolerates it; only buildContext() touches retainedTail — the
		// lookup probes it so the failure refuses here, not inside SA-07.
		const found = findChildByLaunch(parent, "bad-compaction");
		expect(found.ok).toBe(false);
		if (!found.ok) expect(found.code).toBe("malformed");
	});
});

describe("child launch — enumeration (listChildLaunches)", () => {
	it("classifies every candidate: ok, symlink, malformed, unknown-version", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const launch = buildChildLaunch({ ...buildInput(), parentSessionId: parent.header.id, childId: "good" });
		writeChild(parent, "good", launch, "good.jsonl");
		writeRaw(childPathFor(parent, "junk.jsonl"), ["not json"]);
		writeRaw(childPathFor(parent, "future.jsonl"), [
			JSON.stringify({
				type: "session",
				version: 2,
				id: "future",
				timestamp: new Date().toISOString(),
				cwd: parent.header.cwd,
			}),
		]);
		const outside = childPathFor(parent, "../outside.jsonl");
		writeRaw(outside, [JSON.stringify({ type: "session", version: 1, id: "outside" })]);
		symlinkSync(outside, childPathFor(parent, "link.jsonl"));

		const entries = listChildLaunches(parent);
		const byPath = new Map(entries.map((e) => [path.basename(e.filePath), e.status]));
		expect(byPath.get("good.jsonl")).toBe("ok");
		expect(byPath.get("junk.jsonl")).toBe("malformed");
		expect(byPath.get("future.jsonl")).toBe("unknown-version");
		expect(byPath.get("link.jsonl")).toBe("symlink");
		expect(byPath.has("outside.jsonl")).toBe(false);

		// The readable entry carries the parsed launch and header id.
		const ok = entries.find((e) => e.status === "ok");
		expect(ok?.id).toBe("good");
		expect(ok?.launch?.childId).toBe("good");
	});

	it("returns an empty list when there is no children directory", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		expect(listChildLaunches(parent)).toEqual([]);
	});
});

describe("child launch — extension module identity", () => {
	it("exposes realpath + entry-file sha256 per loaded extension", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-cl-ext-"));
		const modulePath = path.join(dir, "marker.mjs");
		const source = "export default () => {};\n";
		writeFileSync(modulePath, source, "utf8");
		const loaded = await loadExtensions({ cwd: dir, cliPaths: [modulePath] });
		expect(loaded.failures).toEqual([]);
		expect(loaded.runtime.moduleIdentities()).toEqual([
			{ name: "marker", origin: "cli", path: realpathSync(modulePath), sha256: bytes(source) },
		]);
		expect(loaded.runtime.contextSectionIdentities()).toEqual([]);
	});

	it("a changed transitive import does not change module identity (documented limit)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-cl-ext-"));
		writeFileSync(path.join(dir, "dep.mjs"), "export const v = 1;\n", "utf8");
		const modulePath = path.join(dir, "main.mjs");
		writeFileSync(modulePath, 'import { v } from "./dep.mjs";\nexport default () => { void v; };\n', "utf8");
		const first = await loadExtensions({ cwd: dir, cliPaths: [modulePath] });
		const before = first.runtime.moduleIdentities();
		writeFileSync(path.join(dir, "dep.mjs"), "export const v = 2;\n", "utf8");
		const second = await loadExtensions({ cwd: dir, cliPaths: [modulePath] });
		// Entry bytes unchanged => identical identity: the transitive change is
		// resumed silently (design §7 limit, pinned so a future fix flips a
		// known expectation instead of surprising anyone).
		expect(second.runtime.moduleIdentities()).toEqual(before);
	});

	it("exposes registered context-section identities in load order", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-cl-ext-"));
		const modulePath = path.join(dir, "ctx.mjs");
		writeFileSync(
			modulePath,
			'export default (api) => { api.registerContext("one", "text one"); api.registerContext("two", "text two"); };\n',
			"utf8",
		);
		const loaded = await loadExtensions({ cwd: dir, cliPaths: [modulePath] });
		expect(loaded.failures).toEqual([]);
		expect(loaded.runtime.contextSectionIdentities()).toEqual([
			{ id: "one", sha256: sha("text one") },
			{ id: "two", sha256: sha("text two") },
		]);
	});
});
