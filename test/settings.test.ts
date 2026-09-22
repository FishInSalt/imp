import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveSettings, loadSettings, saveSettings, settingsFilePath } from "../src/core/settings.js";

describe("settings store (#thinking-levels persistence)", () => {
	it("round-trips the two keys; missing/malformed files read as empty", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "imp-settings-test-"));
		const file = path.join(dir, "settings.json");
		expect(loadSettings(file)).toEqual({}); // missing
		saveSettings({ defaultThinkingLevel: "high" }, file);
		expect(loadSettings(file)).toEqual({ defaultThinkingLevel: "high" }); // written
		saveSettings({ hideThinkingBlock: true }, file);
		expect(loadSettings(file)).toEqual({ defaultThinkingLevel: "high", hideThinkingBlock: true }); // merged
		const corrupt = path.join(dir, "corrupt.json");
		await import("node:fs/promises").then((fs) => fs.writeFile(corrupt, "{not json", "utf-8"));
		expect(loadSettings(corrupt)).toEqual({}); // malformed never blocks startup
	});

	it("a failing write NEVER throws (the session must survive a read-only home)", () => {
		expect(() =>
			saveSettings({ defaultThinkingLevel: "high" }, "/nonexistent-root-dir/x/y/settings.json"),
		).not.toThrow();
	});

	it("IMP_SETTINGS_PATH overrides the home default (the hermetic seam)", () => {
		const prev = process.env.IMP_SETTINGS_PATH;
		try {
			process.env.IMP_SETTINGS_PATH = "/tmp/imp-hermetic-settings.json";
			expect(settingsFilePath()).toBe("/tmp/imp-hermetic-settings.json");
		} finally {
			if (prev === undefined) delete process.env.IMP_SETTINGS_PATH;
			else process.env.IMP_SETTINGS_PATH = prev;
		}
	});
});

describe("M17 queue drain modes", () => {
	it("steeringMode/followUpMode coerce the two-value enum; anything else reads as unset", () => {
		const dir = mkdtempSync(join(tmpdir(), "imp-m17-"));
		const file = join(dir, "settings.json");
		writeFileSync(
			file,
			JSON.stringify({
				steeringMode: "all",
				followUpMode: "one-at-a-time",
				bogus: { steeringMode: "all" },
			}),
			"utf-8",
		);
		const loaded = loadSettings(file);
		expect(loaded.steeringMode).toBe("all");
		expect(loaded.followUpMode).toBe("one-at-a-time");
		// invalid literals drop (forgiving load, code default applies)
		writeFileSync(file, JSON.stringify({ steeringMode: "everything", followUpMode: 3 }), "utf-8");
		expect(loadSettings(file).steeringMode).toBeUndefined();
		expect(loadSettings(file).followUpMode).toBeUndefined();
	});

	it("saveSettings round-trips both keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "imp-m17-"));
		const file = join(dir, "settings.json");
		expect(saveSettings({ steeringMode: "one-at-a-time", followUpMode: "all" }, file)).toBe(true);
		const loaded = loadSettings(file);
		expect(loaded.steeringMode).toBe("one-at-a-time");
		expect(loaded.followUpMode).toBe("all");
	});
});

describe("#tree batch B settings", () => {
	it("treeFilterMode coerces the five literals; invalid/missing reads as unset", () => {
		const dir = mkdtempSync(join(tmpdir(), "imp-treeb-"));
		const file = join(dir, "settings.json");
		for (const mode of ["default", "no-tools", "user-only", "labeled-only", "all"] as const) {
			writeFileSync(file, JSON.stringify({ treeFilterMode: mode }), "utf-8");
			expect(loadSettings(file).treeFilterMode).toBe(mode);
		}
		writeFileSync(file, JSON.stringify({ treeFilterMode: "everything" }), "utf-8");
		expect(loadSettings(file).treeFilterMode).toBeUndefined(); // forgiving load
	});

	it("branchSummary.skipPrompt coerces nested; unknown nested keys drop; deep merge composes", () => {
		const dir = mkdtempSync(join(tmpdir(), "imp-treeb-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ branchSummary: { skipPrompt: true, bogus: 1 } }), "utf-8");
		const loaded = loadSettings(file);
		expect(loaded.branchSummary?.skipPrompt).toBe(true);
		expect(Object.keys(loaded.branchSummary ?? {})).toEqual(["skipPrompt"]); // bogus dropped from the view
		// saveSettings nested patch keeps raw siblings (forward compat)
		expect(saveSettings({ branchSummary: { skipPrompt: false } }, file)).toBe(true);
		const raw = JSON.parse(readFileSync(file, "utf-8")) as { branchSummary?: Record<string, unknown> };
		expect(raw.branchSummary?.bogus).toBe(1); // survived the patch
		expect(raw.branchSummary?.skipPrompt).toBe(false);
	});

	it("project scope overrides global for both keys (the deep merge)", () => {
		const dir = mkdtempSync(join(tmpdir(), "imp-treeb-"));
		const globalFile = join(dir, "global.json");
		const projectFile = join(dir, "proj", ".imp", "settings.json");
		writeFileSync(globalFile, JSON.stringify({ treeFilterMode: "user-only" }), "utf-8");
		mkdirSync(dirname(projectFile), { recursive: true });
		writeFileSync(projectFile, JSON.stringify({ treeFilterMode: "labeled-only" }), "utf-8");
		const merged = effectiveSettings({
			cwd: join(dir, "proj"),
			projectAllowed: true,
			globalPath: globalFile,
		});
		expect(merged.treeFilterMode).toBe("labeled-only"); // project wins
	});
});
