import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { type CliFixture, createCliFixture } from "./helpers/cli-fixture.js";

const run = promisify(execFile);
let world: CliFixture | undefined;
function freshWorld(): CliFixture {
	world = createCliFixture();
	return world;
}
afterEach(() => world?.cleanup());

describe("#no-turn-cap CLI wiring (fixture bin/ink.js e2e)", () => {
	it("--max-turns rejects non-numeric values instead of silently uncapping", async () => {
		const fixture = freshWorld();
		await expect(
			run(process.execPath, [fixture.bin, "--max-turns", "foo", "-p", "hi"], {
				cwd: fixture.cwd,
				env: fixture.env(),
			}),
		).rejects.toThrow(/Invalid --max-turns value "foo"/);
	});

	it.each(["0", "-1"])("--max-turns rejects %s", async (value) => {
		const fixture = freshWorld();
		await expect(
			run(process.execPath, [fixture.bin, "--max-turns", value, "-p", "hi"], {
				cwd: fixture.cwd,
				env: fixture.env(),
			}),
		).rejects.toThrow(/must be a positive integer/);
	});
});
