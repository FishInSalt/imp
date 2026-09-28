/**
 * Lease multiprocess worker (SA-07 acceptance round 2, finding 4).
 *
 * Driven by test/child-lease-multiprocess.test.ts, which spawns this file as
 * `npx vitest run test/helpers/lease-worker.test.ts` with the env
 * `IMP_LEASE_WORKER=<dir>|<rounds>|<tag>`. Each worker acquires the same
 * child lease in a loop and appends `S tag round` / `E tag round` markers
 * around the critical section; the parent asserts no interleaving ever
 * occurs. Without the env (a normal suite run) this file is a no-op.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireChildLease } from "../../src/core/child-lease.js";

const workerEnv = process.env.IMP_LEASE_WORKER;

async function waitForMarker(dir: string, name: string, timeoutMs = 30_000): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path.join(dir, name))) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
}

describe("lease multiprocess worker", () => {
	it("runs the worker role when spawned by the multiprocess test", async () => {
		if (workerEnv === undefined) return; // placeholder in the normal suite
		const [dir, roundsRaw, tag] = workerEnv.split("|");
		if (dir === undefined || roundsRaw === undefined || tag === undefined) {
			throw new Error("IMP_LEASE_WORKER must be <dir>|<rounds>|<tag>");
		}
		const childFile = `${dir}/child.jsonl`;
		const logFile = `${dir}/log`;
		const steps = Number(roundsRaw);
		// Startup barrier: contention must be a GUARANTEED precondition, not a
		// timing accident (review F2) — both workers wait for the parent's go.
		writeFileSync(`${dir}/${tag}-ready`, "");
		expect(await waitForMarker(dir, "go")).toBe(true);
		let acquired = 0;
		let refused = 0;
		for (let step = 0; step < steps; step += 1) {
			// Production defaults (no pid/host/machineId/nonce seams): the real
			// cross-process protocol runs, including machine-id initialization.
			const result = acquireChildLease(childFile, `${tag}-${step}`);
			if (!result.ok) {
				refused += 1;
				await new Promise((resolve) => setTimeout(resolve, 2));
				continue;
			}
			appendFileSync(logFile, `S ${tag} ${step}\n`);
			await new Promise((resolve) => setTimeout(resolve, 2));
			appendFileSync(logFile, `E ${tag} ${step}\n`);
			result.lease.release();
			acquired += 1;
			// Yield a randomized window after each cycle: the other worker must
			// be able to interleave — a tight re-acquire loop would just starve
			// it and the test would prove nothing about mutual exclusion.
			await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 4)));
		}
		appendFileSync(logFile, `D ${tag} ${acquired} ${refused}\n`);
		expect(acquired).toBeGreaterThan(0);
	}, 90_000);
});
