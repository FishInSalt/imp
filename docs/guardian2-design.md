# guardian2 — a config-driven permission gate (design)

Status: **rev 0** — owner decisions proposed below; owner review and an
independent adversarial design review are pending. No implementation before
both close.

- Worktree / branch: `imp-guardian2` / `design/guardian2`, base `main` (846b263).
- Port sources: the unmerged `design/extension-model-access` branch —
  `examples/extensions/guardian.mjs` (2093 lines: predicate engine, detector,
  config validation; already through several review rounds) and its
  `guardian.template.json`; detector analysis in
  `docs/guardian-auto-mode-design.md` §13–§17 (on `main`).
- Replaces: guardian v1 (`main`: modes `manual | shadow | auto` + the host
  classifier seam `api.classify` / `src/repl/classify.ts`). v1 is deleted only
  after cutover (phase P3, §9).

## 0. Owner decisions (proposed — to be locked by the owner)

| # | Decision | Proposal |
|---|---|---|
| D1 | Replacement | guardian2 replaces guardian v1 for the same scope: a gate on `bash` / `write` / `edit` tool calls. The two extensions are never loaded at the same time; v1 is deleted only after cutover (§9 P3). |
| D2 | No modes | No `manual` / `shadow` / `auto`; no model calls (`api.complete` / `api.classify` unused); no breaker. The gate is deterministic and config-driven. |
| D3 | Handling set | Every rule carries `action: "allow" \| "ask" \| "deny"`. Unmatched calls pass through — guardian2 is an opt-in gate, the same intervention surface as v1. |
| D4 | Engine | Port the reviewed predicate engine (regex predicates + `rm` / `protected` / `outsideCwd` / `path` facts + `protectedPaths`), `tier` → `action`. Claude Code's `Bash(prefix:*)` string syntax is out of scope (§10). |
| D5 | Precedence | **Owner choice.** S1 (proposed): `deny > ask > allow` (CC-consistent). S2: `deny > allow > ask` (allow as an explicit exception to broad ask rules). See §4.2. |
| D6 | `allow` boundary | An allow match on an *unresolvable* command (expansion / glob / indirect execution) or an *over-cap* command (> 64 KiB) does not run unattended — it degrades to a fresh confirmation (no session memory). |
| D7 | `ask` memory | `ask` keeps the host's session memory (`sessionKey`, "this pattern this session"). `deny` never prompts and has no memory; `allow` never prompts. |
| D8 | Invalid config | Keep the **last valid** rule set; suspend allow actions (an allow match behaves as a fresh, memory-less ask); one loud diagnostic + footer flag; `/guardian2 reload` recovers. Before any valid load: zero rules, flag only. v1's blanket ask-everything fallback is not carried (its mode machinery is gone). |
| D9 | Surfaces | Config `~/.imp/guardian2.json`; audit `~/.imp/guardian2.log`; command `/guardian2 init \| status \| reload \| explain`; footer status only for the degraded flag. |
| D10 | Naming | Working names `guardian2.mjs` / `guardian2.template.json` / `/guardian2` / `guardian2.json`. Whether the shipped name reverts to `guardian` after v1's deletion is decided at cutover. |
| D11 | Diagnostics channel | `main`'s extension API has no `api.note` (it exists only on the unmerged branch). guardian2 requires no host change: diagnostics ride the footer (`setStatus`), the audit file, confirm details, and command output. |
| D12 | Host changes | None. guardian2 uses only `main`'s API: `on("tool_call" / "tool_end")`, `confirm`, `setStatus`, `registerCommand`. |
| D13 | Non-goals | Modes / classifier; project-level config; sandbox or enforcement claims; `Bash(prefix:*)` syntax; auto-allow by any model; file backups / trash. |

## 1. Context

v1 inserts a model judgment between the rule match and the human (shadow /
auto modes) and pays for it with: a host seam, judge-input assembly, a record
renderer, a breaker, and a degraded state that asks on every call. The owner
direction is to drop the model entirely and let the human classify commands
into three handling kinds — `allow` / `ask` / `deny` — where `deny` and `ask`
map onto v1's reviewed `hard` / `soft` tiers and `allow` is new.

guardian2 is an example extension (`examples/extensions/guardian2.mjs`). It
watches `bash` / `write` / `edit` tool calls, matches them against
`~/.imp/guardian2.json`, and either blocks (deny), confirms (ask), runs
(allow), or passes the call through untouched (no match). A block is not a
crash: the model receives a teaching-style reason as its tool result and the
run continues. Every gate decision appends one audit line.

Design invariants carried from v1's reviews:

- the detector is shape-based, not an enforcement boundary;
- a target that cannot be statically resolved is never auto-approved (D6
  applies that posture to `allow`);
- regex work runs against capped inputs; an over-cap command is treated as
  unresolvable, never silently resolved;
- regexes come from the user's own config; ReDoS is an accepted, documented
  risk.

## 2. Config: `~/.imp/guardian2.json`

```jsonc
{
  "_comment": "keys starting with _ are ignored",
  "version": 2,                            // optional; if present must be 2
  "protectedPaths": ["/etc", "~/.ssh", "~/.gnupg"],
  "rules": [
    {
      "id": "no-rm-protected",             // required, unique, stable
      "action": "deny",                    // required: allow | ask | deny
      "tool": "bash",                      // required: bash | write | edit | "*" | array
      "match": { "rmTarget": { "protected": true } },   // required, non-empty
      "reason": "…"                        // optional (default "")
    },
    {
      "id": "ask-sudo",
      "action": "ask",
      "tool": "bash",
      "match": { "command": "(?:^|[\\s;&|])sudo\\b" },
      "reason": "running as root — do it as the normal user, or hand the privileged step to the human"
    }
  ]
}
```

Validation (deltas from the v1 branch schema):

- `tier` is rejected with a targeted message: *"tier is the v1 schema; map
  hard → deny, soft → ask, or start from the new template (`/guardian2
  init`)"*.
- `mode` / `judge` are rejected as unknown keys (v2 has no modes).
- Everything else is carried from v1: unknown keys (except top-level `_…`)
  are errors; `protectedPaths` entries must be absolute after `~` / `$HOME` /
  `${HOME}` expansion; rule `id` non-empty and unique; `tool` selection and
  the predicate/tool matrix are validated (no silently dead rules); a rule
  using `protected` / `rmTarget.protected` without a non-empty
  `protectedPaths` is an error; `match` must be non-empty; regexes compile or
  the whole load fails (degraded per D8).
- Missing file: valid zero-rule defaults + one diagnostic
  (`no rules configured — /guardian2 init`), same as v1.

## 3. Matching engine (ported from the reviewed v1 engine)

Mechanism facts, per call (not configurable):

- **Input cap**: matching runs against `MATCH_INPUT_MAX_CHARS = 64 * 1024`;
  over-cap commands carry an `overCap` flag (feeds D6).
- **bash**: `raw` (original), `code` (quote / heredoc-masked rendering;
  shell-consumed heredoc bodies stay visible), `unresolvable` (expansion /
  glob / indirect execution), and every `rm` invocation
  (`{recursive, force, splitSpelling, targets}` with quote-stripped,
  home-expanded, cwd-resolved targets).
- **write / edit**: `resolved` absolute path (caller cwd, worktree-aware).
- **all**: `protected` (resolved path / rm target under a `protectedPaths`
  entry) and `homeRoot` (an rm target resolving to the home directory
  itself).

Predicates (all present must hold; `tool` selects which calls a rule sees):

| predicate | applies to | tests |
|---|---|---|
| `command` | bash | regex against `code` |
| `commandRaw` | bash | regex against `raw` |
| `rm` | bash | `{recursive?, force?}` — one invocation must satisfy all given fields |
| `rmTarget` | bash | `{homeRoot?, protected?, regex?}` — one target must satisfy all given fields |
| `unresolvable` | bash | the mechanism flag |
| `path` | write, edit | regex against `resolved` |
| `protected` | bash (rm targets), write, edit | resolved target under a `protectedPaths` entry |
| `outsideCwd` | write, edit | resolved path outside the caller's cwd |

Port as-is (copy; no behavior change): `quotedRegions`, `segmentEnd`,
`quoteSpans`, `maskSpans`, `codeImage`, `splitSegments`, `tokenizeSegment`,
`expandHome`, `underPath`, `parseRmInvocations`, the heredoc scanner
(`delimiterAt`, `heredocBody`, `parseHeredocs`), `hitsOutside`, `allMatches`,
`execFirst`, `regionFromSpans`, `analyzeBash`, `analyzePath`, `compileRegex`,
`validateRule` (minus `tier`), the match helpers
(`rmInvocationSatisfies`, `rmTargetSatisfies`, `matchesBash`, `matchesPath`,
`ruleSpan`, `matchedRules`), `audit`, `firstLine`, `plainObject`.

Drop (v1's judge / mode machinery): the judge materials and renderer
(`OUTPUT_CONTRACT`, `RECORD_*`, `renderHumanRecord`, `layoutRecord`,
`renderWorkOrder`, `elideWithin`, `parseVerdict`, `JUDGE_SYSTEM`,
`CALL_LEAD`, `QUESTION`, `payloadFence`), `assembleJudgeInput`,
`judgeCall`, `shadowFlow`, the breaker, the mode state and `MODES`, the
judge config keys, `cleanLine` / `sanitizeDisplay` / `escapeControls` (judge
display only), judge / mode counters, and the legacy `{"auto": …}`
translation.

## 4. Gate flow

Per call:

1. Compute facts (§3). A call whose tool is not `bash` / `write` / `edit`,
   or whose args lack the expected fields, passes through.
2. Evaluate every rule (tool-selected, predicates AND-ed) → matches, each
   `{rule, span?, }`; partition by `action` in config order.
3. **deny** non-empty → block; audit; return the teaching reason with
   `[rule: <id>]`. No confirm, no memory. (Primary = first deny in config
   order; all matched ids are visible in `explain`.)
4. **degraded** (D8) → the allow group is suspended: its matches enter the
   ask flow below as fresh asks (no `sessionKey`).
5. **ask** non-empty (suspended allow included) → confirm with the rule
   reason + command preview + `sessionKey` (D7). Approved → run. Declined →
   block with the rule's reason. (The host records gate decisions; no
   extension bookkeeping.)
6. **allow** non-empty (not suspended) → boundary check (D6): if
   `unresolvable` or `overCap` → fresh confirm (no memory) with the
   "held back" note; approved → run, declined → block with the rule's
   reason. Otherwise run; audit.
7. No matches → pass through; no confirm, no audit, no counter change.

Subagent calls use the same rules; audit subjects carry the v1 child marker.
Headless hosts: `confirm` resolves false, so ask / deny / held-back allow
become blocks; a clean allow match still runs.

### 4.2 Precedence (D5 — owner choice)

- **S1 (proposed) — `deny > ask > allow`.** A call matching both an ask and
  an allow rule asks. This matches Claude Code's ordering
  (`bashToolCheckPermission` checks deny, then ask, then allow) and keeps ask
  rules absolute. Under an opt-in gate, `allow` then equals "explicitly
  marked approved": never looser than no-match, visible in audit / explain,
  and the hook for the D6 boundary.
- **S2 — `deny > allow > ask`.** An allow match overrides any ask match:
  broad ask patterns get specific carve-outs (`ask: rm -rf …` + `allow:
  rm -rf ./build/`). More expressive; diverges from CC; a sloppy allow regex
  can silently defeat an ask guard (the config author's responsibility).

### 4.3 The `allow` boundary, concretely

- `rm -rf ./build` with an allow rule on it → resolvable → runs unattended.
- `rm -rf $DIR` matching the same allow rule → expansion ⇒ `unresolvable` →
  fresh confirmation, audit notes "held back: unresolvable".
- A > 64 KiB command matching an allow rule → fresh confirmation, "held
  back: over-cap".

An unmatched command with expansions still passes through (guardian2 is
opt-in — it does not gate what it was not configured to gate). This asymmetry
is deliberate and documented.

## 5. Template mapping

The shipped template starts from v1's reviewed rule set, re-bucketed; it
stays conservative (no allow rules by default — `allow` demonstrates in the
`_comment` and in the docs; the owner adds their own):

| v1 template rule | v2 action |
|---|---|
| `no-rm-home` (hard) | `deny` |
| `no-rm-protected` (hard) | `deny` |
| `no-write-protected` (hard) | `deny` |
| `ask-rm-force-recursive` (soft) | `ask` |
| `ask-force-push` (soft) | `ask` |
| `ask-fork-bomb` (soft) | `ask` |
| `ask-curl-sh` (soft) | `ask` |
| `ask-sudo` (soft) | `ask` |
| `ask-outside-writes` (soft) | `ask` |

## 6. Failure posture (D8)

- Invalid config at load / reload → `degraded = true`: the last valid rule
  set stays active; allow actions are suspended (allow → fresh ask); one
  diagnostic and a footer flag; `/guardian2 reload` recovers.
- First run with an invalid file (no last valid): zero rules; diagnostic and
  footer flag; nothing is gated until a valid load.
- A v1-shaped file fails validation with the targeted message (§2) — never a
  silent partial load.
- The gate handler never throws: an internal error falls back to a fresh
  confirmation (v1 behavior).

## 7. Surfaces

- `/guardian2 [status | reload | init | explain <command> | write <path> |
  edit <path>]`.
- `explain` prints one line per matched rule
  (`<id> <action> <tool> [span]`) + a verdict line: `→ deny` / `→ ask` /
  `→ allow` / `→ no match` / `→ fresh confirm (allow held back:
  unresolvable | over-cap)` (+ `degraded` suffix).
- Audit formats (drafts; pinned byte-exact in P1):

  ```
  [deny] no-rm-protected — rm -rf ~/.ssh — blocked
  [ask] ask-sudo — sudo apt install jq — human: approved
  [ask] ask-force-push — git push --force origin main — human: denied
  [allow] allow-build-clean — rm -rf ./build — run
  [allow] allow-build-clean — rm -rf $DIR — held back: unresolvable — human: approved
  [deny] no-write-protected — write /etc/hosts — blocked (child:review)
  ```

  The v1 `tool_end` error lines (`[bash child:x] Error: …`) are carried.
- `status` counters: matched, denied, asked (approved / denied), allowed,
  allow held back, degraded (config invalid), errors. No mode, no judge, no
  breaker fields.

## 8. Tests and pins (P1, red-first)

1. Load: missing file (zero rules + diagnostic); invalid JSON; v1-shaped
   file (targeted `tier` message); unknown keys; duplicate ids; predicate /
   tool matrix; `protected` without `protectedPaths`; invalid regex.
2. `deny`: blocks without confirm; reason + rule id; v1 floor cases (home
   root, protected targets, split-flag `rm`, quoted `$HOME` spellings).
3. `ask`: `sessionKey` per rule; approve / decline; decline returns the
   rule reason; preview / warnSpan carried; caller-cwd cases.
4. `allow`: runs without confirm; audit line; held back on
   `unresolvable` / over-cap (fresh, no memory).
5. Precedence per the D5 choice, including deny-beats-everything.
6. Pass-through: unmatched calls never confirm (harmless commands, quoted
   text that merely looks dangerous: `git commit -m "fix rm -rf handling"`).
7. Engine pins carried: quote / heredoc masking, rm variants, over-cap
   (> 64 KiB) behavior per action, caller cwd / worktree child.
8. Degraded: last valid kept; allow suspended; reload recovers; first-run
   invalid.
9. Commands: `init` never overwrites; `status` counters; `explain` verdict
   lines.
10. Audit formats byte-exact; child markers.
11. Template validates; reproduces the v1 mapping cases.
12. Static pin: no `complete` / `classify` / snapshot use anywhere in
    guardian2.

## 9. Phases

- **P0 (now)**: this doc → owner review of §0 → independent adversarial
  review → fold → review closed.
- **P1 (this branch)**: implement `examples/extensions/guardian2.mjs` +
  `guardian2.template.json`; `test/guardian2.test.ts` (fake-api pattern like
  v1's tests); full suite; implementation review per the working agreement;
  merge to `main` via `--no-ff`.
- **P2 cutover** (owner-driven): move v1 aside in `~/.imp/extensions/`;
  install guardian2; author `~/.imp/guardian2.json` (start from
  `/guardian2 init`); live probes; observe. v1's log is archived.
- **P3 deletion batch** (after P2 observation): on `main` — delete
  `examples/extensions/guardian.mjs`, `test/guardian.test.ts`,
  `test/guardian-auto.test.ts`, `test/guardian-auto-host.test.ts`,
  `test/classify-seam.test.ts`, `src/repl/classify.ts` and the seam
  plumbing (`types.ts`, `loader.ts`, `registry.ts`, `cli.ts`, `runner.ts`,
  `repl.ts`, `call-context.ts`, `user-input-log.ts`, provider comment),
  add the SUPERSEDED banner to `docs/guardian-auto-mode-design.md`, fix
  member counts in `docs/m4-extensions-design.md`, README / CHANGELOG.
  Archive-tag the unmerged `design/extension-model-access` branch, then
  delete it. Delete the machine's v1 files (`~/.imp/extensions/guardian.mjs`,
  `~/.imp/guardian.json`; archive `guardian.log`). Apply the D10 rename
  decision.
- **P4 cleanup**: leftover merged branches (`docs/acceptance-guardian-input`,
  `docs/ledger-guardian-*` …), leftover worktrees.

## 10. Reference notes (Claude Code, for the rule layer only)

CC keeps its own modes + classifier; the reusable half is the rule engine:

- `restored-src/src/utils/settings/types.ts` — `permissions.{allow,ask,deny}`
  + `defaultMode`.
- `restored-src/src/utils/permissions/permissionRuleParser.ts` — the
  `Tool(content)` rule string.
- `restored-src/src/utils/permissions/shellRuleMatching.ts` — exact /
  prefix (`:*`) / wildcard parsing and matching.
- `restored-src/src/tools/BashTool/bashPermissions.ts` — per-command
  evaluation: deny → ask → allow, compound-command splitting, env-var
  stripping asymmetry.
- `restored-src/src/utils/permissions/permissions.ts` — the pipeline
  (`checkRuleBasedPermissions`, `hasPermissionsToUseToolInner`).
- `restored-src/src/utils/settings/permissionValidation.ts` — invalid-rule
  handling (skip + warn; guardian2 instead fails the whole load, D8).

v1 sources for the port: branch file at `design/extension-model-access`
(`d6beb23`), `docs/extension-model-access-design.md` §6.2 (engine spec),
`docs/guardian-auto-mode-design.md` §13–§17 (detector analysis, on `main`).

## 11. Open questions

1. D5: S1 vs S2 (owner).
2. D10: rename to `guardian` at cutover, or keep `guardian2` (owner).
3. Keep the v1 `tool_end` error-audit lines? (proposed: yes.)
4. Should the template demonstrate one `allow` rule (proposed: no —
   `_comment` + docs only).

## 12. Review log

- Owner decisions: pending.
- R1 (independent adversarial): pending.
