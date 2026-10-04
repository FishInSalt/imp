/**
 * SA-07 acceptance round 2, finding 4: a REAL two-process interleaving test
 * for the single-writer lease. Two spawned vitest processes (the worker in
 * test/helpers/lease-worker.test.ts) hammer the same child lease; the log
 * records S/E markers around each critical section. Any overlapping pair is
 * a mutual-exclusion violation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runLeaseProcess } from "./helpers/lease-process.js";

function runWorker(dir: string, tag: string): Promise<number> {
	return runLeaseProcess("test/helpers/lease-worker.test.ts", { IMP_LEASE_WORKER: `${dir}|20|${tag}` });
}

async function waitForMarker(dir: string, name: string, timeoutMs = 30_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path.join(dir, name))) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`marker ${name} never appeared`);
}

describe("child lease — real two-process mutual exclusion", () => {
	it("F4/T30: two live processes never hold one child lease concurrently", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-lease-mp-"));
		mkdirSync(dir, { recursive: true });
		const a = runWorker(dir, "A");
		const b = runWorker(dir, "B");
		// Guaranteed contention: both workers are live and waiting before the
		// hammering starts (otherwise temporal separation could pass the S/E
		// analysis without ever overlapping — review F2).
		await waitForMarker(dir, "A-ready");
		await waitForMarker(dir, "B-ready");
		writeFileSync(path.join(dir, "go"), "");
		const [codeA, codeB] = await Promise.all([a, b]);
		expect(codeA).toBe(0);
		expect(codeB).toBe(0);
		const raw = readFileSync(path.join(dir, "log"), "utf8").trim();
		expect(raw.length).toBeGreaterThan(0);
		let current: string | null = null;
		let acquisitions = 0;
		let refusals = 0;
		let switches = 0;
		let lastTag: string | undefined;
		for (const line of raw.split("\n")) {
			const [kind, tag, round, refusedRaw] = line.split(" ");
			if (kind === "S") {
				// No holder may be active when a new critical section starts.
				expect(current).toBeNull();
				current = `${tag} ${round}`;
				acquisitions += 1;
				if (lastTag !== undefined && lastTag !== tag) switches += 1;
				lastTag = tag;
			} else if (kind === "E") {
				expect(current).toBe(`${tag} ${round}`);
				current = null;
			} else if (kind === "D") {
				refusals += Number(refusedRaw ?? 0);
			}
		}
		expect(current).toBeNull();
		expect(acquisitions).toBeGreaterThan(0);
		// Contention is a CHECKED precondition: at least one worker was refused
		// while the other held the lease. A run with temporal separation (no
		// real overlap) must not pass as evidence of mutual exclusion
		// (re-review F2).
		expect(refusals).toBeGreaterThan(0);
		expect(switches).toBeGreaterThan(0);
	}, 120_000);
});
