import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURE_PREFIXES } from "./helpers/fixture-prefixes.js";

/** §7.6: sweep-rule unit test against the committed inventory.
 *  The sweep itself lives in settings-setup (runs in real suite); here we
 *  pin its decision rule via the same inventory + the same predicate
 *  (prefix match AND mtime older than 24h). Foreign decoys and fresh
 *  entries must survive. */
const STALE_MS = 24 * 60 * 60 * 1000;

function wouldSweep(name: string, mtime: number, now: number): boolean {
	if (!FIXTURE_PREFIXES.some((p) => name.startsWith(p))) return false;
	return now - mtime > STALE_MS;
}

it("sweep rule: stale inventory-prefixed entries are swept", () => {
	const now = Date.now();
	expect(wouldSweep("ink-lease-s1-abc", now - STALE_MS - 1000, now)).toBe(true);
	expect(wouldSweep("ink-wt-base-123", now - STALE_MS - 1000, now)).toBe(true);
});

it("sweep rule: fresh inventory entries survive (killed-worker race)", () => {
	const now = Date.now();
	expect(wouldSweep("ink-lease-s1-abc", now - 60_000, now)).toBe(false);
});

it("sweep rule: foreign imp-* decoys NEVER swept (M-1 §1.2 rule)", () => {
	const now = Date.now();
	expect(wouldSweep("imp-policy-xyz", now - STALE_MS * 10, now)).toBe(false);
	expect(wouldSweep("imp-auth-foreign", now - STALE_MS * 10, now)).toBe(false);
});

it("sweep rule: inventory covers the parameterized lease prefixes (M-3 regression)", () => {
	for (const p of ["ink-lease19a-", "ink-lease-inv-", "ink-mid-", "ink-f1-", "ink-cr-wt-base-"]) {
		expect(FIXTURE_PREFIXES).toContain(p);
	}
});
