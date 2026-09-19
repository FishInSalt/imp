# Skills

A skill is a self-contained instruction package the model loads on demand —
the [Agent Skills](https://agentskills.io) standard (same shape as Claude
Code and pi skills). Only a one-line catalog entry (name + description +
location) enters the system prompt; the full body is read when a task
actually matches. That is *progressive disclosure*: zero-cost until used.

## Layout

```
<cwd>/.imp/skills/ledger/SKILL.md     project tier (this repo, trust-gated)
<cwd>/.agents/skills/…                shared tier (this repo, trust-gated;
                                       also found in ancestor dirs up to the
                                       git root)
~/.imp/skills/…                       user tier (all your projects)
~/.agents/skills/…                    user shared tier (all your projects)
--skill path / settings "skills"      explicit tier (always loads)
```

`SKILL.md` = YAML frontmatter + Markdown body:

```markdown
---
name: ledger                          # optional; defaults to the directory
description: What the skill does, for whom (required, ≤1024 chars)
disable-model-invocation: false       # true = user-only (/skill:name still works)
---
Body — instructions, optionally referencing files in the same directory.
```

Discovery rules (pi parity): a directory containing `SKILL.md` is a skill
root — its subdirectories are not scanned further (nest them by placing
each `SKILL.md` in its own leaf). Loose `.md` files count as skills in
`.imp/skills` roots but not at `.agents/skills` roots (they nest there).
Name collisions resolve first-wins; duplicates via symlinks are deduped.
A skill without a description is skipped with a warning — the description
is what the model sees, so it is not optional.

Project tiers load only after the M8 trust gate admits the repo (same rule
as extensions/agents/commands). Explicit paths are user intent and always
load.

## Using skills

Two ways, by design:

- **Let the model decide.** The system prompt ends with an
  `<available_skills>` catalog; when a task matches a description, the
  model reads the SKILL.md with the `read` tool. Nothing to type.
- **Force it:** `/skill:ledger add an entry for the CI fix` — the command
  expands to the full body (references resolve against the skill
  directory) and starts a turn. The transcript shows a one-line
  `▪ skill: ledger (…)` echo; the session stores the full block, and
  replays collapse it back to the summary line.

`/help` lists registered skills tagged `[skill]`. Set
`"enableSkillCommands": false` in `~/.imp/settings.json` to skip command
registration (the catalog stays).

## CLI

```
imp --skill path/to/SKILL.md     # explicit skill (repeatable)
imp --skill path/to/skills-dir   # scan a tree per the rules above
imp --no-skills                  # skip discovered + settings skills
                                  # (explicit --skill paths still load)
```

Settings (`~/.imp/settings.json`): `"skills": ["/abs/or/~/path", …]`,
`"enableSkillCommands": true|false`.

## The example

`examples/skills/ledger/` — a ledger-keeping skill for PROJECT_PLAN.md
with a `references/` subdirectory, demonstrating the
read-on-demand pattern for supporting material:

```
cd examples && imp -p --skill skills/ledger "summarize the entry rules"
```
