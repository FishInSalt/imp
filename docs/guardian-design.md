# guardian — a minimal config-driven permission gate (design)

Status: **rev 3.0 — the ask picker red-highlights the rule-matched span.**
Renamed to `guardian` (rev 2.9); merged to `main` (`5fb3a24` v0, `bce6df2`
friendly config), cut over on 2026-10-04 (P2), guardian v1 removed (P3/P4,
`chore/remove-guardian-v1`), and the working name guardian2 retired —
files, command, config/audit paths, and this document are `guardian` now.
Owner direction: wildcard patterns by default with a `regex` escape hatch;
optional `tool` scoping for `write` / `edit` paths; `reason` stays optional
(the template demonstrates both forms).

- Worktree / branch: `imp-guardian2` / `feat/guardian2-friendly-config`,
  base `main` (5fb3a24 — guardian v0 merged).
- Replaces guardian v1 (modes + classifier). v1 was deleted after cutover
  (phase P3, §6); v1's design record stays at
  `docs/guardian-auto-mode-design.md` with a superseded banner.

## 0. The model (owner direction)

1. The user writes two rule lists in `~/.imp/guardian.json`: **deny** and
   **ask**. Patterns are plain text where `*` matches anything (a match is
   "the text appears"); a `regex` entry is the escape hatch for full regular
   expressions.
2. A `bash` command matching a `deny` rule is blocked. Matching an `ask`
   rule prompts the human: approved runs, declined blocks. Rules may target
   `write` / `edit` instead, matching the target file's resolved path.
3. A command matching neither runs — **the default is allow**.
4. No modes, no model calls, no host changes.

## 1. Scope and non-goals

In scope:

- `bash` tool calls: patterns match the raw command string; wildcard by
  default, `regex` opt-in.
- `write` / `edit` tool calls: patterns match the **resolved absolute path**
  of the target file; rules opt in with `"tool"`.
- `deny` / `ask` handling; deny evaluated before ask.
- A minimal audit log; `/guardian status | reload`.
- A shipped template (`examples/extensions/guardian.template.json`).

Deliberately out of scope (add only if a real need appears):

- file **content** inspection (path patterns only; no size/type checks);
- `read` or other tools; rule ids; structured predicates (`protectedPaths`,
  `outsideCwd`, `rm` parsing, quote / heredoc masking);
- per-pattern session memory ("don't ask again for this command") — the only
  memory is one session-wide "stop asking" option on the ask prompt (§3);
- config file watching; project-level config; `init` / `explain` commands.

Known limits, documented and accepted:

- matching sees the raw command string **including quoted text**: a command
  like `git commit -m "fix rm -rf handling"` can match an `rm -rf` pattern.
  This is a heuristic gate, not an enforcement boundary; it errs toward
  over-matching (the safe direction) rather than masking regions.
- `*` is the only wildcard; a literal `*` cannot be expressed in a wildcard
  entry (use a `regex` entry if that ever matters).
- file-path matching is lexical (`path.resolve`, no realpath) and
  case-sensitive: a symlinked path can bypass a path rule, and a case
  variant can miss one on a case-insensitive filesystem (a `regex` entry
  with the `i` flag is the escape hatch).
- user patterns are trusted config. A pathological `regex` can stall the
  synchronous match path — accepted (ReDoS); the input is **not** capped,
  because a cap would silently pass everything beyond it, including deny
  matches.
- a broken config disarms the gate until fixed; the footer shows
  `config error` (§5).

## 2. Config: `~/.imp/guardian.json`

```jsonc
{
  "_comment": "keys starting with _ are ignored",
  "deny": [
    "rm * ~"                                   // wildcard: rm -rf ~, rm -fr ~, …
  ],
  "ask": [
    "sudo",                                    // plain text: appears anywhere
    { "regex": "git\\s+push\\b[^\\n]*(-f\\b|--force(?!-with-lease))" },
    { "tool": ["write", "edit"], "pattern": "/etc/" }
  ]
}
```

Schema and validation (strict, checked at load):

- Top level must be a JSON object; allowed keys: `deny`, `ask`, and `_…`
  prefixed. Unknown keys are errors (catches typos such as `deni`).
- `deny` / `ask` are arrays; missing arrays are empty.
- An entry is either a string (a wildcard pattern) or an object with:
  - exactly one of `pattern` (wildcard) or `regex` (raw regular expression);
  - `flags` (optional, string) — `regex` entries only; must not contain `g`
    or `y` (stateful `lastIndex` would make `test()` alternate between
    calls);
  - `reason` (optional, string) — shown when blocking or asking;
  - `tool` (optional) — one of `bash` / `write` / `edit`, or an array of
    them; absent ⇒ `bash`.
- Wildcard semantics: the pattern is escaped to literal text, `*` becomes
  "any run of characters" spanning newlines — matched with a linear segment
  matcher, so wildcard patterns cannot backtrack — and a match is "the text
  appears anywhere" (unanchored, case-sensitive). Wildcard patterns cannot
  fail compilation; empty / whitespace patterns are rejected.
- An empty `regex` (`""`) is rejected like an empty pattern (an empty
  regex matches everything); `tool` must name at least one tool (an empty
  array is an error).
- Breaking change vs v0 (never deployed): string entries are wildcard
  patterns now; a v0 regex string must move to a `regex` entry.
- Every `regex` is compiled at load; any failure fails the whole load (§5).
- Missing file = zero rules = the gate does nothing.

## 3. Behavior

`tool_call` handler for `bash` / `write` / `edit` (other tools pass through
untouched):

1. Compute the match text: `bash` → the command string (non-string ⇒ pass);
   `write` / `edit` → the resolved absolute path (`path.resolve` against the
   caller cwd: `event.cwd ?? api.cwd`; non-string `path` ⇒ pass).
2. No rules whose `tool` covers this call → pass.
3. First `deny` rule that matches → block: return
   `{block: true, reason: <reason> or "blocked by guardian rule: <source>"}`.
   Audit.
4. First `ask` rule that matches → confirm:
   - `bash`: message `"allow this bash command?"`; detail `<reason or
     "guardian ask rule: <source>">`; options `{ sessionKey:
     "guardian:session", rememberLabel: "all guardian ask prompts this
     session", preview: { kind: "command", tool: "bash", text: command,
     warnSpans: [[start, end]] } }` — `warnSpans` is the span the rule
     matched (wildcard: first segment start … last segment end; regex: the
     `exec` match span), which the picker styles with its alert color;
     omitted when empty (an all-`*` pattern).
   - `write` / `edit`: message `"allow this write?"` / `"allow this edit?"`;
     detail `<resolved path>` + (`\n` + `<reason or "guardian ask rule:
     <source>">`); options `{ sessionKey, rememberLabel }` (no preview — the
     preview kind is command-only).
   `false` → block with the reason (or "blocked by guardian — the
   confirmation was declined"). Audit the outcome. The shared session key is
   the only memory: choosing the prompt's remember option once stops every
   further ask prompt for the rest of the session — bash and files alike
   ("allow all this session"); deny rules are unaffected.
5. Otherwise → pass.

- `<source>` in messages and audits is the wildcard pattern or the regex
  source, as written.
- Precedence: **deny before ask**.
- Subagent calls use the same rules; the audit line carries the v1-style
  child marker.
- Headless hosts: `confirm` resolves `false`, so an ask match becomes a
  block; unmatched calls still run. A headless decline is indistinguishable
  from a human decline under the confirm contract — it is audited as
  `denied` (conservative).

## 4. Surfaces

- **Audit** `~/.imp/guardian.log`, one line per deny/ask decision plus load
  errors (pass-through calls are not logged). Whitespace runs in the source
  and the match text are flattened, and both are capped at 160 chars
  including the trailing `…`, so the one-line invariant holds:

  ```
  [deny] <source> — <command or resolved path> — blocked
  [deny] <source> — <command or resolved path> — blocked (child:<agent>)
  [ask] <source> — <command or resolved path> — approved
  [ask] <source> — <command or resolved path> — denied
  [ask] internal error — <command or path> — approved|denied
  [load] config error — <first line of the error>
  ```

  Formats pinned byte-exact in tests; every line carries an ISO-8601
  timestamp prefix (`new Date().toISOString()` + space). `denied` covers
  declines and hosts with no interactive prompt (§3).
- **Footer**: `setStatus("config", "config error")` while the last load
  failed; cleared on a successful load. Nothing else (no rule count, no
  per-call status).
- **Commands**: `/guardian status` (config path, rule counts, error flag) and
  `/guardian reload` (re-read the file; report the outcome).
- The log file is created with mode `0600` (match text may contain
  secrets).

## 5. Failure posture

- Missing file → zero rules; the gate does nothing (a valid, opt-in state).
- Invalid config → keep the last valid rules (if any); audit
  `[load] config error`; footer flag; `/guardian reload` recovers.
- First run with an invalid file → no rules, footer flag, audit line.
  Trade-off (owner-accepted in rev 2.2, §9): a broken config disarms an unconfigured
  gate — the footer shows `config error` while it lasts. The alternative
  (confirm every bash call until fixed) is deliberately not taken: this is an
  opt-in heuristic gate, and v1's ask-everything degraded state was removed
  on purpose.
- An internal error during evaluation → fresh confirmation with **no
  sessionKey** (fail toward asking — evaluation, unlike config loading, has
  unknown state; a session-wide "stop asking" grant must not silently
  auto-approve this fallback). The confirm's detail is the match text
  (command or path), flattened and capped like the audit text; the command
  preview rides along when the match is a bash command; the outcome is
  audited as `[ask] internal error — <command or path> — approved|denied`.

## 6. Phases

- **P0 (now)**: owner review of this doc → independent adversarial review →
  fold → review closed.
- **P1 (this branch)**: implement `examples/extensions/guardian.mjs`
  (target: ~150-350 lines including comments) + `guardian.template.json`;
  `test/guardian.test.ts` (fake-api pattern, like v1's example tests); full
  suite; implementation review per the working agreement. Create an
  `imp-main` worktree (`git worktree add ../imp-main main`) for the merge
  (`--no-ff`) and later main-side edits — `main` currently has no worktree.
- **P2 cutover** (owner-driven): on this machine
  `~/.imp/extensions/guardian.mjs` is a symlink into
  `imp/examples/extensions/guardian.mjs` — remove or repoint it **before**
  installing guardian, so both gates never load at once. Install guardian
  by **copy**, or by a symlink to a stable path outside any branch worktree
  (a symlink into a branch worktree breaks when that branch switches). Write
  `~/.imp/guardian.json`, run live probes, observe. Archive v1's log (rename
  it away before any rename of v2 to avoid collisions).
- **P3 deletion batch** (after P2 observation): on `main` — delete v1's
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

- **P2 — done (2026-10-04)**: v1's symlink removed, guardian installed by
  copy, `~/.imp/guardian.json` written from the template, and probes run
  against the real install — pass-through, deny, ask (bash and file), audit
  all observed. v1's log archived to `guardian.log.v1-archive`.
- **P3/P4 — done (2026-10-04)**: v1's extension, its tests, and the host
  classify seam removed on `chore/remove-guardian-v1` (see its commit);
  `test/extensions-repl.test.ts` ported to an inline asker fixture; README,
  CHANGELOG, m4 and confirm-prompt references updated; the v1 design doc
  kept with a superseded banner; `design/extension-model-access` bundled
  (`design-extension-model-access.bundle`) and deleted; merged guardian
  branches and the `imp-guardian2` / `imp-main` worktrees removed; the main
  repo returned to `main`; `~/.imp/guardian.json` deleted. Independent
  implementation review: APPROVE WITH CORRECTIONS → all folds applied →
  CONFIRMED (re-verify round).

## 7. Tests (P1, red-first)

1. Load: missing file (zero rules, gate lets everything through); valid file
   (string entries, object entries, wildcard by default, `regex` entries
   with non-stateful flags); invalid JSON; unknown top-level key; bad entry
   type; both `pattern` and `regex` given; `flags` on a wildcard entry;
   empty / whitespace patterns rejected; invalid regex; `g`/`y` flags
   rejected; bad `tool` values rejected; one full load-error line pinned
   byte-exact; reload recovers.
2. Deny: first matching rule blocks; no confirm call; reason text (custom and
   default).
3. Ask (bash): confirm called with the reason, the shared `sessionKey` /
   `rememberLabel`, and the command `preview` (all pinned); the preview's
   `warnSpans` carry the matched span (wildcard covered region / regex
   `exec` span; omitted when empty); approved → runs; declined → blocks;
   string-shorthand rule works; `regex` flags work.
4. Wildcard semantics: plain text is literal (`.ssh/` does not match
   `xssh/`; `a.b` does not match `axb`); `*` spans any run of characters
   including newlines (`a*c` matches `a\nb\nc`); `rm * ~` matches
   `rm -rf ~` and `rm -fr ~`; a many-star pattern against a long miss
   completes instantly (linear matcher).
5. Tool scoping: a bash rule never matches `write`/`edit` and vice versa;
   file rules match the resolved absolute path (a relative `args.path`
   resolves against the caller cwd — an `event.cwd` different from
   `api.cwd` wins); `tool` arrays cover both file tools.
6. Files: a denied write/edit blocks with the rule reason; an ask write/edit
   prompts with the path in the detail and no preview; declined → blocks;
   audit carries the resolved path as the match text.
7. Pass: unmatched calls never confirm; other tools pass untouched;
   non-string `command` / `path` passes; a quoted-text match (`git commit -m
   "… rm -rf …"`) **matches** (documents the raw-string limit, §1).
8. Precedence: a call matching both deny and ask blocks (deny wins).
9. Child / headless: audit child marker; headless ask becomes a block,
   audited `denied`.
10. Internal error: the fallback confirm is keyless, carries the match text
    as its detail, and (for bash) the preview; the file variant carries the
    path as detail and no preview; the outcome is audited
    (`[ask] internal error — …`).
11. Audit formats byte-exact (incl. the 160-char cap including the ellipsis,
    whitespace flattening, and the ISO timestamp prefix); footer status
    set/cleared.
12. Template: pins the shipped cases (see the template test).
13. Commands: `status` counts; `reload` picks up an edited file.
14. Static pin: no `classify` / `complete` / `snapshot` / `api.note` use.

## 8. Claude Code reference (considered with a minimal lens)

The rule-layer shape here mirrors the good parts of CC's permission rules:
two lists (`deny` / `ask`) with deny-before-ask precedence, wildcard patterns
(`*`) over commands and file paths, per-tool scoping, explicit validation.
Considered and **not** borrowed:

- CC's `exact / prefix(:*) / wildcard` triad
  (`src/utils/permissions/shellRuleMatching.ts`) — one wildcard syntax plus
  an optional `regex` entry instead of three forms.
- compound-command splitting (`src/tools/BashTool/bashPermissions.ts`) — a
  quote-aware splitter is the complexity v0 avoids; whole-string matching
  errs toward over-matching, the safe direction for deny/ask rules.
- env-var / wrapper stripping before matching — only matters for anchored
  patterns; unanchored user patterns do not need it.
- skipping invalid rules with a warning (CC) — we fail the whole load and
  keep the last valid set; louder, simpler to reason about.
- session "always allow" write-back and prompt suggestions — not borrowed;
  the v0 answer is one session-wide "stop asking" option (§3).

Other CC files for reference: `src/utils/permissions/permissions.ts`,
`src/utils/permissions/permissionRuleParser.ts`,
`src/utils/settings/types.ts`, `src/utils/settings/permissionValidation.ts`.

## 9. Owner decisions (settled)

1. First-run invalid config: flag-only accepted — no rules + footer flag;
   the trade-off is stated in §5.
2. Rename: applied 2026-10-04 — the working name `guardian2` → `guardian`
   (files, command, config/audit paths, this document).
3. Pass-through calls stay unaudited (deny/ask decisions are logged).
4. Session memory: no per-pattern memory; a single session-wide "stop
   asking" option rides every ask prompt (§3).
5. Config ergonomics and file scope (rev 2.5): wildcard patterns by default
   (`*`), `regex` as the escape hatch; `reason` optional (the template shows
   both forms); optional `tool` scoping for `write` / `edit` path rules.

## 10. Review log

- rev 3.0 — matched-span highlight: the bash ask preview carries
  `warnSpans` = `[[start, end]]` of the region the rule matched (wildcard:
  first segment start … last segment end; regex: the `exec` span; empty
  spans omitted). The picker styles it with the alert color (bold red); the
  deny path has no display surface for spans (no prompt, no preview). Tests
  pin the covered region, a leading `*`, a regex span, middle segments, and
  the empty-span omission.

- rev 2.9 — renamed to `guardian` (2026-10-04): the extension file,
  template, test file, this document, the `/guardian` command,
  `~/.imp/guardian.json` / `~/.imp/guardian.log`, and every user-facing
  string.

- rev 2.8 — shipped: v0 merged (`5fb3a24`), friendly config merged
  (`bce6df2`), P2 cutover done 2026-10-04 (probes green, v1's log archived),
  P3/P4 removal landed (`chore/remove-guardian-v1`). Independent
  implementation review of the removal: APPROVE WITH CORRECTIONS (README
  dangling reference; `temperature` / `workOrder` leftovers) → all folds
  applied → CONFIRMED (re-verify round).

- rev 2.7 — R5 folds: wildcard matching is a linear segment matcher now
  (no catastrophic backtracking; the `regex` escape hatch keeps the accepted
  ReDoS risk); the write/edit base directory is type-guarded; the audit caps
  source and match text (spec aligned); the fallback-detail wording aligned;
  tests added (vice-versa tool scoping, file fallback, template `sudo` /
  `--force`, a many-star pattern); size target adjusted. Verification
  CONFIRMED.
- rev 2.6 — R4 folds: `*` spans newlines; the template regains
  the `$HOME` / `${HOME}` deny variants; a worktree-cwd test; known limits
  for lexical, case-sensitive path matching; validation edges (empty
  `regex`, empty `tool`); the file internal-error fallback detail; the audit
  timestamp sentence; a breaking-change note vs the unreleased v0 (string
  entries are wildcards now — v0 regex strings must move to `regex`).
  Design-delta review closed.
- rev 2.5 — owner direction: friendlier config (wildcard patterns by
  default with a `regex` escape hatch; `reason` optional) and `write` /
  `edit` path rules via an optional `tool` field. Design-delta review
  pending (R4); v0 rounds R1–R3 remain as folded below.
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
