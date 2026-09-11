/**
 * Global test setup: point the settings file at a per-process temp path so
 * runner tests never read or write the real ~/.imp/settings.json
 * (#thinking-levels persistence — a stray write once left "low" there).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.IMP_SETTINGS_PATH = join(mkdtempSync(join(tmpdir(), "imp-settings-")), "settings.json");
