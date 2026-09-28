/**
 * T30b — the deterministic three-process regression the owner demanded:
 * real spawned processes with marker-file rendezvous drive the interleavings
 * that broke the single-file protocol, against the intent + verify protocol
 * (design §7.3).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function runRole(dir: string, role: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"npx",
			["vitest", "run", "test/helpers/lease-script-worker.test.ts", "--reporter=dot"],
			{
				cwd: repoRoot,
				env: { ...process.env, IMP_LEASE_SCRIPT: `${dir}|${role}`, NO_COLOR: "1" },
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? -1));
	});
}

interface RoleResult {
	tag: string;
	outcome: string;
}

function parseResults(dir: string): RoleResult[] {
	const raw = readFileSync(path.join(dir, "results"), "utf8").trim();
	return raw.split("\n").map((line) => {
		const [, tag, outcome] = line.split(" ");
		return { tag: tag as string, outcome: outcome as string };
	});
}

async function waitForMarker(dir: string, name: string, timeoutMs = 20_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path.join(dir, name))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`marker ${name} never appeared`);
}

function seedAgedDeadCandidate(dir: string): string {
	// Pre-publish the machine id the spawned workers will adopt (the
	// production path would publish its own otherwise), so the seeded
	// candidate matches the workers' identity instead of being refused as
	// owned-elsewhere.
	const machineId = "00000000-1111-4222-8333-444444444444";
	writeFileSync(path.join(dir, ".imp-machine-id"), `${machineId}\n`);
	const leaseDir = path.join(dir, "child.jsonl.lease");
	mkdirSync(leaseDir, { recursive: true });
	const file = path.join(leaseDir, "lease-999999-deadbeef-stale");
	writeFileSync(
		file,
		`${JSON.stringify({
			pid: 999999,
			host: hostname(),
			machineId,
			nonce: "dead-instance",
			attemptId: "stale",
			startedAt: new Date(0).toISOString(),
		})}\n`,
	);
	const then = new Date(Date.now() - 120_000);
	utimesSync(file, then, then);
	return file;
}

async function freshDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("lease — deterministic multiprocess interleavings (T30b)", () => {
	it("(i) A pauses before scanning while B sees A: A proceeds, B refuses", async () => {
		const dir = await freshDir("imp-lease-s1-");
		const [codeA, codeB] = await Promise.all([runRole(dir, "a1"), runRole(dir, "b1")]);
		expect(codeA).toBe(0);
		expect(codeB).toBe(0);
		const results = parseResults(dir);
		const byTag = new Map(results.map((entry) => [entry.tag, entry.outcome]));
		expect(byTag.get("a1")).toBe("ok"); // B's refusal unlinked B's candidate…
		expect(byTag.get("b1")).toBe("busy"); // …so A's later scan saw only itself
		expect(existsSync(path.join(dir, "a-created"))).toBe(true);
		expect(existsSync(path.join(dir, "b-done"))).toBe(true);
		// Both candidates were cleaned (B on refusal, A on release).
		expect(readdirSync(path.join(dir, "child.jsonl.lease"))).toHaveLength(0);
	}, 60_000);

	it("(ii) a stale candidate is cleaned by B; a later A sees B's live claim and refuses", async () => {
		const dir = await freshDir("imp-lease-s2-");
		const stale = seedAgedDeadCandidate(dir);
		const b = runRole(dir, "b2");
		await waitForMarker(dir, "b-done"); // B cleaned the stale candidate and HOLDS
		const a = await runRole(dir, "a2");
		expect(a).toBe(0);
		expect(await b).toBe(0);
		const byTag = new Map(parseResults(dir).map((entry) => [entry.tag, entry.outcome]));
		expect(byTag.get("b2")).toBe("ok");
		expect(byTag.get("a2")).toBe("busy"); // B held while A scanned — no third-party window
		expect(existsSync(stale)).toBe(false); // dead+aged generation was retired
	}, 60_000);

	it("(iii) B and C create simultaneously: never two holders", async () => {
		const dir = await freshDir("imp-lease-s3-");
		seedAgedDeadCandidate(dir);
		const b = runRole(dir, "b3");
		const c = runRole(dir, "c3");
		await waitForMarker(dir, "b3-created");
		await waitForMarker(dir, "c3-created");
		writeFileSync(path.join(dir, "go"), "");
		const [codeB, codeC] = await Promise.all([b, c]);
		expect(codeB).toBe(0);
		expect(codeC).toBe(0);
		const outcomes = parseResults(dir).map((entry) => entry.outcome);
		expect(outcomes.filter((outcome) => outcome === "ok").length).toBeLessThanOrEqual(1);
	}, 60_000);
});
