#!/usr/bin/env node
/** Regenerate test/helpers/fixture-prefixes.ts (see that file's header).
 *  Run: node scripts/gen-fixture-prefixes.mjs   then diff. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const EXCLUDE = new Set([
  "imp-agent", "ink-agent",
  "imp-worktree-historical", "imp-worktree-task-notachild", "imp-worktree-task-test01",
  "imp-policy-xyz", "imp-auth-foreign",
  "ink-lease-s1-abc", "ink-wt-base-123",
  "imp-",
]);
const MANUAL = ["ink-grace-base-", "ink-package-smoke-", "ink-isolation-static-", "ink-output-"];
const INV = "test/helpers/fixture-prefixes.ts";

const files = execFileSync("find", ["test", "scripts", "-name", "*.ts", "-o", "-name", "*.mjs"], { encoding: "utf8" })
  .split("\n").filter((f) => f !== "" && f !== INV);
const lits = new Set();
for (const f of files) {
  for (const rx of [/"((?:imp|ink)-[a-z0-9][a-z0-9-]*)"/g, /`((?:imp|ink)-[a-z0-9][a-z0-9-]*)/g]) {
    let src;
    try { src = execFileSync("cat", [f], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); } catch { continue; }
    for (const m of src.matchAll(rx)) lits.add(m[1]);
  }
}
const post = [...new Set([...lits].filter((p) => !EXCLUDE.has(p)).map((p) => (p.startsWith("imp-") ? "ink-" + p.slice(4) : p)).concat(MANUAL))].sort();

const hdr = `/**
 * Test-fixture tmpdir prefix inventory — GENERATED, do not hand-edit.
 * (test-fixture-hygiene-design §1.2/§A2; followup review B1)
 *
 * Generator: scripts/gen-fixture-prefixes.mjs (committed — reproduce by
 * running it and diffing). Harvest = ALL string and template-literal
 * tokens matching /^(imp|ink)-[a-z0-9-]+$/ in test/ + scripts/ EXCLUDING
 * this file (self-reference), then imp→ink rename mapping (this batch
 * renamed every repo-written imp- prefix), then audited exclusions,
 * then audited manual adds.
 *
 * Excluded (audited): package identity ("imp-agent"/"ink-agent");
 * legacy-name test payloads (imp-worktree-historical, imp-worktree-task-*);
 * sweep-test decoy/sample strings (imp-policy-xyz, imp-auth-foreign,
 * ink-lease-s1-abc, ink-wt-base-123).
 * Manual adds (variable-constructed or src/-side writers, grep-invisible
 * in test/): ink-grace-base-, ink-package-smoke-, ink-isolation-static-,
 * ink-output- (B2: truncated-output logs from src/core/tools/bash.ts).
 *
 * The §A2 stale-root sweep deletes tmpdir() entries matching one of these
 * prefixes AND mtime>24h.
 */
`;
const body = "export const FIXTURE_PREFIXES: readonly string[] = [\n" + post.map((p) => `\t"${p}",\n`).join("") + "];\n";
writeFileSync(INV, hdr + body);
console.log(`entries: ${post.length} → ${INV}`);
