import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings, settingsFilePath } from "../src/core/settings.js";

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
