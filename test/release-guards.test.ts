import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const guard = fileURLToPath(new URL("../scripts/release-guards.mjs", import.meta.url));
const smoke = fileURLToPath(new URL("../scripts/package-smoke.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

function run(script: string, args: string[], input?: unknown) {
	return spawnSync(process.execPath, [script, ...args], {
		input: input === undefined ? undefined : JSON.stringify(input),
		encoding: "utf8",
		// No inherited credentials, dotenv, npm config or NODE_OPTIONS.
		env: { PATH: "/usr/bin:/bin" },
		timeout: 10_000,
	});
}

function decision(overrides: Record<string, unknown> = {}) {
	return run(guard, ["evaluate"], {
		pkg,
		lock,
		appVersion: pkg.version,
		event: "push",
		ref: `refs/tags/v${pkg.version}`,
		enabled: "true",
		configuredPackage: "ink-agent",
		...overrides,
	});
}

describe("release guards", () => {
	it("supports direct CLI execution through a symlink", () => {
		const directory = mkdtempSync(join(tmpdir(), "ink-release-guard-"));
		const link = join(directory, "guard.mjs");
		symlinkSync(guard, link);
		expect(run(link, ["npm-version", "11.5.1"]).stdout).toContain("satisfies >=11.5.1");
	});
	it("can be imported from stdin without executing a CLI or resolving '-'", () => {
		const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
			input: `await import(${JSON.stringify(new URL("../scripts/release-guards.mjs", import.meta.url).href)}); await import(${JSON.stringify(new URL("../scripts/package-smoke.mjs", import.meta.url).href)}); console.log("imported");`,
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" },
			timeout: 10_000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("imported\n");
	});
	it.each(["11.5.1", "11.5.2", "11.6.0", "12.0.0"])("accepts npm %s", (version) => {
		expect(run(guard, ["npm-version", version]).status).toBe(0);
	});
	it.each(["10.9.9", "11.4.9", "11.5.0", "11.5.1-beta.1", "11.5", "garbage"])("rejects npm %s", (version) => {
		expect(run(guard, ["npm-version", version]).status).toBe(1);
	});
	it("allows the matching tag push with both new gates", () => {
		const result = decision();
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("publish");
	});
	it.each([
		{ enabled: "false" },
		{ enabled: undefined },
		{ configuredPackage: "imp-agent" },
		{ configuredPackage: "ink" },
		{ configuredPackage: undefined },
		{ ref: "refs/heads/main" },
		{ event: "pull_request" },
		{ enabled: undefined, NPM_PUBLISH_ENABLED: "true" },
		{ enabled: "TRUE" },
		{ configuredPackage: "ink-agent " },
	])("skips publication with %j", (overrides) => {
		expect(decision(overrides).stdout.trim()).toBe("skip");
	});
	it.each(["refs/heads/main", `refs/tags/v${pkg.version}`])(
		"dispatch always dry-runs at %s even when dry_run=false and gates enabled",
		(ref) => {
			const result = decision({ event: "workflow_dispatch", ref, dry_run: false });
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe("dryrun");
		},
	);
	it.each(["imp-agent", "ink", "other-agent"])("rejects package identity %s", (name) => {
		expect(decision({ pkg: { ...pkg, name } }).status).toBe(1);
	});
	it.each([
		{ ref: "refs/tags/v0.1.0" },
		{ appVersion: "0.1.0" },
		{ lock: { ...lock, version: "0.1.0" } },
		{ lock: { ...lock, packages: {} } },
		{ pkg: { ...pkg, bin: { ink: "bin/ink.js", imp: "bin/imp.js" } } },
	])("fails mismatched identity %j", (overrides) => {
		expect(decision(overrides).status).toBe(1);
	});
	it("keeps YAML's real publish event guard independent of dispatch input", () => {
		const yaml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
		expect(yaml).toContain("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
		expect(yaml).toContain("vars.INK_NPM_PUBLISH_ENABLED");
		expect(yaml).toContain("vars.INK_NPM_PACKAGE");
		expect(yaml).not.toMatch(/vars\.NPM_PUBLISH_ENABLED|inputs\.dry_run|npm install -g/);
		expect(yaml).toContain('git merge-base --is-ancestor "$REF_SHA" origin/main');
	});
	it("keeps both workflows on the shared isolated artifact smoke", () => {
		for (const workflow of ["ci", "release"]) {
			const yaml = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), "utf8");
			expect(yaml).toContain('node scripts/package-smoke.mjs --cache-source "$HOME/.npm"');
			expect(yaml).not.toMatch(/npm install -g|imp-agent-\*|bin\/imp\.js/);
		}
	});
});

const files = ["package.json", "README.md", "LICENSE", "bin/ink.js", "dist/cli.js"].map((path) => ({
	path,
	mode: path === "bin/ink.js" ? 0o755 : 0o644,
	size: 10,
}));

describe("artifact strict file allowlist", () => {
	it("accepts only intentional runtime files with exact modes", () => {
		expect(run(smoke, ["inspect-report"], files).status).toBe(0);
	});
	it.each([
		"bin/imp.js",
		".env",
		".env.production",
		".ink/auth.json",
		".imp/sessions/history.jsonl",
		"src/cli.ts",
		"test/x.test.ts",
		"docs/x.md",
		"scripts/package-smoke.mjs",
		"dist/.env",
		"dist/../../auth.json",
		"dist/config.json",
		"dist/credentials.js",
		"dist/stale-extra.js",
		"unexpected.txt",
	])("rejects packed %s", (path) => {
		expect(run(smoke, ["inspect-report"], [...files, { path, mode: 0o644, size: 10 }]).status).toBe(1);
	});
	it.each([0o644, 0o777, 0o4755])("rejects launcher mode %s", (mode) => {
		expect(
			run(
				smoke,
				["inspect-report"],
				files.map((file) => (file.path === "bin/ink.js" ? { ...file, mode } : file)),
			).status,
		).toBe(1);
	});
	it("rejects a missing CLI and duplicated entries", () => {
		expect(
			run(
				smoke,
				["inspect-report"],
				files.filter((file) => file.path !== "dist/cli.js"),
			).status,
		).toBe(1);
		expect(run(smoke, ["inspect-report"], [...files, files[0]]).status).toBe(1);
	});
});
