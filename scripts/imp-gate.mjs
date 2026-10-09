/** §7.3 imp gate: every repo imp- match must be an enumerated §5 survivor
 *  site. Quote-class regex (double/single/backtick, optional leading dot) —
 *  template literals included (round-2 MAJOR-1). Exit 1 on any new match. */
import { execFileSync } from "node:child_process";

const SURVIVORS = [
	"scripts/imp-gate.mjs", // audited survivor (gate-managed)
	"scripts/release-guards.mjs", // audited survivor (gate-managed)
	"src/core/worktree.ts", // audited survivor (gate-managed)
	"test/child-launch-validation.test.ts", // audited survivor (gate-managed)
	"test/child-lease.test.ts", // audited survivor (gate-managed)
	"test/cli-model-explicit.test.ts", // audited survivor (gate-managed)
	"test/fixture-sweep.test.ts", // audited survivor (gate-managed)
	"test/health.test.ts", // audited survivor (gate-managed)
	"test/helpers/cli-fixture.ts", // audited survivor (gate-managed)
	"test/helpers/isolation.test.ts", // audited survivor (gate-managed)
	"test/helpers/settings-setup.ts", // audited survivor (gate-managed)
	"test/ink-rename.test.ts", // audited survivor (gate-managed)
	"test/release-guards.test.ts", // audited survivor (gate-managed)
	"test/repl-commands.test.ts", // audited survivor (gate-managed)
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
