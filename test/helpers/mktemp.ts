/** Test-fixture temp-dir lifecycle (test-fixture-hygiene-design §2 A1).
 *
 * Every fixture temp dir goes through here so cleanup is structural:
 * onTestFinished(rmSync) fires however the test ends. A kill of the
 * worker process itself still skips it; §A2's 24h sweep backstops
 * that case.
 *
 * Prefix discipline: must start with "ink-" (asserted). This is the
 * enforcement point for the zero-imp rule — a stray "ink-" prefix fails
 * loudly at authoring time. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export function mkTempDir(prefix: string): string {
	if (!prefix.startsWith("ink-")) {
		throw new Error(`fixture prefix must start with "ink-" — got ${JSON.stringify(prefix)}`);
	}
	const dir = mkdtempSync(join(tmpdir(), prefix));
	onTestFinished(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

/** Async flavor for tests already in async helpers (same semantics). */
export async function mkTempDirAsync(prefix: string): Promise<string> {
	return mkTempDir(prefix);
}

/** Top-level FILE flavor: registers a temp file path (not created) for
 *  removal when the test ends — for fixtures that point env vars at a
 *  not-yet-written file (auth.json style). */
const tempFiles: string[] = [];
export function tempFilePath(prefix: string): string {
	if (!prefix.startsWith("ink-")) {
		throw new Error(`fixture prefix must start with "ink-" — got ${JSON.stringify(prefix)}`);
	}
	const file = join(
		tmpdir(),
		`${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	tempFiles.push(file);
	onTestFinished(() => {
		rmSync(file, { force: true });
	});
	return file;
}
