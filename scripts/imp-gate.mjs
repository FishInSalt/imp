/** §7.3 imp gate: every repo imp- match must be an enumerated §5 survivor
 *  site. Quote-class regex (double/single/backtick, optional leading dot) —
 *  template literals included (round-2 MAJOR-1). Exit 1 on any new match. */
import { execFileSync } from "node:child_process";

const SURVIVORS = [
	// production read arms
	"src/core/worktree.ts", // imp-worktree- recognition (:383)
	"scripts/release-guards.mjs", // imp-agent package-identity rejection (:17)
	"test/child-lease.test.ts", // .imp-machine-id legacy seeding (:491)
	// legacy-env scrubber arm (settings-setup) — line moves, match loosely
	"test/helpers/settings-setup.ts",
	// test INPUTS forging legacy shapes
	"test/ink-rename.test.ts",
	"test/child-launch-validation.test.ts",
	"test/release-guards.test.ts",
	"test/repl-commands.test.ts",
	// legacy-semantics env inputs
	"test/cli-model-explicit.test.ts",
	"test/health.test.ts",
	"test/helpers/isolation.test.ts",
	"test/web-search-config.test.ts",
	"test/mcp-config.test.ts",
	"test/edit-write.test.ts",
	"test/repl-confirm.test.ts",
	"test/settings.test.ts",
	// comments mentioning the legacy namespace
	"src/core/messages.ts",
	"scripts/imp-gate.mjs", // self (regex literal)
	"test/fixture-sweep.test.ts", // foreign-decoy sweep-rule test inputs
	"test/helpers/cli-fixture.ts",
	"test/child-resume.test.ts",
];

const out = execFileSync(
	"git",
	["grep", "-nE", '["\'`]\\.?imp-|IMP_', "--", "test/", "src/", "scripts/"],
	{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const lines = out.split("\n").filter((l) => l.trim() !== "");
const offenders = lines.filter((l) => {
	const file = l.split(":")[0];
	return !SURVIVORS.includes(file);
});
if (offenders.length > 0) {
	console.error(`imp gate: ${offenders.length} non-survivor match(es):`);
	for (const o of offenders) console.error(`  ${o}`);
	process.exit(1);
}
console.log(`imp gate: OK (${lines.length} matches, all in ${SURVIVORS.length} survivor files)`);
