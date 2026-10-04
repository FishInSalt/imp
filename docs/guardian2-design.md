# guardian2 — a minimal config-driven permission gate (design)

Status: **rev 2.4 — implementation-review findings folded.** Owner
direction: minimal implementation; the port-based revisions are discarded
as design input. Owner decisions are settled (§9); the design review is
closed (R1/R2, rev 2.3); the implementation review (R3) is folded in
rev 2.4 and in the code.

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
- per-pattern session memory ("don't ask again for this command") — the only
  memory in v0 is one session-wide "stop asking" option on the ask prompt
  (§3);
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
3. First `ask` rule whose regex matches → `confirm("allow this bash
   command?", <reason>, { sessionKey: "guardian2:session", rememberLabel:
   "all guardian2 ask prompts this session", preview: { kind: "command",
   tool: "bash", text: command } })`; `false` → block with the reason (or
   "blocked by guardian2 — the confirmation was declined"). Audit the outcome. The shared session key is
   v0's only memory: choosing the prompt's remember option once stops every
   further ask prompt for the rest of the session ("allow all this
   session"); deny rules are unaffected. The `preview` shows the command in
   the confirm picker — the human must see what they are approving.
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
  errors (pass-through calls are not logged). Whitespace runs in the pattern
  and command are flattened so the one-line invariant holds; the command is
  capped at 160 chars including the trailing `…`:

  ```
  [deny] <pattern> — <command> — blocked
  [deny] <pattern> — <command> — blocked (child:<agent>)
  [ask] <pattern> — <command> — approved
  [ask] <pattern> — <command> — denied
  [ask] internal error — <command> — approved|denied
  [load] config error — <first line of the error>
  ```

  Formats pinned byte-exact in tests. `denied` covers declines and hosts
  with no interactive prompt (§3).
- **Footer**: `setStatus("config", "config error")` while the last load
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
  Trade-off (owner-accepted in rev 2.2, §9): a broken config disarms an unconfigured
  gate — the footer shows `config error` while it lasts. The alternative
  (confirm every bash call until fixed) is deliberately not taken: this is an
  opt-in heuristic gate, and v1's ask-everything degraded state was removed
  on purpose.
- An internal error during evaluation → fresh confirmation with **no
  sessionKey** (fail toward asking — evaluation, unlike config loading, has
  unknown state; a session-wide "stop asking" grant must not silently
  auto-approve this fallback). It carries the command preview when the
  command is known, and the outcome is audited as
  `[ask] internal error — <command> — approved|denied`.

## 6. Phases

- **P0 (now)**: owner review of this doc → independent adversarial review →
  fold → review closed.
- **P1 (this branch)**: implement `examples/extensions/guardian2.mjs`
  (target: ~150-250 lines including comments) + `guardian2.template.json`;
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
  `~/.imp/guardian.json`; archive `guardian.log`). Rename is deferred until
  after this deletion batch (owner, §9); revisit then.
- **P4 cleanup**: leftover merged branches
  (`docs/acceptance-guardian-input`, `docs/ledger-guardian-*` …), leftover
  worktrees.

## 7. Tests (P1, red-first)

1. Load: missing file (zero rules, gate lets everything through); valid file
   (string and object entries, non-stateful flags accepted); invalid JSON;
   unknown top-level key; bad entry type; invalid regex; empty / whitespace
   patterns rejected; `g`/`y` flags rejected; one full load-error line
   pinned byte-exact; reload recovers.
2. Deny: first matching rule blocks; no confirm call; reason text (custom and
   default).
3. Ask: confirm called with the reason, the shared `sessionKey` /
   `rememberLabel`, and the command `preview` (all pinned); approved → runs;
   declined → blocks; string-shorthand rule works; non-stateful flags work.
4. Pass: unmatched commands never confirm; non-bash tools pass untouched;
   non-string `command` passes; a quoted-text match (`git commit -m "… rm -rf
   …"`) **matches** (documents the raw-string limit, §1).
5. Precedence: a command matching both deny and ask blocks (deny wins).
6. Child / headless: audit child marker; headless ask becomes a block,
   audited `denied`.
7. Internal error: the fallback confirm is keyless and carries the preview;
   the outcome is audited (`[ask] internal error — …`).
8. Audit formats byte-exact (incl. the 160-char cap including the ellipsis,
   whitespace flattening, and the ISO timestamp prefix); footer status
   set/cleared.
9. Template patterns: pin the doc's cases (`rm -fr ~`, `rm -r -f $HOME/x`,
   `git push -f`, `git push --force-with-lease` miss) plus a plain
   `rm -rf /tmp/x` miss.
10. Commands: `status` counts; `reload` picks up an edited file.
11. Static pin: no `classify` / `complete` / `snapshot` / `api.note` use.

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
- session "always allow" write-back and prompt suggestions — not borrowed;
  the v0 answer is one session-wide "stop asking" option (§3).

Other CC files for reference: `src/utils/permissions/permissions.ts`,
`src/utils/permissions/permissionRuleParser.ts`,
`src/utils/settings/types.ts`, `src/utils/settings/permissionValidation.ts`.

## 9. Owner decisions (rev 2.2, settled)

1. First-run invalid config: flag-only accepted — no rules + footer flag;
   the trade-off is stated in §5.
2. Rename: keep `guardian2` for now; revisit only after the v1 deletion
   batch (P3) has landed.
3. Pass-through calls stay unaudited (deny/ask decisions are logged).
4. Session memory: no per-pattern memory; a single session-wide "stop
   asking" option rides every ask prompt (§3).

## 10. Review log

- rev 0 / rev 1 (port-based) and the earlier approach documents are
  discarded as design input (owner direction, rev 2).
- rev 2 — minimal redesign: no modes, no judge; two regex lists (deny /
  ask), default allow.
- rev 2.1 — folds the completed adversarial review (R1) of rev 2: posture
  wording and the first-run trade-off (§5), audit pinning — cap value, child
  marker, headless token, newline flattening (§4), `g`/`y` flag rejection
  (§2), corrected template patterns (§2), merge mechanics and `imp-main`
  worktree (§6 P1), explicit model-access discard (§6 P3), test additions
  (§7), install details (§6 P2), doc-sweep additions (§6 P3). The R1
  reviewer's headless-token suggestion was adapted: the confirm contract
  cannot distinguish headless from a decline, so the audited token remains
  `denied` (documented).
- rev 2.2 — owner answers folded: first-run posture accepted; rename
  deferred until after P3; pass-through stays unaudited; the session-wide
  "stop asking" option added to ask prompts (shared sessionKey /
  rememberLabel).
- rev 2.3 — R2 notes folded: the ask confirm carries the command `preview`
  (the human must see what they approve); the internal-error fallback
  confirm is keyless (a session-wide grant must not auto-approve it).
  Design review closed.
- rev 2.4 — implementation-review (R3) findings folded: empty/whitespace
  patterns rejected (a match-everything rule cannot be armed); the
  internal-error fallback carries the command preview and an audit line;
  audit wording/cap/flattening clarified (single-space `[ask]`, 160 chars
  including the ellipsis, whitespace-run flattening, the `setStatus("config",
  …)` key); the test suite extended (flags accepted, empty patterns, one
  full load-error line, ISO timestamp prefix, fallback flow).
- Owner decisions: settled (§9).
- R2 (design verification): CONFIRMED WITH NOTES — folded in rev 2.3.
- R3 (implementation review, commit `77f9e20`): 1 P1 + 4 P2 + 7 P3 — folded
  in rev 2.4 and the follow-up fix commit; `examples/**` is outside biome's
  includes (pre-existing convention, noted only).
