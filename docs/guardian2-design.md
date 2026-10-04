# guardian2 — a minimal config-driven permission gate (design)

Status: **rev 2 — minimal redesign.** Owner direction: minimal implementation;
the previous revisions (port-based) are discarded as design input. This
document is self-contained and deliberately small. Owner review and an
independent adversarial review are pending; no implementation before both
close.

- Worktree / branch: `imp-guardian2` / `design/guardian2`, base `main` (846b263).
- Replaces guardian v1 (modes + classifier). v1 is deleted only after cutover
  (phase P3, §6).

## 0. The model (owner direction)

1. The user writes two regex rule lists in `~/.imp/guardian2.json`: **deny**
   and **ask**.
2. A `bash` command matching a `deny` rule is blocked. Matching an `ask`
   rule prompts the human: approved runs, declined blocks.
3. A command matching neither runs — **the default is allow**.
4. No modes, no model calls, no host changes.

## 1. Scope and non-goals

In scope (v0):

- `bash` tool calls; plain `RegExp.test()` against the raw command string.
- `deny` / `ask` handling; deny evaluated before ask.
- A minimal audit log; `/guardian2 status | reload`.
- A shipped template (`examples/extensions/guardian2.template.json`).

Deliberately out of scope (start much smaller than v1; add only if a real need
appears):

- `write` / `edit` calls and any path facts (`protectedPaths`, `outsideCwd`);
- `rm` parsing, quote / heredoc masking, over-cap analysis;
- rule ids; per-rule tools; structured predicates;
- session memory for asks ("don't ask again this session");
- config file watching; project-level config; `init` / `explain` commands.

Known limits, documented and accepted:

- matching sees the raw string **including quoted text**: a command like
  `git commit -m "fix rm -rf handling"` can match an `rm -rf` rule. This is a
  heuristic gate, not an enforcement boundary; write precise regexes.
- user regexes are trusted config; ReDoS is an accepted risk.

## 2. Config: `~/.imp/guardian2.json`

```jsonc
{
  "_comment": "keys starting with _ are ignored",
  "deny": [
    { "pattern": "rm\\s+(-\\w*r\\w*f|--recursive).*\\s~", "reason": "deleting under the home directory is never allowed; hand it to the human" }
  ],
  "ask": [
    "\\bsudo\\b",                                            // string shorthand
    { "pattern": "git\\s+push\\b.*--force(?!-with-lease)", "reason": "force push rewrites shared history — push normally or coordinate first", "flags": "i" }
  ]
}
```

Schema and validation (strict, checked at load):

- Top level must be a JSON object; allowed keys: `deny`, `ask`, and `_…`
  prefixed. Unknown keys are errors (catches typos such as `deni`).
- `deny` / `ask` are arrays; missing arrays are empty.
- An entry is either a string (the regex source) or an object
  `{pattern: string, flags?: string, reason?: string}`; anything else is an
  error.
- Every regex is compiled at load; any failure fails the whole load (§5).
- Missing file = zero rules = the gate does nothing.

## 3. Behavior

`tool_call` handler for `bash` (other tools pass through untouched):

1. No rules → pass.
2. First `deny` rule whose regex matches → block: return
   `{block: true, reason: <reason> or "blocked by guardian2 rule: <pattern>"}`.
   Audit.
3. First `ask` rule whose regex matches → `confirm("allow this bash command?",
   <reason>)`; `false` → block with the reason (or "confirmation declined").
   Audit the outcome.
4. Otherwise → pass.

- Precedence: **deny before ask**.
- Subagent calls use the same rules; the audit line carries the v1-style
  child marker (`child[:<agent>]`).
- Headless hosts: `confirm` resolves `false`, so an ask match becomes a block;
  unmatched calls still run.

## 4. Surfaces

- **Audit** `~/.imp/guardian2.log`, one line per decision plus load errors:

  ```
  [deny] <pattern> — <first line of the command, capped> — blocked
  [ask]  <pattern> — <first line of the command, capped> — human: approved
  [ask]  <pattern> — <first line of the command, capped> — human: denied
  [load] config error — <first line of the error>
  ```

  Formats pinned byte-exact in tests.
- **Footer**: `setStatus("guardian2", "config error")` while the last load
  failed; cleared on a successful load. Nothing else (no rule count, no
  per-call status).
- **Commands**: `/guardian2 status` (config path, rule counts, error flag) and
  `/guardian2 reload` (re-read the file; report the outcome).

## 5. Failure posture

- Missing file → zero rules; the gate does nothing (the default is allow by
  construction; this is an opt-in gate).
- Invalid config → keep the last valid rules (if any); audit `[load] config
  error`; footer flag; `/guardian2 reload` recovers.
- First run with an invalid file → no rules, footer flag, audit line (nothing
  to keep; the gate stays open until fixed).
- The handler never throws; on an internal error, fall back to a fresh
  confirmation (fail toward asking).

## 6. Phases

- **P0 (now)**: owner review of this doc → independent adversarial review →
  fold → review closed.
- **P1 (this branch)**: implement `examples/extensions/guardian2.mjs`
  (target: ~150-200 lines) + `guardian2.template.json`;
  `test/guardian2.test.ts` (fake-api pattern, like v1's example tests); full
  suite; implementation review per the working agreement; merge to `main`
  via `--no-ff`.
- **P2 cutover** (owner-driven): on this machine
  `~/.imp/extensions/guardian.mjs` is a symlink into
  `imp/examples/extensions/guardian.mjs` — remove or repoint it **before**
  installing guardian2, so both gates never load at once. Install guardian2
  (symlink or copy), write `~/.imp/guardian2.json`, run live probes, observe.
  Archive v1's log.
- **P3 deletion batch** (after P2 observation): on `main` — delete
  `examples/extensions/guardian.mjs`, `test/guardian.test.ts`,
  `test/guardian-auto.test.ts`, `test/guardian-auto-host.test.ts`,
  `test/classify-seam.test.ts`, `src/repl/classify.ts` and the seam plumbing
  (`types.ts`, `loader.ts`, `registry.ts`, `cli.ts`, `runner.ts`, `repl.ts`,
  `call-context.ts`, `user-input-log.ts` + `test/user-input-log.test.ts`),
  adapt `test/extensions-repl.test.ts` (it loads the v1 example), add the
  SUPERSEDED banner to `docs/guardian-auto-mode-design.md`, update the
  `ExtensionApi` member-count docstring and `docs/m4-extensions-design.md`,
  README / CHANGELOG. The `imp` worktree is checked out on
  `design/extension-model-access` (the branch P3 deletes): switch it off,
  archive-tag the branch, then delete it. Remove the machine's v1 files
  (`~/.imp/extensions/guardian.mjs`, `~/.imp/guardian.json`; archive
  `guardian.log`). Apply the rename decision (§7 Q4).
- **P4 cleanup**: leftover merged branches
  (`docs/acceptance-guardian-input`, `docs/ledger-guardian-*` …), leftover
  worktrees.

## 7. Tests (P1, red-first)

1. Load: missing file (zero rules, gate lets everything through); valid file
   (string and object entries, flags); invalid JSON; unknown top-level key;
   bad entry type; invalid regex; reload recovers.
2. Deny: first matching rule blocks; no confirm call; reason text (custom and
   default).
3. Ask: confirm called with the reason; approved → runs; declined → blocks;
   string-shorthand rule works.
4. Pass: unmatched commands never confirm; a quoted-text match (`git commit
   -m "… rm -rf …"`) **matches** (documents the raw-string limit, §1).
5. Precedence: a command matching both deny and ask blocks (deny wins).
6. Child / headless: audit child marker; headless ask becomes a block.
7. Audit formats byte-exact; load-error line; footer status set/cleared.
8. Commands: `status` counts; `reload` picks up an edited file.
9. Static pin: no `classify` / `complete` / `snapshot` / `api.note` use.

## 8. Open questions (owner)

1. Session memory for asks — skipped in v0 (every ask-match prompts). Add if
   the interruptions prove annoying.
2. `write` / `edit` path rules — out of v0; add later only if wanted.
3. First run with an invalid config — flag-only (proposed; the gate is opt-in
   and defaults to allow) vs fail-closed until fixed (v1's old posture).
4. Rename `guardian2` → `guardian` at cutover, or keep the `2` — decide in P3.

## 9. Review log

- rev 2 — minimal redesign per owner direction; rev 0/1 (port-based) and the
  earlier approach documents are discarded as design input.
- rev 1 had a completed adversarial review (14 findings) against the
  port-based design; those findings are moot here except the machine-state
  and cutover facts (the symlink; the `test/extensions-repl.test.ts` and
  `test/user-input-log.test.ts` consumers), which are folded into §6.
- R1 for this document: pending.
