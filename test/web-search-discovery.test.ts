import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedExtensions } from "../src/extensions/loader.js";

const examples = path.resolve("examples/extensions");
const canonical = path.join(examples, "web-search/index.mjs");

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("web-search packaging through the real extension loader", () => {
	it.each([
		"full examples scan",
		"installed directory",
		"installed entry symlink",
		"canonical CLI plus same-path discovery",
	] as const)("%s registers each search tool exactly once", async (mode) => {
		const base = await mkdtemp(path.join(tmpdir(), "imp-web-discovery-"));
		const cwd = path.join(base, "project");
		const home = path.join(base, "home");
		const installed = path.join(home, ".imp/extensions");
		await mkdir(cwd, { recursive: true });
		await mkdir(installed, { recursive: true });
		vi.stubEnv("TAVILY_API_KEY", "");
		vi.stubEnv("IMP_WEB_SEARCH_CONFIG", path.join(base, "missing-config.json"));

		// Verify the shipped entry resolves; old web_search.mjs no longer exists.
		const entry = path.join(examples, "web_search.mjs");
		const legacyExists = await import("node:fs").then((fs) => fs.existsSync(entry));
		expect(legacyExists).toBe(false);
		expect(await realpath(canonical)).toContain("web-search");
		const cliPaths: string[] = [];
		if (mode === "full examples scan") {
			cliPaths.push(examples);
		} else if (mode === "installed directory") {
			await cp(path.join(examples, "web-search"), path.join(installed, "web-search"), {
				recursive: true,
			});
		} else if (mode === "installed entry symlink") {
			await symlink(canonical, path.join(installed, "web-search.mjs"));
		}
		if (mode === "canonical CLI plus same-path discovery") cliPaths.push(canonical);

		// Native Node resolves relative imports from a symlink's real path;
		// Vitest's transformed module runner instead uses the symlink location.
		const { stdout } = await promisify(execFile)(process.execPath, [
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`
			import { loadExtensions } from ${JSON.stringify(new URL("../src/extensions/loader.ts", import.meta.url).href)};
			let fetchCalls = 0;
			globalThis.fetch = () => { fetchCalls++; throw new Error("Unexpected network request"); };
			const diagnostics = [];
			const loaded = await loadExtensions({
				...${JSON.stringify({ cwd, home, cliPaths, noDiscovery: false })},
				onDiagnostic: line => diagnostics.push(line),
			});
			console.log(JSON.stringify({ loaded, diagnostics, fetchCalls }));
			`,
		]);
		const { loaded, diagnostics, fetchCalls } = JSON.parse(stdout) as {
			fetchCalls: number;
			loaded: LoadedExtensions;
			diagnostics: string[];
		};
		expect(loaded.failures).toEqual([]);
		expect(diagnostics).toEqual([]);
		const names = loaded.runtime.tools.map((tool) => tool.name);
		expect(names.filter((name) => name === "web_search")).toHaveLength(1);
		expect(names.filter((name) => name === "url_read")).toHaveLength(1);
		if (mode !== "full examples scan") expect(names).toHaveLength(2);
		expect(fetchCalls).toBe(0);
		if (mode === "canonical CLI plus same-path discovery") {
			// The CLI entry and the installed symlink share a realpath, so only the
			// CLI copy loads — and its summary reports that origin.
			expect(loaded.summaries.filter((s) => s.toolCount > 0)).toHaveLength(1);
			expect(loaded.summaries[0]?.origin).toBe("cli");
		}
	});
});
