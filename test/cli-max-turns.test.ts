import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, "../bin/imp.js");

/** Hermetic world: no .env, no settings, no creds — the runner must fail
 *  BEFORE any model call (missing credential), which still exercises the
 *  argv layer we are pinning (#no-turn-cap plumbing). */
let world: string | undefined;
async function freshWorld(): Promise<string> {
	world = await mkdtemp(path.join(tmpdir(), "imp-cap-e2e-"));
	return world;
}
afterEach(() => {
	world = undefined;
});

describe("#no-turn-cap CLI wiring (bin/imp.js e2e)", () => {
	it("--max-turns rejects non-numeric values instead of silently uncapping", async () => {
		const dir = await freshWorld();
		await expect(
			run(process.execPath, [BIN, "--max-turns", "foo", "-p", "hi"], {
				cwd: dir, // neutral cwd — the repo's trust/settings must not interfere
				env: {
					...process.env,
					HOME: dir,
					IMP_MODEL: undefined as unknown as string,
					ANTHROPIC_AUTH_TOKEN: undefined as unknown as string,
					ANTHROPIC_API_KEY: undefined as unknown as string,
					ANTHROPIC_BASE_URL: undefined as unknown as string,
					ZAI_API_KEY: undefined as unknown as string,
					OPENAI_API_KEY: undefined as unknown as string,
				},
			}),
		).rejects.toThrow(/Invalid --max-turns value "foo"/);
	});

	it("--max-turns rejects zero and negatives", async () => {
		const dir = await freshWorld();
		await expect(
			run(process.execPath, [BIN, "--max-turns", "0", "-p", "hi"], {
				cwd: dir,
				env: { ...process.env, HOME: dir },
			}),
		).rejects.toThrow(/must be a positive integer/);
	});
});
