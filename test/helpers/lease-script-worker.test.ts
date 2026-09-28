/**
 * Deterministic lease script worker (SA-07, T30b).
 *
 * Spawned by test/child-lease-scripts.test.ts as
 * `npx vitest run test/helpers/lease-script-worker.test.ts` with
 * `IMP_LEASE_SCRIPT=<dir>|<role>`. Each role runs REAL acquire calls with
 * marker-file rendezvous controlling the interleaving, then appends
 * `R <role> <ok|code> <attemptId>` to `<dir>/results`. Without the env this
 * file is a no-op placeholder.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { acquireChildLease, type ChildLeaseOptions } from "../../src/core/child-lease.js";

const scriptEnv = process.env.IMP_LEASE_SCRIPT;

function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			// busy-wait fallback
		}
	}
}

function waitMarkerSync(dir: string, name: string, timeoutMs = 20_000): boolean {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path.join(dir, name))) return true;
		sleepSync(10);
	}
	return false;
}

function writeMarker(dir: string, name: string): void {
	writeFileSync(path.join(dir, name), "");
}

describe("lease script worker", () => {
	it("runs the role", async () => {
		if (scriptEnv === undefined) return; // placeholder in the normal suite
		const [dir, role] = scriptEnv.split("|");
		if (dir === undefined || role === undefined) throw new Error("IMP_LEASE_SCRIPT must be <dir>|<role>");
		const child = path.join(dir, "child.jsonl");
		const results = path.join(dir, "results");

		const seams: ChildLeaseOptions = { maxAttempts: 1 };
		const log = (outcome: { ok: boolean; code?: string }, attemptId: string) =>
			appendFileSync(results, `R ${role} ${outcome.ok ? "ok" : (outcome.code ?? "refused")} ${attemptId}\n`);

		if (role === "a1") {
			seams.onAfterCreate = () => writeMarker(dir, "a-created");
			seams.onBeforeScan = () => {
				waitMarkerSync(dir, "b-done");
				waitMarkerSync(dir, "d-done");
			};
			const result = acquireChildLease(child, "a1-attempt", seams);
			log(result, "a1-attempt");
			if (result.ok) result.lease.release();
			return;
		}
		if (role === "d1") {
			// Joins after B's refusal cleanup, while A is paused pre-scan: must
			// still be refused because A's candidate is visible (review finding 1).
			const result = acquireChildLease(child, "d1-attempt", seams);
			log(result, "d1-attempt");
			writeMarker(dir, "d-done");
			if (result.ok) result.lease.release();
			return;
		}
		if (role === "b1") {
			const result = acquireChildLease(child, "b1-attempt", seams);
			log(result, "b1-attempt");
			writeMarker(dir, "b-done");
			if (result.ok) result.lease.release();
			return;
		}
		if (role === "a2") {
			// Started while B2 HOLDS (parent spawns it after b-done): the scan
			// must see B's live claim and refuse — no third-party window.
			const result = acquireChildLease(child, "a2-attempt", seams);
			log(result, "a2-attempt");
			writeMarker(dir, "a-done");
			if (result.ok) result.lease.release();
			return;
		}
		if (role === "b2") {
			const result = acquireChildLease(child, "b2-attempt", seams);
			log(result, "b2-attempt");
			writeMarker(dir, "b-done");
			if (result.ok) {
				waitMarkerSync(dir, "a-done");
				result.lease.release();
			}
			return;
		}
		if (role === "a4") {
			// Paused AFTER staging, BEFORE publication (the owner's window):
			// block until the parent has aged the staging and B has run.
			seams.onBeforeCandidatePublish = () => {
				writeMarker(dir, "a4-staged");
				waitMarkerSync(dir, "a4-go");
			};
			seams.onBeforeScan = () => waitMarkerSync(dir, "b4-done");
			const result = acquireChildLease(child, "a4-attempt", seams);
			log(result, "a4-attempt");
			writeMarker(dir, "a4-held");
			waitMarkerSync(dir, "c4-done");
			if (result.ok) result.lease.release();
			return;
		}
		if (role === "b4") {
			const result = acquireChildLease(child, "b4-attempt", seams);
			log(result, "b4-attempt");
			writeMarker(dir, "b4-done");
			if (result.ok) result.lease.release();
			return;
		}
		if (role === "c4") {
			const result = acquireChildLease(child, "c4-attempt", seams);
			log(result, "c4-attempt");
			writeMarker(dir, "c4-done");
			if (result.ok) result.lease.release();
			return;
		}
		if (role === "b3" || role === "c3") {
			seams.onAfterCreate = () => writeMarker(dir, `${role}-created`);
			seams.onBeforeScan = () => waitMarkerSync(dir, "go");
			const result = acquireChildLease(child, `${role}-attempt`, seams);
			log(result, `${role}-attempt`);
			writeMarker(dir, `${role}-done`);
			if (result.ok) {
				// Hold until the other role finished (bounded): if both
				// acquired, this bounded wait is what surfaces the violation
				// without hanging the test.
				waitMarkerSync(dir, role === "b3" ? "c3-done" : "b3-done", 5_000);
				result.lease.release();
			}
			return;
		}
		throw new Error(`unknown lease script role: ${role}`);
	}, 90_000);
});
