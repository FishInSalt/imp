# M12 — Skills — Design

Branch `feat/skills`. This document is the implementation contract for imp's skill system,
after three-way research: **pi** (local clone `packages/coding-agent/src/core/skills.ts`,
docs/skills.md), **Claude Code 2.1.88** (sourcemap-restored sources at
`/Users/z/Z/claude-code-sourcemap/restored-src/src`), and the **Agent Skills standard**
(agentskills.io/specification). Every fact below was read from those sources, not from
secondary docs.

Working principle (project rule): **pi alignment first**. Where pi and Claude Code diverge,
imp follows pi unless this document says otherwise and justifies it. Claude Code's
implementation was studied source-level to know what we are *declining*, not to copy.

---

## 1. Goals

- imp loads **skills**: self-contained capability packages — a directory with `SKILL.md`
  (YAML frontmatter + Markdown body), optionally bundling scripts/references/assets.
- **Progressive disclosure** (the standard's core idea): startup puts only
  `name + description + location` (~100 tokens/skill) into the system prompt; the model
  loads the full body on demand via the existing `read` tool; body-referenced files load
  only when the skill's instructions call for them. Zero new tools.
- **`/skill:name [args]`** slash commands expand the body into a user message (pi format),
  registered through the existing command pipeline (`cli.ts` commands array).
- Project-tier skills sit behind the **M8 trust gate**, exactly like extensions, agents,
  and md commands.
- One new runtime dependency: **`yaml`** (real YAML frontmatter — see §13).

### Non-goals (Appendix B lists rationale)

Claude Code's frontmatter extensions (`allowed-tools` turn grants, `context: fork`,
`model`, `arguments`/`$name` substitution, `user-invocable`, `when_to_use`, `paths`,
`hooks`, `effort`), CC's Skill tool, conversation-injected skill listings with context
budget, dynamic file-touch discovery, conditional skills, ignore-file scanning,
`/reload`, subagent preloading, MCP skills, plugin marketplaces.

---

## 2. Research summary — the three implementations

| Aspect | Agent Skills standard | pi (our reference) | Claude Code 2.1.88 (source) |
|---|---|---|---|
| Unit | dir + `SKILL.md` | same | same, but `/skills/` accepts **directory format only**; bare `.md` lives in legacy `/commands/` |
| Required frontmatter | `name`, `description` | same; lenient validation | neither required: `name` defaults to **directory name** (frontmatter name = display only), `description` falls back to **first body paragraph** |
| Name/dir match | must match parent dir | **allowed to differ** (deliberate divergence for shared dirs) | dir name is the identity; display name free |
| Name charset/len | `[a-z0-9-]`, 1–64, no lead/trail/double hyphen | validate, warn-not-block | not validated at load (command-name rules apply instead) |
| Description limit | 1024 | warn-not-block | 1536 listing truncation; 250-char per-entry cap in listing |
| Optional fields | `license`, `compatibility`, `metadata`, `allowed-tools` (exp.) | accepted, mostly ignored + `disable-model-invocation` honored | + `argument-hint`, `arguments`, `user-invocable`, `model`, `effort`, `context: fork`, `agent`, `background`, `when_to_use`, `version`, `paths`, `hooks`, `shell` |
| Locations | harness-defined | `~/.pi/agent/skills`, `~/.agents/skills` (user); `.pi/skills`, `.agents/skills` cwd+ancestors to git root (project, trust-gated); settings `skills[]`; `--skill`/`--no-skills` | managed(policy) > `~/.claude/skills` > `.claude/skills` **cwd+ancestors up to $HOME** > `--add-dir` > legacy `/commands/` > bundled > MCP; dynamic discovery walks up from touched files |
| Root bare `.md` | — | `.pi/skills` root `.md` = skill; `~/.agents/skills` root `.md` ignored, nested grouping `.md` = skill | not in `/skills/`; in `/commands/` every `.md` is a command |
| Listing to model | `<available_skills>` XML in system prompt (recommended) | XML block appended to system prompt, gated on read/bash tool | **not** system prompt: `skill_listing` attachment (system-reminder) in conversation, incremental batches, 1%-of-context budget, names-only degradation |
| Invocation channels | model reads file (file-read activation) or dedicated tool | model `read`s SKILL.md; user `/skill:name` | Skill tool (model, "blocking requirement" prompt); user `/name`; shared downstream `processPromptSlashCommand` |
| Expansion format | harness-defined | `<skill name location>\nReferences are relative to DIR\n\nBODY\n</skill>` + args | `Base directory for this skill: DIR\n\nBODY` + `$ARGUMENTS`/named-substitution + `${CLAUDE_SKILL_DIR}`/`${CLAUDE_SESSION_ID}` + inline `!`shell`` execution |
| Collision policy | — | same-name: first wins + warning; realpath dedup | realpath identity dedup; precedence managed>user>project>add-dir>legacy |
| Disable model invocation | — (CC ext) | `disable-model-invocation: true` → hidden from prompt, `/skill:name` still registered | same + hides from subagent preload, scheduled tasks |
| Scanning hygiene | — | honors `.gitignore`/`.ignore`/`.fdignore` via `ignore` pkg; skips `node_modules`, dot-entries; follows symlinks | `node_modules` implicitly via dynamic gitignore check; legacy loader uses `ignore` |

**Architectural read.** pi and CC split on where the listing lives (static system-prompt
section vs conversation attachment) and how the model invokes (file-read vs dedicated
tool). pi's shape needs no new tool surface and no conversation-injection mechanism —
it maps 1:1 onto imp's existing `assembleSystem` and `read` tool. imp follows pi.

---

## 3. What imp adopts, adapts, refuses

**Adopted from pi (target behavior):** loader structure (`loadSkills` → `Skill[]` +
diagnostics), discovery rules (SKILL.md-root stop, recursion, root-md per tier, dot/
node_modules skip, symlink realpath dedup, first-wins collisions), lenient validation
(warn-not-block; missing description = skip), `formatSkillsForPrompt` XML block,
`/skill:name` command + `<skill>` expansion block, `disable-model-invocation`,
`enableSkillCommands` setting, `--skill`/`--no-skills` flags, trust gating of the
project tier with the `~/.agents/skills` user-level carve-out.

**Adapted (imp names, imp seams):** `.imp/` instead of `.pi/`; agent dir `~/.imp/skills`;
no pi `SourceInfo`/diagnostic framework — imp's plain `{type:"warning", message, path}`
diagnostics surfaced as `renderer.error` lines (md-command precedent); no pi package
manager locations.

**Refused (with reason, Appendix B):** everything in Non-goals. The two refusals that
matter architecturally: CC's Skill tool (imp's `read` tool is the activation channel —
zero new model-facing surface) and CC's conversation-injected listing (imp's skills are
loaded once at startup into the system prompt; no mid-conversation listing churn).

---

## 4. Module layout

```
src/core/skills.ts          # NEW — loader + validation + formatSkillsForPrompt (~340 lines)
src/core/settings.ts        # +skills?: string[], +enableSkillCommands?: boolean
src/core/trust.ts           # trustRequiringResources: +.imp/skills, +.agents/skills ancestor walk
src/cli.ts                  # --skill/--no-skills flags; load + pass into runner/commands
src/runner.ts               # assembleSystem: append skills block; RunnerOptions +skills
src/repl/commands.ts        # RegisteredSkillCommand shape + /skill: dispatch (no new builtin)
src/repl/repl.ts            # CommandContext.submitPrompt gains optional display override
examples/skills/ledger/SKILL.md   # NEW — dogfood example (PROJECT_PLAN ledger discipline)
docs/skills.md              # NEW — user-facing doc (README links it)
```

Batch 1 delivers `skills.ts` + settings + flags + trust + prompt injection.
Batch 2 delivers commands + display + example + docs.

---

## 5. Types (skills.ts)

```ts
export interface Skill {
	name: string;          // frontmatter name || parent-dir name (pi fallback)
	description: string;
	filePath: string;      // absolute path to SKILL.md / .md file
	baseDir: string;       // dirname(filePath) — where relative refs resolve
	source: "user" | "project" | "path";   // "path" = settings/CLI explicit
	disableModelInvocation: boolean;       // frontmatter, default false
}

export interface SkillDiagnostic {
	type: "warning";
	message: string;       // exact strings in §12
	path: string;          // the file it concerns
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: SkillDiagnostic[];
}
```

---

## 6. Locations and discovery

Load order (first-wins on name collisions; realpath dedup across all tiers):

1. **path** — explicit paths in caller order (CLI `--skill` entries first, then
   settings `skills` entries). Explicit intent outranks discovery.
2. **project** — `.imp/skills/` in cwd, then `.agents/skills/` in cwd and every
   ancestor up to and including the **git repo root** (filesystem root when not
   in a repo). Scanned only when `projectTrusted === true`. The `$HOME`
   carve-out: an `.agents/skills` that *is* the user-global `~/.agents/skills`
   directory is never a project resource (#trust-home-fix semantics).
3. **user** — `~/.imp/skills/` then `~/.agents/skills/` (both always trusted;
   the user installed them).

*(Revision during batch-1 implementation: the original draft listed user first.
That would let a user-global skill silently shadow a project's same-named
skill — the opposite of imp's md-commands/agents rule "local intent outranks
the global default", and of pi, whose resource-loader also feeds project
resources ahead of user ones. Fixed to path > project > user.)*

`--no-skills` skips tiers 1–2 and the settings array; explicit `--skill` entries still
load (pi parity: additive even under `--no-skills`).

Per-directory scan rules (pi-exact):

- A directory containing `SKILL.md` **is one skill** — do not recurse into it.
- Otherwise recurse into subdirectories looking for `SKILL.md`.
- Root-tier bare `.md`: discovered as skills in `.imp/skills` and `~/.imp/skills` only
  when frontmatter parses with non-empty `description`; **ignored** in both
  `.agents/skills` roots (nested `.md` inside grouping subdirectories is discovered
  there).
- Skip entries starting with `.` and any `node_modules`.
- Follow symlinks (stat the target); broken symlinks skipped silently; duplicate
  realpath → silently keep first.
- **No ignore-file support in M12** (pi honors `.gitignore` etc. via the `ignore`
  package; imp has no in-process gitignore machinery — Appendix A).

Explicit `--skill <file>` accepts a single `.md` with valid frontmatter (any filename,
not just SKILL.md); `--skill <dir>` accepts a directory containing `SKILL.md` or a
directory tree scanned per rules above. Non-existent path → warning, skipped.

---

## 7. Frontmatter and validation

Parsed with `yaml` (§13). Fields consumed: `name`, `description`,
`disable-model-invocation` (boolean). All other fields (standard or CC) parsed but
ignored — unknown fields never warn (standard says ignore).

Validation, all **warn-not-block** (pi's lenient stance — a skill with a 70-char name
still loads):

| Check | Warning string (§12) | Effect |
|---|---|---|
| `name` missing | — | fall back to parent directory name |
| name > 64 chars / `[^a-z0-9-]` / lead-trail hyphen / `--` | `skill name …` | still loads |
| `description` missing/empty | `skill "X" … description is required` | **skill skipped** |
| description > 1024 | `…exceeds 1024 characters (N)` | still loads |
| YAML parse error in `SKILL.md` | `…failed to parse skill file: <err>` | skill skipped |
| malformed frontmatter in non-SKILL `.md` | silent | ignored (not a skill) |

No name-must-match-directory rule (pi's deliberate standard divergence — shared
`.agents/skills` trees serve many harnesses; the standard's rule would force renames).

---

## 8. Trust integration

`trustRequiringResources(cwd, home)` gains:

- `.imp/skills` directory exists in cwd → `"skills (.imp)"` entry (joins the existing
  `.imp/{extensions,agents,commands}` list, same describe line format).
- `.agents/skills` exists in cwd or any ancestor up to git root, **excluding** the
  user-global `~/.agents/skills` itself → `"skills (.agents)"` entry.

Untrusted project → tiers under cwd are not scanned at all (skills AND their
`/skill:` commands simply absent; no partial loads). Startup never blocks: trust ask
flows through the existing `askTrustOnce` dialog.

---

## 9. Settings and CLI

```jsonc
// ~/.imp/settings.json
{
	"skills": ["~/work/shared-skills", "~/work/skills/pdf-tools/SKILL.md"],
	"enableSkillCommands": true   // default true; false = no /skill: commands,
	                             // prompt block still includes skills
}
```

- `skills`: string or string[] accepted (a bare string coerced to one-element array);
  non-string entries are dropped **silently** at parse time — settings loading is
  deliberately forgiving (corrupt files never block startup); the original draft's
  teaching-line warning was dropped as a layer mismatch.
- `enableSkillCommands`: boolean; missing = true.

CLI:

```
--skill <path>      Load an extra skill (file or directory). Repeatable.
                   Still honored with --no-skills.
--no-skills         Skip default skill locations (user + project + settings array).
```

`imp --help` lists both under the existing flags block; `bin/imp.js --help` smoke line
in tests gains nothing new (flags self-document).

---

## 10. System prompt injection

`runner.assembleSystem()` appends after the extension context sections (order:
base → AGENTS.md → extension sections → **skills block**), only when skills exist and
the read tool is available (imp always has `read`; the guard keeps pi's shape and
protects future tool-restricted configs). `/new` re-runs assembleSystem — block is
stable across sessions.

Block format — pi's `formatSkillsForPrompt` verbatim (spec-recommended XML):

```
\n\nThe following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>ledger</name>
    <description>…XML-escaped description…</description>
    <location>/abs/path/skills/ledger/SKILL.md</location>
  </skill>
</available_skills>
```

- `disable-model-invocation: true` skills are excluded (user-only commands).
- Name/description/location XML-escaped (`& < > " '`).
- Empty skills → no block at all (never an empty `<available_skills/>`).
- No size budget in M12 (pi has none; CC's 1% budget is Appendix B future hardening).
- Startup note (both modes, before the context-file note — extension precedent;
  zero skills → silence): `▪ skills: N loaded`
  and, when diagnostics exist, one `renderer.error` line each (capped at 5, then
  `… +K more`; md-command precedent).

---

## 11. `/skill:name` commands (batch 2)

### 11.1 Registration

When `enableSkillCommands !== false`, every loaded skill registers a command:

```ts
interface RegisteredSkillCommand { command: SlashCommand; source: string } // rides the md-command pipeline shape
// name: `skill:${skill.name}`   summary: skill.description (first 80 chars, one line)
// allowedDuringRun: false       run: (args, ctx) => { ctx.submitPrompt(block, {display}); return "handled"; }
```

- The `skill:` prefix makes collisions with builtins/extension/md commands
  **impossible by construction**. If an extension or md command nonetheless registered
  the literal name `skill:foo` first (md files can contain colons), the skill command
  is skipped with a warning — registration order: builtins → extensions → md → skills.
- `/help` lists them like md commands, tagged `(skill)`.
- `disable-model-invocation: true` skills **still register** the command (that is the
  point of the flag — user-only invocation).

### 11.2 Expansion (exact format, pi parity)

`/skill:name rest of line` → user message:

```
<skill name="NAME" location="/abs/SKILL.md">
References are relative to /abs/skill-dir.

BODY-WITHOUT-FRONTMATTER
</skill>

ARGS            ← omitted (with the blank line) when args are empty
```

- BODY = SKILL.md content with frontmatter stripped, trimmed.
- Read failure at invocation time → `renderer.error` line, the raw `/skill:name …`
  text is **not** sent (divergence from pi, which forwards the raw text to the model —
  imp's teaching-style command errors never reach the model; consistent with unknown
  command handling).
- Unknown `/skill:whatever` falls through to the existing unknown-command teaching
  error, which lists known commands.

### 11.3 Display

The expanded block goes to the model via the normal turn path; the transcript shows a
single line instead of echoing potentially hundreds of lines:

- `CommandContext.submitPrompt(text: string, opts?: { display?: string })` — when
  `display` is set, the TUI/legacy echo renders that string instead of the full text
  (print mode never echoes; bytes unchanged). Skill commands pass
  `display: "▪ skill: name" + (args ? ` (${args})` : "")`.
- The **session record keeps the full expanded user message** (replay fidelity — a
  resumed session must reproduce the conversation exactly).
- `imp -r <id>` replay rendering collapses a leading `<skill ` block to the same
  `▪ skill: name` summary line (display-only normalization).

### 11.4 Model self-invocation

No command involvement: the model reads `<location>` with the existing `read` tool
when a task matches a description (progressive disclosure — the prompt block's
instruction line says exactly this). Nothing further to build.

---

## 12. Diagnostic catalog (exact strings)

Loader/CLI (via `renderer.error` at startup, or returned as diagnostics):

```
imp: skill path "PATH" does not exist — skipped
imp: skill path "PATH" is not a markdown file — skipped
imp: skill path "PATH" failed to stat: <error first line>
imp: skill "NAME" (PATH) ignored — description is required
imp: skill "NAME" (PATH): description exceeds 1024 characters (N)
imp: skill name "NAME" (PATH) invalid: must be 1-64 chars, lowercase letters, digits, hyphens
imp: skill file "PATH" failed to parse: <yaml error, first line only>
imp: skill file "PATH" failed to read: <error first line>
imp: skill name collision: "NAME" from PATH loses to PATH (first loaded wins)
```

Command dispatch (teaching style):

```
imp: /skill:NAME failed to read /abs/SKILL.md: <error first line>
```

`/help` unknown-command line already covers unknown skills.

---

## 13. Dependencies

**Add `yaml` (runtime)** — pi pins `yaml@2.9.0`; imp takes `^2.9.0`.

Rationale: skill frontmatter is real-world YAML — folded `>` descriptions, quoted
colons, multi-line strings are the *common* shape (see agentskills.io examples). imp's
hand-rolled `key: value` parsers (agents registry, commands-md) would reject or
mis-parse them; shipping a lenient-but-wrong parser is a compatibility bug farm. imp
already carries runtime deps (`pi-tui`, `typebox`), so the zero-dep constraint is not
in force here. Rejected alternative: hand-rolled subset parser (~120 lines, fails on
block scalars/escapes).

**No `ignore` package** — skip gitignore-file scanning in M12 (§6). Skills directories
are small; `node_modules`/dot-entry skipping covers the practical blast radius.

---

## 14. Testing strategy

Unit (`test/skills.test.ts`):

- validation boundaries: name 63/64/65 chars, uppercase, `-x`, `x-`, `x--y`;
  description 1024/1025; missing/empty description (skip); malformed YAML (skip,
  warning); unknown fields ignored silently.
- discovery: SKILL.md-root stops recursion (a SKILL.md inside a subdir with nested
  SKILL.md only yields the outer); root-md tiers (`.imp/skills` yes, `.agents/skills`
  no + nested yes); dot-entry/node_modules skip; symlink to same file → one skill;
  name collision → first wins + warning; frontmatter-name vs dir-name fallback.
- `formatSkillsForPrompt`: exact block bytes for a two-skill fixture (golden string),
  XML escaping (`& < > " '` in description), disable-model-invocation exclusion,
  empty → `""`.

Integration:

- `test/trust-skills.test.ts`: `.imp/skills` present → appears in
  `trustRequiringResources`; ancestor `.agents/skills` found up to git root; `$HOME`
  carve-out (cwd under home tree still gates); untrusted → project skills absent,
  user skills present.
- `test/settings.test.ts` additions: `skills` string/array coercion, bad entries.
- `test/runner` (or existing system-prompt test): skills block appended after
  extension sections; `/new` keeps it; `--no-skills` omits.
- `test/repl-skills.test.ts` (batch 2): `/skill:name` expansion exact block bytes
  (golden string with args and without); display line not full body; read-failure
  error; md-command-named-`skill:x` conflict; unknown `/skill:x` teaching error;
  session record contains full block; replay collapses it.
- e2e smoke: scripted provider + a fixture skill whose body says "reply with the
  contents of references/answer.txt" → model must `read` the SKILL.md then the
  reference file (progressive disclosure through real tool calls — the M4 lesson:
  assert on the tool-call sequence, not the prompt).

Docker/Linux note: git-fixture branches pinned (`init -b main`) per #ci-linux-fix —
new trust tests reuse the seeding helpers.

---

## 15. Batches and acceptance criteria

**Batch 1 — loading plane** (`skills.ts`, yaml dep, settings, flags, trust, prompt
injection, startup notes):

- skills load from all four default locations with correct precedence;
- `--skill`/`--no-skills` behave per §6;
- untrusted project loads no project skills, user skills intact;
- system prompt ends with the exact XML block when skills exist;
- diagnostics render as teaching lines;
- all existing tests unchanged (757 baseline) except settings/cli arg-parser tests
  that gain cases; `npm audit` clean with `yaml` added.

**Batch 2 — invocation plane** (commands, expansion, display, replay, example, docs):

- `/skill:name args` produces the exact `<skill>` block user message; transcript shows
  one summary line; session stores the full block; replay collapses it;
- `/help` lists skills tagged `(skill)`;
- conflict with a md command literally named `skill:x` resolves with a warning;
- `examples/skills/ledger/SKILL.md` + `docs/skills.md` + README section shipped;
- e2e progressive-disclosure test green.

---

## Appendix A — pi vs imp divergences

| # | pi | imp | Why |
|---|---|---|---|
| A1 | ignore-file scanning (`.gitignore`/`.ignore`/`.fdignore` via `ignore` pkg) | not in M12; `node_modules`+dot skip only | no in-process gitignore machinery; skills dirs are small; revisit if real repos suffer |
| A2 | `/reload` re-scans skills | startup only (no `/reload` in imp) | imp never had resource reload; consistent with extensions/md-commands |
| A3 | pi packages `skills/` dirs + `pi.skills` manifest entries | none | imp has no package manager |
| A4 | raw `/skill:x` forwarded to model when read fails | teaching error, nothing sent | imp command errors never reach the model (existing convention) |
| A5 | SourceInfo/diagnostics framework | plain warning objects + renderer.error | imp has no resource-diagnostic UI |
| A6 | settings migration (old object format) | fresh key, no legacy | imp never shipped the old shape |

## Appendix B — Claude Code features declined (with future mapping)

| Feature | Why declined | If ever needed |
|---|---|---|
| Skill tool (model-invoked) | read-tool activation is pi's design; zero new model surface | register a read-only `skill` tool whose description embeds the listing |
| Listing as conversation attachment + 1% budget + incremental batches | static system-prompt block fits imp; budget unnecessary at imp's scale | add a char budget to `formatSkillsForPrompt` (CC's 250-char/entry cap, names-only fallback) |
| `allowed-tools` turn grants | imp has no per-turn permission model | gate on a future permissions system |
| `context: fork`/`agent`/`background` | subagent mapping is a separate design | `ctx.submitPrompt` → task tool call with skill body as prompt |
| `model`, `effort`, `hooks`, `paths`, `when_to_use`, `user-invocable`, `arguments`/`$name`, `argument-hint`, `${CLAUDE_SKILL_DIR}`, inline `!`shell`` | CC-only surface; standard six fields cover M12 | per-feature, only on demand |
| Dynamic file-touch discovery, conditional skills, MCP skills, managed/policy tier, plugins | CC's ecosystem scale | — |

## Appendix C — key source coordinates (for implementation)

- pi loader: `pi/packages/coding-agent/src/core/skills.ts` (loadSkillsFromDir,
  loadSkillFromFile, formatSkillsForPrompt, validateName/Description)
- pi prompt injection: `pi/packages/coding-agent/src/core/system-prompt.ts:160`
- pi expansion: `pi/packages/coding-agent/src/core/agent-session.ts:1358` (`_expandSkillCommand`)
- pi trust gate: `pi/packages/coding-agent/src/core/trust-manager.ts:180`
- pi docs: `pi/packages/coding-agent/docs/skills.md`
- CC loader: `claude-code-sourcemap/restored-src/src/skills/loadSkillsDir.ts`
- CC listing/budget: `…/src/tools/SkillTool/prompt.ts` (SKILL_BUDGET_CONTEXT_PERCENT=0.01)
- CC listing injection: `…/src/utils/attachments.ts:2741` (skill_listing attachment)
- standard: `agentskills.io/specification` (+ client-implementation guide)
- imp seams: `src/runner.ts` assembleSystem (~line 398), `src/cli.ts` (~line 412 md
  pipeline), `src/repl/repl.ts` enqueuePrompt/submitTurn, `src/core/trust.ts:204`
