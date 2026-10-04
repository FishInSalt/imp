// Print-mode run_start emission + crash-path liveness through a copied Ink
// installation. A local 401 reaches runTurn after run_start; run_end never
// fires, so task-timer's unref'd interval must not keep the child alive.
import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createCliFixture, startRejectingProvider } from "./helpers/cli-fixture.js";

const run = promisify(execFile);
const TASK_TIMER = path.resolve(import.meta.dirname, "../examples/extensions/task-timer.mjs");

describe("print-mode run_start + crash liveness (task-timer design §3.3/§4.5)", () => {
	it("run_start fires on the print path; a crashed run with a live task-timer still exits", async () => {
		const fixture = createCliFixture();
		const provider = await startRejectingProvider();
		try {
			const marker = path.join(fixture.cwd, "marker.txt");
			const probe = path.join(fixture.cwd, "probe.mjs");
			const timer = path.join(fixture.cwd, "task-timer.mjs");
			await copyFile(TASK_TIMER, timer);
			await writeFile(
				probe,
				`import { appendFileSync } from "node:fs";
export default function (api) {
	api.on("run_start", () => appendFileSync(${JSON.stringify(marker)}, "run_start\\n"));
	api.on("run_end", () => appendFileSync(${JSON.stringify(marker)}, "run_end\\n"));
}
`,
			);
			const failure = await run(process.execPath, [fixture.bin, "-p", "hi", "-e", probe, "-e", timer], {
				cwd: fixture.cwd,
				env: fixture.env({
					ANTHROPIC_API_KEY: "fixture-key",
					ANTHROPIC_BASE_URL: provider.url,
				}),
				timeout: 10_000,
			}).then(
				() => null,
				(error: unknown) => error as { killed?: boolean; code?: number; stderr?: string },
			);
			// Verify the intended local provider failure, not a timeout or unrelated startup error.
			expect(failure).not.toBeNull();
			expect(failure?.killed ?? false).toBe(false);
			expect(failure?.code).toBe(1);
			expect(failure?.stderr).toContain("401");
			expect(failure?.stderr).not.toContain("Blocked nonlocal");
			expect(provider.requests).toEqual(["/v1/messages"]);
			expect(await readFile(marker, "utf8")).toBe("run_start\n");
		} finally {
			await provider.close();
			fixture.cleanup();
		}
	}, 15_000);
});
