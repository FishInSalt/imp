import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NETWORK_PRELOAD } from "./helpers/cli-fixture.js";
import { mkTempDir } from "./helpers/mktemp.js";

interface WorkflowStep {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
}
interface WorkflowJob {
	"runs-on": string;
	env: Record<string, string>;
	strategy?: { matrix: { node: Array<string | number>; os: string[] } };
	steps: WorkflowStep[];
}
interface Workflow {
	jobs: Record<string, WorkflowJob>;
}

function workflow(name: string): Workflow {
	return parse(
		readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
	) as Workflow;
}

describe("CI prerequisite coverage", () => {
	it("tests the exact supported Node minimum and Node 24", () => {
		expect(workflow("ci").jobs.verify?.strategy?.matrix.node).toEqual(["22.19.0", 24]);
	});

	it.each([
		["ci", "verify"],
		["release", "gate"],
	])("%s/%s provisions and verifies required search tools before tests", (name, jobName) => {
		const job = workflow(name).jobs[jobName];
		if (name === "ci") {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression, not JavaScript interpolation.
			expect(job?.["runs-on"]).toBe("${{ matrix.os }}");
			expect(job?.strategy?.matrix.os).toEqual(["ubuntu-latest"]);
		} else {
			expect(job?.["runs-on"]).toBe("ubuntu-latest");
		}
		expect(job?.env.CI_REQUIRE_SEARCH_TOOLS).toBe("1");
		const steps = job?.steps ?? [];
		const install = steps.findIndex((step) => step.name === "install search test prerequisites");
		const verify = steps.findIndex((step) => step.name === "verify search test prerequisites");
		const test = steps.findIndex((step) => step.run === "npm test");
		expect(install).toBeGreaterThan(-1);
		expect(verify).toBe(install + 1);
		expect(test).toBeGreaterThan(verify);
		const commands = steps[install]?.run?.trim().split("\n");
		expect(commands).toEqual([
			"sudo apt-get update",
			"sudo apt-get install -y --no-install-recommends ripgrep fd-find",
			'mkdir "$RUNNER_TEMP/ink-test-tools"',
			'ln -s "$(command -v fdfind)" "$RUNNER_TEMP/ink-test-tools/fd"',
			'echo "$RUNNER_TEMP/ink-test-tools" >> "$GITHUB_PATH"',
		]);
		expect(steps[verify]?.run?.trim().split("\n")).toEqual(["rg --version", "fd --version"]);
	});
});

const repo = fileURLToPath(new URL("../", import.meta.url));
const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

function childSearchTest(missing: readonly string[], required?: string) {
	const root = mkTempDir("ink-search-prerequisites-");
	try {
		for (const name of ["home", "bin", "tmp"]) mkdirSync(join(root, name), { mode: 0o700 });
		// These stubs only prove collection-time binary availability. They never
		// execute a search: strict missing-tool cases fail before test execution,
		// and optional cases deliberately omit both binaries so all tests skip.
		for (const name of ["rg", "fd"]) {
			if (!missing.includes(name)) {
				writeFileSync(join(root, "bin", name), "#!/bin/sh\nprintf 'synthetic binary version\\n'\n", {
					mode: 0o755,
					flag: "wx",
				});
			}
		}
		const report = join(root, "report.json");
		const log = join(root, "blocked-network.log");
		const result = spawnSync(
			process.execPath,
			[
				vitest,
				"run",
				"test/search-tools.test.ts",
				"--maxWorkers=1",
				"--no-file-parallelism",
				"--reporter=json",
				`--outputFile=${report}`,
			],
			{
				cwd: repo,
				encoding: "utf8",
				timeout: 20_000,
				maxBuffer: 1024 * 1024,
				env: {
					// No inherited credentials, proxies, config, real HOME or parent CI flag.
					HOME: join(root, "home"),
					USERPROFILE: join(root, "home"),
					TMPDIR: join(root, "tmp"),
					PATH: join(root, "bin"),
					NO_COLOR: "1",
					NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
					INK_TEST_NETWORK_LOG: log,
					...(required === undefined ? {} : { CI_REQUIRE_SEARCH_TOOLS: required }),
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		// A swallowed nonlocal attempt also produces stderr and a failing child.
		// Check the exact collection error in the caller to exclude unrelated exits.
		expect(result.stderr).not.toContain("Blocked nonlocal");
		const reportText = readFileSync(report, "utf8");
		return {
			status: result.status,
			output: result.stdout + result.stderr + reportText,
			report: JSON.parse(reportText) as {
				success: boolean;
				numPassedTests: number;
				numFailedTests: number;
				numPendingTests: number;
			},
		};
	} finally {
		rmSync(root, { recursive: true });
	}
}

describe("search prerequisite failure versus optional local skips", () => {
	it.each(["rg", "fd"])("fails collection specifically when required %s is absent", (name) => {
		const result = childSearchTest([name], "1");
		expect(result.status).toBe(1);
		expect(result.report.success).toBe(false);
		expect(result.output).toContain(`Required search test binaries missing: ${name}`);
		expect(result.output).not.toContain(`missing: ${name},`);
	});

	it.each([undefined, "0"])("keeps local skips without an enabled strict flag (%s)", (flag) => {
		const result = childSearchTest(["rg", "fd"], flag);
		expect(result.status).toBe(0);
		expect(result.report.success).toBe(true);
		expect(result.report.numPassedTests).toBe(0);
		expect(result.report.numFailedTests).toBe(0);
		expect(result.report.numPendingTests).toBe(9);
		expect(result.output).not.toContain("Required search test binaries missing:");
	});
});
