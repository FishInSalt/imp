import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOrphanChildren, pruneOrphanChildren } from "../src/core/session/prune.js";
import { mkTempDir } from "./helpers/mktemp.js";

function sessionHeader(id: string, parentId?: string): string {
	const header = {
		type: "session",
		id,
		timestamp: "2026-10-09T00:00:00.000Z",
		cwd: "/w",
		...(parentId === undefined
			? {}
			: { launch: { version: 1, parentSessionId: parentId, inkVersion: "9.9.9" } }),
	};
	return `${JSON.stringify(header)}\n`;
}

function writeFileLine(file: string, line: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, line);
}

describe("orphan child pruning (#test-fixture-hygiene §6 Track D)", () => {
	it("finds a child whose parent header.id is absent, keeps matched ones", () => {
		const root = mkTempDir("ink-prune-");
		const dir = join(root, "Users-w-proj");
		writeFileLine(join(dir, "2026-a.jsonl"), sessionHeader("parent-1"));
		writeFileLine(join(dir, "children", "2026-c1.jsonl"), sessionHeader("child-1", "parent-1"));
		writeFileLine(join(dir, "children", "2026-c2.jsonl"), sessionHeader("child-2", "gone-parent"));
		const orphans = findOrphanChildren(root);
		expect(orphans.map((o) => o.file)).toEqual([join(dir, "children", "2026-c2.jsonl")]);
	});

	it("NEVER matches by filename: a parent whose filename uuid differs from its header.id still protects its child", () => {
		const root = mkTempDir("ink-prune-");
		const dir = join(root, "Users-w-proj");
		// filename uuid ≠ header id (the real-world layout; the draft's bug)
		writeFileLine(join(dir, "2026-filenameuuid.jsonl"), sessionHeader("header-id-1"));
		writeFileLine(join(dir, "children", "2026-c.jsonl"), sessionHeader("child", "header-id-1"));
		expect(findOrphanChildren(root)).toEqual([]);
	});

	it("prune deletes the orphan jsonl + .lease sidecar, exempts a fresh lease", () => {
		const root = mkTempDir("ink-prune-");
		const dir = join(root, "Users-w-proj");
		writeFileLine(join(dir, "children", "2026-orphan.jsonl"), sessionHeader("c1", "gone"));
		// REAL lease shape: a DIRECTORY with a candidate file (child-lease.ts)
		const leaseDir = join(dir, "children", "2026-orphan.jsonl.lease");
		mkdirSync(leaseDir, { recursive: true });
		writeFileLine(join(leaseDir, "lease-999999999-abcd12-attempt1"), JSON.stringify({ pid: 999999999 }));
		// fresh candidate mtime → within STALE_GRACE_MS → exempt even with dead pid
		const result = pruneOrphanChildren(root);
		expect(result.exempt).toEqual(["2026-orphan.jsonl"]);
	});

	it("exempts an orphan whose stale candidate carries a LIVE pid (this process)", () => {
		const root = mkTempDir("ink-prune-");
		const dir = join(root, "Users-w-proj");
		const child = join(dir, "children", "2026-orphan-livepid.jsonl");
		writeFileLine(child, sessionHeader("c3", "gone"));
		const leaseDir = `${child}.lease`;
		mkdirSync(leaseDir, { recursive: true });
		const candidate = join(leaseDir, "lease-self-abcd12-attempt1");
		writeFileLine(candidate, JSON.stringify({ pid: process.pid }));
		const old = Date.now() / 1000 - 3600;
		const { utimesSync } = require("node:fs") as typeof import("node:fs");
		utimesSync(candidate, old, old);
		const result = pruneOrphanChildren(root);
		expect(result.exempt).toEqual(["2026-orphan-livepid.jsonl"]);
	});

	it("prune removes an orphan with a stale, dead-pid lease", () => {
		const root = mkTempDir("ink-prune-");
		const dir = join(root, "Users-w-proj");
		const child = join(dir, "children", "2026-orphan2.jsonl");
		writeFileLine(child, sessionHeader("c2", "gone"));
		const leaseDir = `${child}.lease`;
		mkdirSync(leaseDir, { recursive: true });
		const candidate = join(leaseDir, "lease-999999999-abcd12-attempt2");
		writeFileLine(candidate, JSON.stringify({ pid: 999999999 }));
		// age the candidate beyond the grace window (heartbeat utimesSyncs the file)
		const old = Date.now() / 1000 - 3600;
		const { utimesSync } = require("node:fs") as typeof import("node:fs");
		utimesSync(candidate, old, old);
		const result = pruneOrphanChildren(root);
		expect(result.removed).toEqual(["2026-orphan2.jsonl"]);
	});
});
