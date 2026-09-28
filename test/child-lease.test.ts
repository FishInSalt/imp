/**
 * SA-07 single-writer lease tests — intent + verify protocol
 * (design docs/sa-07-child-resume-design.md §7, revised after owner round 3).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireChildLease } from "../src/core/child-lease.js";

const leaseOptions = {
	pid: 4242,
	host: "test-host",
	machineId: "machine-1",
	nonce: "my-instance",
	staleGraceMs: 60_000,
	heartbeatMs: 20_000,
	maxAttempts: 1, // deterministic tests never retry
};

const leaseDirFor = (child: string) => `${child}.lease`;
const candidateName = (pid: number, nonce: string, attemptId: string) =>
	`lease-${pid}-${nonce.slice(0, 8)}-${attemptId}`;

function payload(overrides: Record<string, unknown> = {}) {
	return {
		pid: 999999,
		host: "test-host",
		machineId: "machine-1",
		nonce: "old-instance",
		attemptId: "old-attempt",
		startedAt: new Date(0).toISOString(),
		...overrides,
	};
}

/** Seed another process's candidate (shape as the real protocol writes it). */
function seedCandidate(child: string, overrides: Record<string, unknown> = {}): string {
	const record = payload(overrides);
	mkdirSync(leaseDirFor(child), { recursive: true });
	const file = path.join(leaseDirFor(child), candidateName(record.pid, record.nonce, record.attemptId));
	writeFileSync(file, `${JSON.stringify(record)}\n`);
	return file;
}

function ageFile(file: string, ms: number): void {
	const then = new Date(Date.now() - ms);
	utimesSync(file, then, then);
}

async function setup(prefix: string): Promise<{ base: string; child: string }> {
	const base = await mkdtemp(path.join(tmpdir(), prefix));
	return { base, child: path.join(base, "child.jsonl") };
}

describe("child lease (intent + verify)", () => {
	it("T18: a second in-process acquire refuses while the first holds", async () => {
		const { child } = await setup("imp-lease-");
		const first = acquireChildLease(child, "attempt-1", leaseOptions);
		expect(first.ok).toBe(true);
		const second = acquireChildLease(child, "attempt-2", leaseOptions);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.code).toBe("busy");
		if (first.ok) first.lease.release();
	});

	it("T19a: a live foreign candidate refuses as busy", async () => {
		const { child } = await setup("imp-lease19a-");
		seedCandidate(child, { pid: 8888 });
		const result = acquireChildLease(child, "new", { ...leaseOptions, isAlive: (pid) => pid === 8888 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("busy");
			expect(result.message).toContain("8888");
		}
	});

	it("T19b: a dead owner with a FRESH candidate still refuses (uncertain)", async () => {
		const { child } = await setup("imp-lease19b-");
		seedCandidate(child, { pid: 999999 });
		const result = acquireChildLease(child, "new", { ...leaseOptions, isAlive: () => false });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("busy");
	});

	it("T19c: a dead owner with an AGED candidate is retired and the acquire proceeds", async () => {
		const { child } = await setup("imp-lease19c-");
		const stale = seedCandidate(child, { pid: 999999 });
		ageFile(stale, 120_000);
		const result = acquireChildLease(child, "new", { ...leaseOptions, isAlive: () => false });
		expect(result.ok).toBe(true);
		expect(() => statSync(stale)).toThrow(); // the dead generation was cleaned
		if (result.ok) result.lease.release();
	});

	it("T19d: a same-pid candidate with a FOREIGN nonce is refused and untouched", async () => {
		const { child } = await setup("imp-lease19d-");
		const other = seedCandidate(child, { pid: leaseOptions.pid, nonce: "other-instance" });
		const result = acquireChildLease(child, "new", { ...leaseOptions, isAlive: () => true });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("busy");
		expect(readFileSync(other, "utf8")).toContain("other-instance"); // never reclaimed
	});

	it("T20: a different host or machine id refuses as owned-elsewhere", async () => {
		const first = await setup("imp-lease20a-");
		seedCandidate(first.child, { host: "other-host" });
		const byHost = acquireChildLease(first.child, "new", { ...leaseOptions, isAlive: () => false });
		expect(byHost.ok).toBe(false);
		if (!byHost.ok) expect(byHost.code).toBe("owned-elsewhere");

		const second = await setup("imp-lease20b-");
		seedCandidate(second.child, { machineId: "other-machine" });
		const byMachine = acquireChildLease(second.child, "new", { ...leaseOptions, isAlive: () => false });
		expect(byMachine.ok).toBe(false);
		if (!byMachine.ok) expect(byMachine.code).toBe("owned-elsewhere");
	});

	it("T21: unreadable candidates are uncertain while fresh and retired once aged", async () => {
		const first = await setup("imp-lease21a-");
		mkdirSync(leaseDirFor(first.child), { recursive: true });
		const garbage = path.join(leaseDirFor(first.child), "lease-777-abcdef12-junk");
		writeFileSync(garbage, "{not json");
		const fresh = acquireChildLease(first.child, "new", { ...leaseOptions, isAlive: () => false });
		expect(fresh.ok).toBe(false);
		if (!fresh.ok) expect(fresh.code).toBe("busy");

		const second = await setup("imp-lease21b-");
		mkdirSync(leaseDirFor(second.child), { recursive: true });
		const debris = path.join(leaseDirFor(second.child), "lease-777-abcdef12-junk");
		writeFileSync(debris, "{not json");
		ageFile(debris, 120_000);
		const aged = acquireChildLease(second.child, "new", { ...leaseOptions, isAlive: () => false });
		expect(aged.ok).toBe(true);
		expect(() => statSync(debris)).toThrow();
		if (aged.ok) aged.lease.release();
	});

	it("T25: release unlinks OWN candidate only", async () => {
		const { child } = await setup("imp-lease25-");
		const result = acquireChildLease(child, "attempt-1", leaseOptions);
		expect(result.ok).toBe(true);
		const own = path.join(
			leaseDirFor(child),
			candidateName(leaseOptions.pid, leaseOptions.nonce, "attempt-1"),
		);
		expect(() => statSync(own)).not.toThrow();
		if (result.ok) result.lease.release();
		expect(() => statSync(own)).toThrow();
		// Refusal cleanup also removes only the own candidate.
		const foreign = seedCandidate(child, { pid: 7777 });
		const refused = acquireChildLease(child, "attempt-2", { ...leaseOptions, isAlive: () => true });
		expect(refused.ok).toBe(false);
		expect(() => statSync(foreign)).not.toThrow();
	});

	it("T28: the heartbeat touches the own candidate; its disappearance is an anomaly", async () => {
		const { child } = await setup("imp-lease28-");
		let fakeNow = Date.now();
		const acquired = acquireChildLease(child, "attempt-hb", {
			...leaseOptions,
			now: () => fakeNow,
			heartbeatMs: 10,
		});
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		const own = path.join(
			leaseDirFor(child),
			candidateName(leaseOptions.pid, leaseOptions.nonce, "attempt-hb"),
		);
		const anomalies: number[] = [];
		try {
			acquired.lease.startHeartbeat(() => anomalies.push(1));
			const before = statSync(own).mtimeMs;
			fakeNow += 60_000;
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(statSync(own).mtimeMs).toBeGreaterThan(before);
			rmSync(own, { force: true }); // simulate the candidate vanishing under us
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(anomalies.length).toBeGreaterThan(0);
		} finally {
			acquired.lease.release();
		}
	});

	it("T30b(iv): the own candidate survives from create through the scan decision (A1 invariant)", async () => {
		const { child } = await setup("imp-lease-inv-");
		seedCandidate(child, { pid: 8888 }); // a live blocker for the refusal path
		const ownPath = path.join(leaseDirFor(child), candidateName(leaseOptions.pid, leaseOptions.nonce, "inv"));
		let seenAtScan: boolean | undefined;
		const refused = acquireChildLease(child, "inv", {
			...leaseOptions,
			isAlive: (pid) => pid === 8888,
			onBeforeScan: () => {
				seenAtScan = existsSync(ownPath);
			},
		});
		expect(refused.ok).toBe(false);
		expect(seenAtScan).toBe(true); // never unlinked between create and the decision
		expect(existsSync(ownPath)).toBe(false); // refusal cleanup ran AFTER the decision
	});

	it("T26-fairness: exclusive access holds when the heartbeat is never started", async () => {
		const { child } = await setup("imp-lease26-");
		const first = acquireChildLease(child, "attempt-1", leaseOptions);
		expect(first.ok).toBe(true);
		// No startHeartbeat call at all: exclusion must not depend on it.
		const second = acquireChildLease(child, "attempt-2", leaseOptions);
		expect(second.ok).toBe(false);
		if (first.ok) first.lease.release();
	});
});

describe("child lease — legacy single-FILE migration", () => {
	function writeLegacy(child: string, record: unknown): string {
		const file = leaseDirFor(child);
		writeFileSync(file, `${JSON.stringify(record)}\n`);
		return file;
	}

	it("a live legacy artifact refuses with NO directory created", async () => {
		const { child } = await setup("imp-lease-legacy1-");
		writeLegacy(child, payload({ pid: 8888 }));
		const result = acquireChildLease(child, "new", { ...leaseOptions, isAlive: (pid) => pid === 8888 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("busy");
		expect(statSync(leaseDirFor(child)).isFile()).toBe(true); // still the legacy file
	});

	it("a dead+aged legacy artifact is migrated away and the acquire proceeds", async () => {
		const { child } = await setup("imp-lease-legacy2-");
		const legacy = writeLegacy(child, payload({ pid: 999999 }));
		ageFile(legacy, 120_000);
		const result = acquireChildLease(child, "new", { ...leaseOptions, isAlive: () => false });
		expect(result.ok).toBe(true);
		expect(statSync(leaseDirFor(child)).isDirectory()).toBe(true); // migrated to candidate dir
		if (result.ok) result.lease.release();
	});

	it("a fresh unreadable legacy artifact refuses; an aged one is retired", async () => {
		const first = await setup("imp-lease-legacy3-");
		writeFileSync(leaseDirFor(first.child), "{broken");
		const fresh = acquireChildLease(first.child, "new", { ...leaseOptions, isAlive: () => false });
		expect(fresh.ok).toBe(false);
		if (!fresh.ok) expect(fresh.code).toBe("busy");

		const second = await setup("imp-lease-legacy4-");
		const debris = leaseDirFor(second.child);
		writeFileSync(debris, "{broken");
		ageFile(debris, 120_000);
		const aged = acquireChildLease(second.child, "new", { ...leaseOptions, isAlive: () => false });
		expect(aged.ok).toBe(true);
		if (aged.ok) aged.lease.release();
	});
});

describe("child lease — machine id (publish-once, §7.4)", () => {
	const idPathOf = (child: string) => path.join(path.dirname(child), ".imp-machine-id");
	const ownCandidateOf = (child: string, attemptId: string) =>
		path.join(leaseDirFor(child), candidateName(4242, "my-instance", attemptId));

	it("T29/T33a: production init publishes once; a valid id is never rewritten", async () => {
		const { child } = await setup("imp-mid-");
		const first = acquireChildLease(child, "a1", {
			pid: 4242,
			host: "test-host",
			nonce: "my-instance",
			maxAttempts: 1,
		});
		expect(first.ok).toBe(true);
		const id = readFileSync(idPathOf(child), "utf8");
		expect(id.trim()).not.toBe("");
		expect(JSON.parse(readFileSync(ownCandidateOf(child, "a1"), "utf8")).machineId).toBe(id.trim());
		if (first.ok) first.lease.release();
		const second = acquireChildLease(child, "a2", {
			pid: 4242,
			host: "test-host",
			nonce: "my-instance",
			maxAttempts: 1,
		});
		expect(second.ok).toBe(true);
		expect(readFileSync(idPathOf(child), "utf8")).toBe(id); // byte-stable
		expect(JSON.parse(readFileSync(ownCandidateOf(child, "a2"), "utf8")).machineId).toBe(id.trim());
		if (second.ok) second.lease.release();
	});

	it("T33b: a concurrent ABSENT publisher loses the link race and ADOPTS the winner", async () => {
		const { child } = await setup("imp-mid-race-");
		const competitor = "11111111-2222-4333-8444-555555555555";
		const result = acquireChildLease(child, "a1", {
			pid: 4242,
			host: "test-host",
			nonce: "my-instance",
			maxAttempts: 1,
			onBeforeMachineIdPublish: () => {
				// Simulate the winner publishing between our read and our link.
				writeFileSync(idPathOf(child), `${competitor}\n`);
			},
		});
		expect(result.ok).toBe(true);
		expect(readFileSync(idPathOf(child), "utf8").trim()).toBe(competitor); // never clobbered
		expect(JSON.parse(readFileSync(ownCandidateOf(child, "a1"), "utf8")).machineId).toBe(competitor);
		if (result.ok) result.lease.release();
	});

	it("T33d: an EMPTY id file refuses with guidance and is never touched", async () => {
		const { child } = await setup("imp-mid-empty-");
		writeFileSync(idPathOf(child), "");
		const refused = acquireChildLease(child, "a1", {
			pid: 4242,
			host: "test-host",
			nonce: "my-instance",
			maxAttempts: 1,
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.code).toBe("io-error");
			expect(refused.message).toContain("empty");
			expect(refused.message).toContain("delete");
		}
		expect(readFileSync(idPathOf(child), "utf8")).toBe(""); // untouched
		rmSync(idPathOf(child));
		const recovered = acquireChildLease(child, "a2", {
			pid: 4242,
			host: "test-host",
			nonce: "my-instance",
			maxAttempts: 1,
		});
		expect(recovered.ok).toBe(true);
		if (recovered.ok) recovered.lease.release();
	});

	it("T33e: an id referenced by a live lease stays stable while another process initializes", async () => {
		const { child } = await setup("imp-mid-stable-");
		const first = acquireChildLease(child, "a1", {
			pid: 4242,
			host: "test-host",
			nonce: "my-instance",
			maxAttempts: 1,
		});
		expect(first.ok).toBe(true);
		const referenced = JSON.parse(readFileSync(ownCandidateOf(child, "a1"), "utf8")).machineId as string;
		// Another process initializes concurrently (it must adopt, not rewrite).
		const second = acquireChildLease(child, "a2", {
			pid: 4242,
			host: "test-host",
			nonce: "my-instance",
			maxAttempts: 1,
		});
		if (second.ok) second.lease.release();
		expect(readFileSync(idPathOf(child), "utf8").trim()).toBe(referenced);
		if (first.ok) first.lease.release();
	});
});
