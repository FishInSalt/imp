import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/core/session/store.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), closeSync: vi.fn(actual.closeSync) };
});

afterEach(() => {
	vi.mocked(fs.writeFileSync).mockClear();
	vi.mocked(fs.closeSync).mockClear();
});

async function fresh(): Promise<SessionStore> {
	const dir = await mkdtemp(path.join(tmpdir(), "imp-lazy-session-"));
	return SessionStore.create(path.join(dir, "session.jsonl"), dir);
}

const appendUser = (store: SessionStore) => store.appendMessage({ role: "user", content: "hello" });

function expectUnwritten(store: SessionStore): void {
	expect(store.isPersisted).toBe(false);
	expect(store.getEntries()).toEqual([]);
	expect(store.getLeafId()).toBeNull();
}

describe("lazy session persistence", () => {
	it.each([
		["name", (store: SessionStore) => store.appendSessionName("planned work")],
		["thinking", (store: SessionStore) => store.appendThinkingLevelChange("high")],
		["label", (store: SessionStore) => store.appendLabelChange("target", "note")],
		["compaction", (store: SessionStore) => store.appendCompaction("summary", [], 100)],
		["branch summary", (store: SessionStore) => store.appendBranchSummary("summary")],
	] as const)("persists a first %s entry, even without a message", async (_name, append) => {
		const store = await fresh();
		append(store);
		expect(store.isPersisted).toBe(true);
		const reopened = SessionStore.open(store.filePath);
		expect(reopened.isPersisted).toBe(true);
		expect(reopened.getEntries()).toEqual(store.getEntries());
		expect(reopened.getLeafId()).toBe(store.getLeafId());
		expect(readFileSync(store.filePath, "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("does not persist pristine position changes, but saves later branch resets", async () => {
		const store = await fresh();
		store.branchTo(null);
		store.branchTo(null);
		expectUnwritten(store);
		expect(existsSync(store.filePath)).toBe(false);
		appendUser(store);
		store.branchTo(null);
		const reopened = SessionStore.open(store.filePath);
		expect(reopened.isPersisted).toBe(true);
		expect(reopened.getLeafId()).toBeNull();
		expect(reopened.getEntries()).toHaveLength(1);
	});

	it("opens a legacy header-only file as persisted and does not duplicate its header", async () => {
		const store = await fresh();
		fs.writeFileSync(store.filePath, `${JSON.stringify(store.header)}\n`);
		const reopened = SessionStore.open(store.filePath);
		expect(reopened.isPersisted).toBe(true);
		appendUser(reopened);
		const lines = readFileSync(store.filePath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string)).toEqual(store.header);
	});

	it("never overwrites or adopts a competing session file", async () => {
		const winner = await fresh();
		const loser = SessionStore.create(winner.filePath, winner.header.cwd);
		appendUser(winner);
		const original = readFileSync(winner.filePath, "utf8");
		for (let i = 0; i < 2; i++) {
			expect(() => appendUser(loser)).toThrow(/EEXIST/);
			expectUnwritten(loser);
			expect(readFileSync(winner.filePath, "utf8")).toBe(original);
		}
	});

	it("allows retry after an open failure without creating or indexing an entry", async () => {
		const root = await fresh();
		const dir = path.join(root.header.cwd, "missing");
		const store = SessionStore.create(path.join(dir, "session.jsonl"), dir);
		expect(() => appendUser(store)).toThrow(/ENOENT/);
		expectUnwritten(store);
		mkdirSync(dir);
		appendUser(store);
		expect(store.isPersisted).toBe(true);
		expect(SessionStore.open(store.filePath).getEntries()).toHaveLength(1);
	});

	it("fails closed after partial first-write failure and preserves the original error", async () => {
		const store = await fresh();
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		const error = new Error("simulated disk full");
		vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
			actual.writeFileSync(file, '{"type":');
			throw error;
		});
		expect(() => appendUser(store)).toThrow(error);
		expectUnwritten(store);
		expect(fs.closeSync).toHaveBeenCalledTimes(1);
		const partial = readFileSync(store.filePath, "utf8");
		expect(() => appendUser(store)).toThrow(/initialization previously failed/);
		expect(readFileSync(store.filePath, "utf8")).toBe(partial);
		expectUnwritten(store);
	});

	it("preserves the first-write error when cleanup closure also fails", async () => {
		const store = await fresh();
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		const error = new Error("initial write failed");
		vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
			throw error;
		});
		vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
			actual.closeSync(fd);
			throw new Error("cleanup close failed");
		});
		expect(() => appendUser(store)).toThrow(error);
		expectUnwritten(store);
		expect(() => appendUser(store)).toThrow(/initialization previously failed/);
		expect(fs.closeSync).toHaveBeenCalledTimes(1);
	});

	it("does not mark a failed initial close as saved or retry an uncertain close", async () => {
		const store = await fresh();
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
			actual.closeSync(fd);
			throw new Error("simulated close failure");
		});
		expect(() => appendUser(store)).toThrow(/simulated close failure/);
		expectUnwritten(store);
		expect(fs.closeSync).toHaveBeenCalledTimes(1);
		const bytes = readFileSync(store.filePath, "utf8");
		expect(() => appendUser(store)).toThrow(/initialization previously failed/);
		expect(readFileSync(store.filePath, "utf8")).toBe(bytes);
	});
});
