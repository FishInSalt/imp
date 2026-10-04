# guardian2 — a minimal config-driven permission gate (design)

Status: **rev 2.1 — minimal redesign, R1 folded.** Owner direction: minimal
implementation; the port-based revisions are discarded as design input.
Owner review and an independent adversarial review are pending; no
implementation before both close.

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
  heuristic gate, not an enforcement boundary; write precise regexes. It errs
  toward over-matching (the safe direction) rather than masking regions.
- user regexes are trusted config. A pathological pattern can stall the
  synchronous match path — accepted (ReDoS); the input is **not** capped,
  because a cap would silently pass everything beyond it, including deny
  matches.
- a broken config disarms the gate until fixed; the footer shows
  `config error` (§5).

## 2. Config: `~/.imp/guardian2.json`

```jsonc
{
  "_comment": "keys starting with _ are ignored",
  "deny": [
    { "pattern": "\\brm\\b[^\\n]*(~(/|\\s|$)|\\$\\{?HOME\\}?)", "reason": "deleting under the home directory is never allowed; hand it to the human" }
  ],
  "ask": [
    "\\bsudo\\b",                                            // string shorthand
    { "pattern": "git\\s+push\\b[^\\n]*(-f\\b|--force(?!-with-lease))", "reason": "force push rewrites shared history — push normally or coordinate first" }
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
- `flags` must not contain `g` or `y` (stateful `lastIndex` would make
  `test()` alternate between calls) — rejected with a clear load error.
- Every regex is compiled at load; any failure fails the whole load (§5).
- Missing file = zero rules = the gate does nothing.

## 3. Behavior

`tool_call` handler for `bash` (other tools, and calls whose `command` is not
a string, pass through untouched):

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
  child marker.
- Headless hosts: `confirm` resolves `false`, so an ask match becomes a
  block; unmatched calls still run. A headless decline is indistinguishable
  from a human decline under the confirm contract — it is audited as
  `denied` (conservative).

## 4. Surfaces

- **Audit** `~/.imp/guardian2.log`, one line per deny/ask decision plus load
  errors (pass-through calls are not logged). Newlines in the pattern,
  reason, and command are flattened so the one-line invariant holds; the
  command is capped at 160 chars with a trailing `…` (v1's cap):

  ```
  [deny] <pattern> — <command> — blocked
  [deny] <pattern> — <command> — blocked (child:<agent>)
  [ask]  <pattern> — <command> — approved
  [ask]  <pattern> — <command> — denied
  [load] config error — <first line of the error>
  ```

  Formats pinned byte-exact in tests. `denied` covers declines and hosts
  with no interactive prompt (§3).
- **Footer**: `setStatus("guardian2", "config error")` while the last load
  failed; cleared on a successful load. Nothing else (no rule count, no
  per-call status).
- **Commands**: `/guardian2 status` (config path, rule counts, error flag) and
  `/guardian2 reload` (re-read the file; report the outcome).
- The log file is created with mode `0600` (command text may contain
  secrets).

## 5. Failure posture

- Missing file → zero rules; the gate does nothing (a valid, opt-in state).
- Invalid config → keep the last valid rules (if any); audit
  `[load] config error`; footer flag; `/guardian2 reload` recovers.
- First run with an invalid file → no rules, footer flag, audit line.
  Trade-off (owner question §9 Q1): a broken config disarms an unconfigured
  gate — the footer shows `config error` while it lasts. The alternative
  (confirm every bash call until fixed) is deliberately not taken: this is an
  opt-in heuristic gate, and v1's ask-everything degraded state was removed
  on purpose.
- An internal error during evaluation → fresh confirmation (fail toward
  asking — evaluation, unlike config loading, has unknown state).

## 6. Phases

- **P0 (now)**: owner review of this doc → independent adversarial review →
  fold → review closed.
- **P1 (this branch)**: implement `examples/extensions/guardian2.mjs`
  (target: ~150-200 lines) + `guardian2.template.json`;
  `test/guardian2.test.ts` (fake-api pattern, like v1's example tests); full
  suite; implementation review per the working agreement. Create an
  `imp-main` worktree (`git worktree add ../imp-main main`) for the merge
  (`--no-ff`) and later main-side edits — `main` currently has no worktree.
- **P2 cutover** (owner-driven): on this machine
  `~/.imp/extensions/guardian.mjs` is a symlink into
  `imp/examples/extensions/guardian.mjs` — remove or repoint it **before**
  installing guardian2, so both gates never load at once. Install guardian2
  by **copy**, or by a symlink to a stable path outside any branch worktree
  (a symlink into a branch worktree breaks when that branch switches). Write
  `~/.imp/guardian2.json`, run live probes, observe. Archive v1's log (rename
  it away before any rename of v2 to avoid collisions).
- **P3 deletion batch** (after P2 observation): on `main` — delete
  `examples/extensions/guardian.mjs`, `test/guardian.test.ts`,
  `test/guardian-auto.test.ts`, `test/guardian-auto-host.test.ts`,
  `test/classify-seam.test.ts`, `src/repl/classify.ts` and the seam plumbing
  (`types.ts`, `loader.ts`, `registry.ts`, `cli.ts`, `runner.ts`, `repl.ts`,
  `call-context.ts`, `user-input-log.ts` + `test/user-input-log.test.ts`);
  remove the now-unset `verifiedUserContext` field (types/runner/docs) or
  keep it deliberately. Adapt `test/extensions-repl.test.ts` (it loads the
  v1 example). Add the SUPERSEDED banner to
  `docs/guardian-auto-mode-design.md`; update the `ExtensionApi` member-count
  docstring, `docs/m4-extensions-design.md`, `docs/confirm-prompt-design.md`
  (v1 call sites / sessionKey references), `PROJECT_PLAN.md` references,
  README / CHANGELOG. Note: v1's `guardian.template.json` exists only on the
  branch being deleted — no main-repo action. The branch
  `design/extension-model-access` also carries the unmerged model-access
  feature (not only guardian v1); discarding it is part of this reset
  (explicit owner sign-off when P3 runs). The `imp` worktree is checked out
  on that branch: switch it off, archive-tag the branch, then delete it.
  Remove the machine's v1 files (`~/.imp/extensions/guardian.mjs`,
  `~/.imp/guardian.json`; archive `guardian.log`). Apply the rename decision
  (§9 Q2).
- **P4 cleanup**: leftover merged branches
  (`docs/acceptance-guardian-input`, `docs/ledger-guardian-*` …), leftover
  worktrees.

## 7. Tests (P1, red-first)

1. Load: missing file (zero rules, gate lets everything through); valid file
   (string and object entries, flags); invalid JSON; unknown top-level key;
   bad entry type; invalid regex; `g`/`y` flags rejected; reload recovers.
2. Deny: first matching rule blocks; no confirm call; reason text (custom and
   default).
3. Ask: confirm called with the reason; approved → runs; declined → blocks;
   string-shorthand rule works.
4. Pass: unmatched commands never confirm; non-bash tools pass untouched;
   non-string `command` passes; a quoted-text match (`git commit -m "… rm -rf
   …"`) **matches** (documents the raw-string limit, §1).
5. Precedence: a command matching both deny and ask blocks (deny wins).
6. Child / headless: audit child marker; headless ask becomes a block,
   audited `denied`.
7. Audit formats byte-exact (incl. the 160-char cap and newline flattening);
   load-error line; footer status set/cleared.
8. Template patterns: pin the doc's cases (`rm -fr ~`, `rm -r -f $HOME/x`,
   `git push -f`, `git push --force-with-lease` miss) plus a plain
   `rm -rf /tmp/x` miss.
9. Commands: `status` counts; `reload` picks up an edited file.
10. Static pin: no `classify` / `complete` / `snapshot` / `api.note` use.

## 8. Claude Code reference (considered with a minimal lens)

The rule-layer shape here already mirrors the good parts of CC's permission
rules: two lists (`deny` / `ask`) with deny-before-ask precedence, regex /
wildcard matching of commands, per-tool scoping, explicit validation.
Considered and **not** borrowed for v0:

- `Bash(prefix:*)` sugar (`src/utils/permissions/shellRuleMatching.ts`) —
  regex covers prefixes; one syntax, not two.
- compound-command splitting (`src/tools/BashTool/bashPermissions.ts`) — a
  quote-aware splitter is the complexity v0 avoids; whole-string regex
  matching errs toward over-matching, the safe direction for deny/ask rules.
- env-var / wrapper stripping before matching — only matters for anchored
  patterns; unanchored user regexes do not need it.
- skipping invalid rules with a warning (CC) — we fail the whole load and
  keep the last valid set; louder, simpler to reason about.
- session "always allow" write-back and prompt suggestions — deferred (§9
  Q4). Note `ConfirmOptions.sessionKey` already exists if this is wanted.

Other CC files for reference: `src/utils/permissions/permissions.ts`,
`src/utils/permissions/permissionRuleParser.ts`,
`src/utils/settings/types.ts`, `src/utils/settings/permissionValidation.ts`.

## 9. Open questions (owner)

1. First-run invalid config: flag-only (proposed, with the trade-off stated
   in §5) vs fail-closed until fixed (v1's old posture).
2. Rename bundle at P3: extension filename, slash command, config / log
   names, status key, archived-log naming — one decision for all, or keep
   `guardian2` everywhere.
3. Pass-through calls stay unaudited (proposed; minimal log volume) — keep?
4. Session memory for asks stays out of v0 (`ConfirmOptions.sessionKey` is
   available if wanted later).

## 10. Review log

- rev 2.1 — folds the completed adversarial review (R1) of rev 2: posture
  wording and the first-run trade-off (§5), audit pinning — cap value, child
  marker, headless token, newline flattening (§4), `g`/`y` flag rejection
  (§2), corrected template patterns (§2), merge mechanics and `imp-main`
  worktree (§6 P1), explicit model-access discard (§6 P3), test additions
  (§7), install details (§6 P2), doc-sweep additions (§6 P3). The R1
  reviewer's headless-token suggestion is adapted: the confirm contract
  cannot distinguish headless from a decline, so the audited token remains
  `denied` (documented).
- rev 2 — minimal redesign per owner direction; rev 0/1 (port-based) and
  the earlier approach documents are discarded as design input.
- Owner decisions: pending (§9).
- R2 (review of this revision): pending.
