import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
// @ts-expect-error The package smoke script is JavaScript without declarations.
import { assertVersionOutput } from "../scripts/package-smoke.mjs";
import { VERSION } from "../src/format.js";
import { createCliFixture } from "./helpers/cli-fixture.js";

const run = promisify(execFile);

// Release identity: ink --version, npm and lockfile must agree.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	name: string;
	version: string;
	description: string;
	bin: Record<string, string>;
	files: string[];
	repository: { url: string };
	homepage: string;
	bugs: { url: string };
	engines: { node: string };
};
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
	name: string;
	version: string;
	packages: Record<
		string,
		{ name: string; version: string; bin: Record<string, string>; engines?: { node: string } }
	>;
};

describe("package metadata (release identity)", () => {
	it("src/format.ts VERSION and lockfile match the selected package", () => {
		expect(pkg.name).toBe("ink-agent");
		expect(pkg.version).toBe("0.3.0");
		expect(VERSION).toBe(pkg.version);
		expect(lock.name).toBe(pkg.name);
		expect(lock.version).toBe(pkg.version);
		expect(lock.packages[""]?.name).toBe(pkg.name);
		expect(lock.packages[""]?.version).toBe(pkg.version);
		expect(lock.packages[""]?.bin).toEqual(pkg.bin);
	});

	it("matches the supported Node minimum to the pinned TUI dependency", () => {
		expect(pkg.engines.node).toBe(">=22.19.0");
		expect(lock.packages[""]?.engines).toEqual(pkg.engines);
		expect(lock.packages["node_modules/@earendil-works/pi-tui"]?.engines).toEqual(pkg.engines);
	});

	it("the controlled CLI emits the exact capitalized version accepted by the artifact smoke", async () => {
		const fixture = createCliFixture();
		try {
			const { stdout, stderr } = await run(process.execPath, [fixture.bin, "--version"], {
				cwd: fixture.cwd,
				env: fixture.env(),
				timeout: 10_000,
			});
			expect(stdout).toBe(`Ink ${pkg.version}\n`);
			expect(stderr).toBe("");
			// Exercise the same assertion used for both install and npm-exec,
			// against actual CLI output rather than a copy of its source text.
			expect(() => assertVersionOutput(stdout, pkg.version)).not.toThrow();
		} finally {
			fixture.cleanup();
		}
	});

	it.each([
		`ink ${pkg.version}\n`,
		`IMP ${pkg.version}\n`,
		`Ink 0.1.0\n`,
		`Ink ${pkg.version}`,
		`Ink ${pkg.version}\nextra\n`,
	])("the smoke rejects a version output outside the exact runtime contract: %j", (output) => {
		expect(() => assertVersionOutput(output, pkg.version)).toThrow("Unexpected CLI version output");
	});

	it("has a single executable ink launcher, without the old alias", () => {
		expect(pkg.bin).toEqual({ ink: "bin/ink.js" });
		const bin = new URL("../bin/ink.js", import.meta.url);
		expect(existsSync(bin)).toBe(true);
		expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
		expect(statSync(bin).mode & 0o777).toBe(0o755);
		expect(existsSync(new URL("../bin/imp.js", import.meta.url))).toBe(false);
		expect(pkg.files).toEqual([
			"bin/ink.js",
			"dist",
			"docs",
			"!docs/design",
			"examples",
			"CHANGELOG.md",
			"README.md",
			"LICENSE",
		]);
	});

	it("describes a general assistant; npm home links the docs site, issues link the repository", () => {
		expect(pkg.description).toBe("Ink — an open-source AI assistant and agent harness for the terminal");
		expect(pkg.repository.url).toBe("git+https://github.com/FishInSalt/ink.git");
		// The published docs site — built by scripts/build-docs-site.mjs and
		// deployed by .github/workflows/pages.yml.
		expect(pkg.homepage).toBe("https://fishinsalt.github.io/ink/");
		expect(pkg.bugs.url).toBe("https://github.com/FishInSalt/ink/issues");
	});
});
