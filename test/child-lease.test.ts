/**
 * SA-07 red evidence for the single-writer lease (design §7,
 * docs/sa-07-child-resume-design.md).
 *
 * RED today: `src/core/child-lease.ts` does not exist — this file fails to
 * resolve its import. The tests below encode the final contract.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireChildLease } from "../src/core/child-lease.js";

const leaseOptions = {
	pid: 4242,
	host: "test-host",
	machineId: "machine-1",
	staleGraceMs: 60_000,
	heartbeatMs: 20_000,
};

describe("child lease (SA-07)", () => {
	it("T18: a second in-process acquire refuses while the first holds the lease", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-lease-"));
		const child = path.join(base, "child.jsonl");
		const first = acquireChildLease(child, "attempt-1", leaseOptions);
		expect(first.ok).toBe(true);
		const second = acquireChildLease(child, "attempt-2", leaseOptions);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.code).toBe("busy");
		if (first.ok) first.lease.release();
	});

	it("T25: release frees the lease for the next attempt", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-lease2-"));
		const child = path.join(base, "child.jsonl");
		const first = acquireChildLease(child, "attempt-1", leaseOptions);
		expect(first.ok).toBe(true);
		if (first.ok) first.lease.release();
		const second = acquireChildLease(child, "attempt-2", leaseOptions);
		expect(second.ok).toBe(true);
		if (second.ok) second.lease.release();
	});
});
