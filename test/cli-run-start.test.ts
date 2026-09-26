// test/cli-run-start.test.ts — print-mode run_start emission + crash-path
// liveness, e2e through bin/imp.js (task-timer design §4.6 and the §8 item 11
// dogfood, automated for print mode).
//
// The hermetic world has NO credentials, so the run fails inside runTurn —
// AFTER run_start has fired (that is the design §3.3 crash path: run_end
// never comes). With task-timer installed its tick interval is then leaked
// by design; the unref (§4.5) is what lets the process exit anyway. If that
// regresses, this test hangs until the execFile timeout kills the child —
// and fails on the `killed` assertion.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, "../bin/imp.js");
const TASK_TIMER = path.resolve(import.meta.dirname, "../examples/extensions/task-timer.mjs");

describe("print-mode run_start + crash liveness (task-timer design §3.3/§4.5)", () => {
	it("run_start fires on the print path; a crashed run with a live task-timer still exits", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-runstart-e2e-"));
		const marker = path.join(dir, "marker.txt");
		const probe = path.join(dir, "probe.mjs");
		await writeFile(
			probe,
			`import { appendFileSync } from "node:fs";
export default function (api) {
	api.on("run_start", () => appendFileSync(${JSON.stringify(marker)}, "run_start\\n"));
	api.on("run_end", () => appendFileSync(${JSON.stringify(marker)}, "run_end\\n"));
}
`,
		);
		let failure: { killed?: boolean; code?: number } | null = null;
		try {
			await run(process.execPath, [BIN, "-p", "hi", "-e", probe, "-e", TASK_TIMER], {
				cwd: dir, // neutral cwd — the repo's trust/settings must not interfere
				// Only PATH and HOME: every credential env is absent, so the run
				// fails AFTER run_start (missing API key), never reaching a model.
				env: { PATH: process.env.PATH, HOME: dir },
				timeout: 60_000,
			});
			expect.unreachable("the run must fail — hermetic world has no credentials");
		} catch (err) {
			failure = err as { killed?: boolean; code?: number };
		}
		// The process exited ON ITS OWN (non-zero: the provider error) — the
		// execFile timeout did not have to kill it. A ref'd, leaked tick would
		// fail exactly here.
		expect(failure?.killed ?? false).toBe(false);
		// run_start fired on the print path (cli.ts:885 → runTurn); run_end did
		// not — the documented crash asymmetry, locked end to end.
		expect(await readFile(marker, "utf8")).toBe("run_start\n");
	}, 90_000);
});
