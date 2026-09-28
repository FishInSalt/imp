/**
 * SA-07 single-writer lease tests (design §7,
 * docs/sa-07-child-resume-design.md).
 */
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

const leasePathFor = (child: string) => `${child}.lease`;

function leasePayload(overrides: Record<string, unknown> = {}) {
	return {
		pid: 999999,
		host: "test-host",
		machineId: "machine-1",
		attemptId: "old-attempt",
		startedAt: new Date(0).toISOString(),
		...overrides,
	};
}

function writeLease(child: string, payload: unknown): void {
	writeFileSync(leasePathFor(child), typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`);
}

function ageLease(child: string, ms: number): void {
	const then = new Date(Date.now() - ms);
	utimesSync(leasePathFor(child), then, then);
}

async function setup(prefix: string): Promise<{ base: string; child: string }> {
	const base = await mkdtemp(path.join(tmpdir(), prefix));
	return { base, child: path.join(base, "child.jsonl") };
}

describe("child lease (SA-07)", () => {
	it("T18: a second in-process acquire refuses while the first holds the lease", async () => {
		const { child } = await setup("imp-lease-");
		const first = acquireChildLease(child, "attempt-1", leaseOptions);
		expect(first.ok).toBe(true);
		const second = acquireChildLease(child, "attempt-2", leaseOptions);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.code).toBe("busy");
		if (first.ok) first.lease.release();
	});

	it("T25: release frees the lease for the next attempt", async () => {
		const { child } = await setup("imp-lease2-");
		const first = acquireChildLease(child, "attempt-1", leaseOptions);
		expect(first.ok).toBe(true);
		if (first.ok) first.lease.release();
		const second = acquireChildLease(child, "attempt-2", leaseOptions);
		expect(second.ok).toBe(true);
		if (second.ok) second.lease.release();
	});

	it("T19a: a dead holder with a FRESH mtime refuses with the recovery hint", async () => {
		const { child } = await setup("imp-lease19a-");
		writeLease(child, leasePayload());
		const result = acquireChildLease(child, "new-attempt", { ...leaseOptions, isAlive: () => false });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("busy");
			expect(result.message).toContain("retry in");
		}
	});

	it("T19b: a dead holder with an aged mtime is stolen", async () => {
		const { child } = await setup("imp-lease19b-");
		writeLease(child, leasePayload());
		ageLease(child, 120_000);
		const result = acquireChildLease(child, "new-attempt", { ...leaseOptions, isAlive: () => false });
		expect(result.ok).toBe(true);
		if (result.ok) result.lease.release();
	});

	it("T19c: an own-pid leftover (failed release) is reclaimed immediately", async () => {
		const { child } = await setup("imp-lease19c-");
		writeLease(child, leasePayload({ pid: leaseOptions.pid }));
		const result = acquireChildLease(child, "new-attempt", { ...leaseOptions, isAlive: () => true });
		expect(result.ok).toBe(true);
		if (result.ok) result.lease.release();
	});

	it("T20a: a live foreign pid refuses as busy", async () => {
		const { child } = await setup("imp-lease20a-");
		writeLease(child, leasePayload({ pid: 8888 }));
		const result = acquireChildLease(child, "new-attempt", {
			...leaseOptions,
			isAlive: (pid) => pid === 8888,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("busy");
			expect(result.message).toContain("pid 8888");
		}
	});

	it("T20b: host or machine-id mismatch refuses as owned-elsewhere", async () => {
		const first = await setup("imp-lease20b1-");
		writeLease(first.child, leasePayload({ host: "other-host" }));
		const byHost = acquireChildLease(first.child, "new-attempt", { ...leaseOptions, isAlive: () => false });
		expect(byHost.ok).toBe(false);
		if (!byHost.ok) expect(byHost.code).toBe("owned-elsewhere");

		const second = await setup("imp-lease20b2-");
		writeLease(second.child, leasePayload({ machineId: "other-machine" }));
		const byMachine = acquireChildLease(second.child, "new-attempt", {
			...leaseOptions,
			isAlive: () => false,
		});
		expect(byMachine.ok).toBe(false);
		if (!byMachine.ok) expect(byMachine.code).toBe("owned-elsewhere");
	});

	it("T20c: a zero-byte leftover (failed release) is debris, immediately reclaimable", async () => {
		const { child } = await setup("imp-lease20c-");
		writeFileSync(leasePathFor(child), "");
		const result = acquireChildLease(child, "new-attempt", { ...leaseOptions, isAlive: () => true });
		expect(result.ok).toBe(true);
		// Release on a foreign/debris lease leaves it alone; this one is ours now.
		if (result.ok) result.lease.release();
	});

	it("T21a: unparseable debris is reclaimed", async () => {
		const { child } = await setup("imp-lease21a-");
		writeLease(child, "{not json");
		const result = acquireChildLease(child, "new-attempt", { ...leaseOptions, isAlive: () => true });
		expect(result.ok).toBe(true);
		if (result.ok) result.lease.release();
	});

	it("T21b: a lease re-created inside the steal window refuses as stale-contended and is restored", async () => {
		const { child } = await setup("imp-lease21b-");
		writeLease(child, leasePayload());
		ageLease(child, 120_000);
		const result = acquireChildLease(child, "new-attempt", {
			...leaseOptions,
			isAlive: () => false,
			onBeforeStealRename: () => {
				// Simulate another process re-creating a LIVE lease in the window.
				writeLease(child, leasePayload({ pid: 777, attemptId: "newer-attempt" }));
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("stale-contended");
		const restored = JSON.parse(readFileSync(leasePathFor(child), "utf8")) as { attemptId?: string };
		expect(restored.attemptId).toBe("newer-attempt");
	});

	it("T25b: release leaves a foreign lease alone", async () => {
		const { child } = await setup("imp-lease25b-");
		const result = acquireChildLease(child, "attempt-1", leaseOptions);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Someone replaced the lease under us before release.
		writeLease(child, leasePayload({ pid: 777, attemptId: "foreign" }));
		result.lease.release();
		const after = JSON.parse(readFileSync(leasePathFor(child), "utf8")) as { attemptId?: string };
		expect(after.attemptId).toBe("foreign");
	});

	it("T28: the heartbeat touches mtime; a foreign lease at a beat reports an anomaly", async () => {
		const { child } = await setup("imp-lease28-");
		let fakeNow = Date.now();
		const acquired = acquireChildLease(child, "attempt-hb", {
			...leaseOptions,
			now: () => fakeNow,
			heartbeatMs: 10,
		});
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		const anomalies: number[] = [];
		try {
			acquired.lease.startHeartbeat(() => anomalies.push(1));
			const before = statSync(leasePathFor(child)).mtimeMs;
			fakeNow += 60_000;
			await new Promise((resolve) => setTimeout(resolve, 50));
			const after = statSync(leasePathFor(child)).mtimeMs;
			expect(after).toBeGreaterThan(before); // touched forward with the injected clock
			// A foreign lease at the next beat is an anomaly.
			writeLease(child, leasePayload({ pid: 777, attemptId: "foreign" }));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(anomalies.length).toBeGreaterThan(0);
		} finally {
			acquired.lease.release();
		}
	});
});
