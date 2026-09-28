import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
): string {
	const filePath = childPathFor(parent, name);
	mkdirSync(path.dirname(filePath), { recursive: true });
	const store = SessionStore.create(filePath, parent.header.cwd, childId, parent.header.id, launch as never);
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
		writeChild(parent, "child-x", launch, "foreign.jsonl");
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

	it("handles an absent children directory as not-found", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-cl-"));
		const parent = makeParent(base);
		const missing = findChildByLaunch(parent, "nope");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.code).toBe("not-found");
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
			{ name: "marker", origin: "cli", path: modulePath, sha256: bytes(source) },
		]);
		expect(loaded.runtime.contextSectionIdentities()).toEqual([]);
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
