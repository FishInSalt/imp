/**
 * SA-07 acceptance round 2, finding 4: a REAL two-process interleaving test
 * for the single-writer lease. Two spawned vitest processes (the worker in
 * test/helpers/lease-worker.test.ts) hammer the same child lease; the log
 * records S/E markers around each critical section. Any overlapping pair is
 * a mutual-exclusion violation.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runWorker(dir: string, tag: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("npx", ["vitest", "run", "test/helpers/lease-worker.test.ts", "--reporter=dot"], {
			cwd: repoRoot,
			env: { ...process.env, IMP_LEASE_WORKER: `${dir}|20|${tag}`, NO_COLOR: "1" },
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? -1));
	});
}

describe("child lease — real two-process mutual exclusion", () => {
	it("F4/T30: two live processes never hold one child lease concurrently", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-lease-mp-"));
		mkdirSync(dir, { recursive: true });
		const [codeA, codeB] = await Promise.all([runWorker(dir, "A"), runWorker(dir, "B")]);
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
