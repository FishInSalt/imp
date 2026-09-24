import * as fs from "node:fs";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, listSessions, resolveSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: vi.fn(actual.writeFileSync),
		appendFileSync: vi.fn(actual.appendFileSync),
		closeSync: vi.fn(actual.closeSync),
	};
});
afterEach(() => vi.clearAllMocks());
const a = { provider: "anthropic", modelId: "glm-qualified" };
const b = { provider: "zai", modelId: "glm-5.3" };
const c = { provider: "openai-codex", modelId: "gpt-test" };
function fresh() {
	const base = mkdtempSync(path.join(tmpdir(), "imp-model-store-"));
	return { base, store: createSession("/project", base) };
}
const records = (store: SessionStore) =>
	readFileSync(store.filePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
const reopen = (store: SessionStore) => SessionStore.open(store.filePath);

describe("session-wide model persistence", () => {
	it("stages a copied seed lazily and ignores subsequent seeds", () => {
		const { base, store } = fresh();
		const input = { ...a };
		store.seedModel(input);
		input.modelId = "mutated";
		store.getModel()!.provider = "mutated";
		store.seedModel(b);
		store.setModel(a);
		expect(store.getModel()).toEqual(a);
		expect(existsSync(store.filePath)).toBe(false);
		expect(store.isPersisted).toBe(false);
		expect(store.hasModelSelection).toBe(false);
		expect(listSessions("/project", base)).toEqual([]);
	});
	it.each(["name", "thinking", "message"])("captures the initial seed on first %s", (kind) => {
		const { base, store } = fresh();
		store.seedModel(a);
		if (kind === "name") store.appendSessionName("work");
		else if (kind === "thinking") store.appendThinkingLevelChange("high");
		else store.appendMessage({ role: "user", content: "hello" });
		expect(records(store)[0].model).toEqual(a);
		expect(records(store)).toHaveLength(2);
		expect(reopen(store).getModel()).toEqual(a);
		expect(reopen(store).hasModelSelection).toBe(false);
		expect(listSessions("/project", base)).toHaveLength(kind === "message" ? 1 : 0);
	});
	it("writes only the final explicit choice and discovers a model-only session", () => {
		const { base, store } = fresh();
		store.seedModel(a);
		const input = { ...b };
		store.setModel(input);
		input.modelId = "mutated";
		expect(records(store)).toHaveLength(2);
		expect(records(store)[0].model).toBeUndefined();
		expect(records(store)[1]).toEqual({ type: "session_model", ...b, explicit: true });
		const before = readFileSync(store.filePath, "utf8");
		const mtime = fs.statSync(store.filePath).mtimeMs;
		store.setModel(b);
		expect(readFileSync(store.filePath, "utf8")).toBe(before);
		expect(fs.statSync(store.filePath).mtimeMs).toBe(mtime);
		expect(store.getEntries()).toEqual([]);
		expect(listSessions("/project", base)[0]?.title).toBe("(model: zai/glm-5.3)");
		expect(resolveSession("/project", { baseDir: base, continueRecent: true })?.getModel()).toEqual(b);
		const restored = reopen(store);
		restored.getModel()!.modelId = "mutated";
		restored.seedModel(a);
		expect(restored.getModel()).toEqual(b);
	});
	it.each(["name", "thinking"])(
		"writes a legacy seed with the next %s in one append but keeps it hidden",
		(kind) => {
			const { base, store } = fresh();
			fs.writeFileSync(store.filePath, `${JSON.stringify(store.header)}\n`);
			const legacy = reopen(store);
			legacy.seedModel(a);
			vi.mocked(fs.appendFileSync).mockClear();
			if (kind === "name") legacy.appendSessionName("legacy");
			else legacy.appendThinkingLevelChange("high");
			expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
			expect(records(legacy)[1]).toEqual({ type: "session_model", ...a, explicit: false });
			expect(reopen(legacy).getModel()).toEqual(a);
			expect(reopen(legacy).hasModelSelection).toBe(false);
			expect(listSessions("/project", base)).toEqual([]);
			legacy.setModel(b);
			expect(listSessions("/project", base)).toHaveLength(1);
			expect(reopen(legacy).hasModelSelection).toBe(true);
		},
	);
	it("preserves positions and branch context while latest file-level model wins", () => {
		const { store } = fresh();
		store.seedModel(a);
		const first = store.appendMessage({ role: "user", content: "first" });
		store.appendMessage({ role: "user", content: "second" });
		store.forkBefore(first);
		const context = store.buildContext();
		const stats = store.stats();
		store.setModel(b);
		expect(reopen(store).getLeafId()).toBeNull();
		expect(reopen(store).buildContext()).toEqual(context);
		expect(reopen(store).stats()).toEqual(stats);
		store.appendMessage({ role: "user", content: "alternate" });
		store.branchTo(first);
		store.setModel(c);
		const restored = reopen(store);
		expect(restored.getLeafId()).toBe(first);
		expect(restored.getModel()).toEqual(c);
		expect(restored.getEntries()).toHaveLength(3);
		expect(restored.getTree()).toHaveLength(2);
		appendFileSync(store.filePath, `${JSON.stringify({ type: "session_model", ...a, explicit: false })}\n`);
		expect(reopen(store).getModel()).toEqual(a);
		expect(reopen(store).hasModelSelection).toBe(true);
	});
	it("does not overwrite competing files or commit model on exclusive open failure", () => {
		const { store } = fresh();
		const other = SessionStore.create(store.filePath, "/project");
		store.setModel(a);
		other.seedModel(b);
		expect(() => other.setModel(c)).toThrow(/EEXIST/);
		expect(other.getModel()).toEqual(b);
		expect(other.hasModelSelection).toBe(false);
		expect(reopen(store).getModel()).toEqual(a);
	});
	it("poisons a failed first write and leaves staged model unchanged", async () => {
		const { store } = fresh();
		store.seedModel(a);
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
			actual.writeFileSync(file, '{"type":');
			throw new Error("disk full");
		});
		expect(() => store.setModel(b)).toThrow("disk full");
		expect(store.getModel()).toEqual(a);
		expect(store.hasModelSelection).toBe(false);
		expect(store.isPersisted).toBe(false);
		expect(() => store.setModel(c)).toThrow(/initialization previously failed/);
		expect(() => store.appendSessionName("test")).toThrow(/initialization previously failed/);
		expect(store.getEntries()).toEqual([]);
	});
	it("does not commit model or entries on subsequent append failure", () => {
		const { store } = fresh();
		store.setModel(a);
		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw new Error("append failed");
		});
		expect(() => store.setModel(b)).toThrow("append failed");
		expect(store.getModel()).toEqual(a);
		expect(reopen(store).getModel()).toEqual(a);
		store.setModel(c);
		expect(reopen(store).getModel()).toEqual(c);
	});
	it.each([
		{ provider: "unknown", modelId: "test", explicit: true },
		{ provider: "anthropic", modelId: "  ", explicit: true },
		{ provider: "openai", modelId: 2, explicit: true },
		{ ...a },
		{ ...a, explicit: "true" },
		{ ...a, explicit: null },
	])("rejects malformed interior model metadata: %j", (invalid) => {
		const { store, base } = fresh();
		store.setModel(a);
		appendFileSync(
			store.filePath,
			`${JSON.stringify({ type: "session_model", ...invalid })}\n${JSON.stringify({ type: "position", leafId: null })}\n`,
		);
		expect(() => reopen(store)).toThrow(/session line 3: invalid session model/);
		expect(listSessions("/project", base)).toEqual([]);
	});
	it("rejects malformed header model and invalid API values", () => {
		const { store } = fresh();
		expect(() => store.seedModel({ provider: "other", modelId: "x" })).toThrow(/invalid session model/);
		expect(() => store.setModel({ provider: "zai", modelId: "" })).toThrow(/invalid session model/);
		fs.writeFileSync(store.filePath, `${JSON.stringify({ ...store.header, model: null })}\n`);
		expect(() => reopen(store)).toThrow(/session header: invalid session model/);
	});
	it("drops malformed final model records without changing the last valid selection", () => {
		const { store } = fresh();
		store.setModel(a);
		appendFileSync(store.filePath, `${JSON.stringify({ type: "session_model", ...b })}\n`);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(reopen(store).getModel()).toEqual(a);
			expect(stderr).toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
		}
	});
});
