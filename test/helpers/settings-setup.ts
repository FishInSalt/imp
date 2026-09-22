/**
 * Global test setup: point the settings file at a per-process temp path so
 * runner tests never read or write the real ~/.imp/settings.json
 * (#thinking-levels persistence — a stray write once left "low" there).
 *
 * #login-repl: the credential store gets the same sandbox — family checks
 * (familyConfigured, parseModelRef's bare-glm routing) must not depend on
 * the developer's real ~/.imp/auth.json logins. Tests that need a REAL
 * store path override IMP_AUTH_PATH themselves and restore it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.IMP_SETTINGS_PATH = join(mkdtempSync(join(tmpdir(), "imp-settings-")), "settings.json");
process.env.IMP_AUTH_PATH = join(mkdtempSync(join(tmpdir(), "imp-auth-")), "auth.json");
// M14 (#model-catalog): the pi.dev disk cache gets the same sandbox — a
// stray overlay must never leak the developer's real catalog into tests.
process.env.IMP_CATALOG_PATH = join(mkdtempSync(join(tmpdir(), "imp-catalog-")), "models-catalog.json");

// #system-md (impl review P1): HOME gets the same sandbox — os.homedir()
// resolves $HOME on POSIX, so a developer's real ~/.imp/SYSTEM.md (the
// feature's own target audience) must never leak into any test's prompt
// assembly. Fixes the class, not two call sites: skills/task-tool/mcp-
// wiring runner tests inherit the isolation for free.
process.env.HOME = mkdtempSync(join(tmpdir(), "imp-home-"));
