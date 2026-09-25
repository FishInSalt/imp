# Tool display refinement: quiet hints and compact source rows

Status: APPROVED — independent fresh-context adversarial design review closed. Implementation requires full verification and independent code review.

Workspace: `/Users/z/Z/Agent_demo/imp-tool-display`, existing dedicated branch `feat/tool-display-previews`. This design continues that branch's existing change; it creates no branch, commit, merge, or main-worktree change. It supersedes the hint policy and collapsed source layout in `tool-display-polish-design.md` only as specified below. All other safety and retention contracts remain.

## 1. Inspected baseline and scope

Inspected core and extension public presentation types; `src/repl/tool-presentation-hooks.ts`, `tool-presentation.ts`, `components/tool-block.ts`, shell key handling and command help; `examples/extensions/web-search/index.mjs`, `_lib/presentation.mjs`, `_lib/normalize.mjs`; the prior polish design and `test/web-search-presentation.test.ts`.

Observed in this worktree:

- Hooks already return summary/preview/detail and structured argument fields. Validation uses own-data descriptors, bounded arrays/text, detached frozen copies and whole-presentation fallback.
- `ToolBlockFold` advertises expansion unconditionally for structured calls, adds Alt+O to each such block, and compares raw section text with preview text. Ordinary wrapping produces numeric omission notices even when expansion can reveal it.
- Search joins title and hostname into strings. Host wrapping can let one long title consume all three collapsed rows, hiding its domain and other entries.
- Search parser requires the exact warning/query envelope and conservative delimiters/URLs. Rejection yields `Search response`. It cannot prove API provenance.
- `url_read` has no hooks. Its output begins with warning, Source, optional Final URL and a blank separator before body. HTTP failures are single-line `url_read HTTP N: page request failed`. Host already promotes and exactly deduplicates error lines when collapsed.
- Shell Ctrl+O toggles all folds; Alt+O already toggles transcript-local readable/raw arguments without expanding. `/help` currently lists Ctrl+O but not Alt+O.

This is presentation-only. No model output, execute return payload, cache format, session format, prompt/schema, print/legacy rendering, task identity or execution changes. No API requests, credentials access or real-session replay to diagnose this task. The actual failing search sample is unavailable: its specific rejection cause is unknown, not reproduced or fixed by assertion.

## 2. Hint and omission policy

Remove **all per-block Alt+O hints**, in both readable/raw and collapsed/expanded modes. Keep the key and state unchanged. Global `/help` is the discovery location:

```text
Ctrl+O   expand/collapse all folds (tool calls/results, errors, diffs, reasoning)
Alt+O    switch readable/raw arguments for structured tool calls;
         visible when expanded; does not expand or collapse folds
```

Document the existing legacy ESC+o transport limitation in extension/user documentation, not every block. No new persistent footer, selector, key binding or raw-state persistence.

Collapsed ordinary crop uses one host footer action: `… more · Ctrl+O`. Do not also emit `Ctrl+O to expand` or numeric collapsed wrapped-row omissions for the same recoverable crop. The action means more retained content is reachable under expansion, not that all output can be recovered. Display it only when expansion exposes additional meaningful content within its existing cap:

- Additional visible readable argument fields/unknown fields beyond the compact call, result evidence beyond a summary, additional retained lines, or horizontally shortened source fields that raw expansion can actually reveal qualify.
- JSON braces, indentation, quoting, caption differences, or the mere presence of `sections`, `argumentFields`, or a raw alternate representation do not qualify alone. Small generic calls already displaying all values have no hint. An empty structured field list does not qualify by itself.
- For structured calls compare sanitized logical readable field content (including defaults/unknowns) with collapsed semantic content, excluding section captions. Additional fields genuinely shown on expansion qualify even when not cropped. For generic calls compare retained body content excluding captions, not pretty-printed raw JSON against an equivalent compact representation. No need to build a general JSON-equivalence engine: when a call only differs by the existing raw section representation, do not advertise that alternative. Keys remain functional regardless of hints.
- A one-line error fully promoted to metadata has no expansion hint merely because `Result text` repeats it. Preserve exact pre-sanitization identity checks; do not broadly deduplicate similar messages. Distinct diagnostic lines still qualify when reachable.
- Content wholly beyond the expanded cap cannot justify Ctrl+O. Evaluate reachability using the actual selected expanded mode (readable/raw for structured calls), caption budget, sanitization and current width, without reinvoking hooks.

Real caps remain explicit: retained-section source-line losses, expanded 1000-wrapped-row losses and optional detail losses keep their existing per-section counts. Combine independent cap facts and the optional action into one footer, each at most once. Do not relabel a permanent loss as `more`. If a collapsed view hides retained content but expansion reveals none of it, retain an explicit view-omission statement without Ctrl+O. Tool-reported formatter truncation remains quoted evidence, not a host count. Preserve ordinary 3-row/diff 8-row body budgets, raw-first expanded allocation, metadata outside the body budget, and all existing error/image/interruption metadata.

## 3. Minimal public API for field-aware source rows

Choose an optional structured source list rather than parsing a `Title — domain` string in the renderer or adding tool-name dispatch. No generic layout language is needed.

Add alongside existing core types and re-export from `src/extensions/types.ts`:

```ts
export interface ToolSourcePresentation {
  readonly title: string;
  readonly url: string;
}

export interface ToolSemanticPresentation {
  readonly summary: string;
  readonly preview?: readonly string[];
  readonly detail?: readonly string[];
  readonly argumentFields?: readonly ToolArgumentPresentationField[];
  readonly sources?: readonly ToolSourcePresentation[];
}
```

`sources` is result-phase only. Existing fields and hooks are unchanged. No caller-provided domain, status, count, width, ANSI, callbacks, trust label or replacement raw text. The host derives `new URL(url).hostname` as a mechanical display field, not a provenance assertion or registrable-domain calculation. Keep the phase internal: pass an explicit `"call" | "result"` argument through validation/invocation; reject sources in call returns and argumentFields in result returns. No new hook context fields.

Collapsed order is nonempty summary, sources in supplied order, then preview. `summary: ""` with sources intentionally consumes no row (no empty leading arrow). Empty summary behavior for presentations without sources stays unchanged. Search returns empty summary plus sources, so the first source receives the result marker. Optional quoted formatter-omission preview follows sources and shares the three-row budget. Expanded rendering is unchanged: original `Result text`, distinct `Live display`, then existing bounded detail. Do not add a second expanded source list.

### Validation

Extend the existing descriptor-based validator, not JSON serialization of hook returns:

- `sources`: ordinary dense array, length 1–10, own index/length properties only. Plain own-data records with exactly required `title` and `url`; no unknown keys, symbols, getters, decorated arrays or unsupported prototypes. Reflective exceptions reject the phase.
- Title string: 0–4096 UTF-16 units (empty title renders domain alone). URL string: 1–2048 units. Charge both strings to the existing combined 100,000-unit return budget. Existing summary/preview/detail bounds remain.
- URL must be canonical absolute HTTP(S), nonempty hostname, no user/password; parsed `href` must equal input. Reject literal whitespace, controls (Cc/Cf), backslashes and percent-encoded control bytes using the existing conservative search rule. Never silently normalize a rejected URL into acceptance. Reject invalid elements as a whole presentation, never partially discard a source list.
- Copy and freeze records/list/outer result. Preserve promise rejection handling, snapshot limits and pure synchronous hook invocation. Host validation is crash containment, not a sandbox or proof of source truth.
- This is a display URL constraint only. It does not change which URLs tools may fetch or add a network blocklist. Local/private addresses may be displayed if they satisfy the same syntax rules.

### Width and sanitation

Each collapsed source is **one physical row**, after existing result indentation. Sanitize title before measuring; flatten title newlines (including Unicode line separators) to spaces and render bidi/format controls as visible escapes for this new field. Do not alter the global sanitizer's unrelated rendering policy. Derive hostname from the already validated URL, retaining subdomains/ports policy of `URL.hostname` (hostname excludes port, IPv6 retains its URL representation). Do not decode punycode or URL escapes for display.

Let W be the available body width after prefix:

1. If hostname fits with a separator ` — ` and at least one title display column, reserve the entire hostname and separator, then ellipsize title into the remaining width using terminal-visible grapheme width.
2. If title is empty or there is insufficient room for separator plus one title column, omit title and separator. Render hostname alone, ellipsized only if it itself exceeds W.
3. Never wrap a collapsed source, split a grapheme, emit control sequences from fields, or exceed terminal width. At widths 1/2 drop normal decoration before consuming content width, as today. If a glyph cannot fit, use the existing defensive clamp.

Title/domain horizontal shortening is a recoverable crop only if corresponding raw content is reachable on expansion. Count omitted source rows as layout facts internally, not claimed API totals. Width/mode caching remains host-owned; resize recomputes layout without hooks. This API can be used by any extension; core contains no `web_search`/`url_read` name checks.

## 4. Search parser and honest fallback

Successful recognized nonempty results return `{ summary: "", sources: [{ title, url }, ...], preview?: [...] }`. Recognize the formatter's terminal newline `[truncated]` in a title as today; convert that suffix into a visible title ellipsis for compact display, preserving full original marker in expansion. Empty titles use domain-only layout. Exact empty envelope remains `No results reported`. Errors/images still return undefined so host diagnostics win.

Change rejected/ambiguous successful text fallback to **`Source preview unavailable`**. This means only the source preview is unavailable; do not infer no sources, provider failure, missing credentials, or a result count. Raw expansion remains available when reachable. Missing extension/hook or host validation rejection still uses generic host fallback, not this extension-specific label.

Investigate compatibility with deterministic formatter fixtures, not guesses about the unknown actual response:

- Current formatter allows multiline titles/query/content, canonicalizes URLs through `webUrl`, and appends bounded truncation delimiters. Current parser deliberately rejects multiline titles/queries, ambiguous reserved delimiters and stricter URL hazards. Such differences can explain a fixture rejection but are **not** evidence of the user's actual cause.
- Keep current envelope, exact query comparison when args are available, ordinal, limits, content delimiter, omission placement and URL safeguards. Do not loosen these merely to reduce fallback frequency. No regex search for plausible URLs after rejection; no partial source extraction.
- Make private parsing branches diagnosable in deterministic tests using finite rejection categories (envelope/query, bounds, source structure, URL, ambiguous evidence). These are module-local parser results/test assertions, not a public hook/API or production logging feature. If testing needs exports, use a named internal-module export only; never log payloads/credentials. User-facing fallback stays one sentence, without an unproven diagnosis.
- This batch does not expand accepted grammar without a separately reviewed, unambiguous formatter fixture demonstrating safety. Fix formatter/parser drift tests and compact representation, not execution text. The text envelope still cannot establish API provenance, even after successful parsing: keep count-free, trust-neutral labels.

Tests should obtain representative output through registered execute with a fully stubbed fetch and test-only environment key, alongside hand-built adversarial fixtures. Do not export/change `formatResults` just for tests. Do not read real config, call Tavily, or replay private history.

## 5. Extension-owned url_read presentation

Register a separate `urlReadPresentation` from `_lib/presentation.mjs` on the existing url_read definition. No changes to execute, `htmlToText`, fetch, headers, redirects, content types, downloads, timeouts or limits. **Keep the user's requested local/private-network access policy exactly as it is.**

Call hook: for available valid URL arguments return the readable URL summary and one argument field `{ label: "URL", value: url, consumes: ["url"] }`; unknown keys remain host-visible. Do not manufacture defaults. Unsafe/unavailable arguments return undefined; original snapshot remains inspectable. Prefer preserving original valid argument spelling for call display; apply strict display validation, do not silently rewrite raw arguments.

Success result hook: parse only the exact leading warning + `Source: <safe canonical URL>` + optional `Final URL: <safe canonical URL>` + blank separator, within the existing 20,000-unit output bound. With available arguments, normalize through equivalent existing `webUrl` syntax locally (no execute or I/O), validate the normalized URL using display rules, and require exact Source match. Orphans may interpret the envelope without asserting call provenance. Do not scan body for Source or Final URL to repair a malformed prefix.

Use the final URL when present, otherwise Source, as the summary; put the first nonblank body lines in preview (budgeted by host). Leading body blanks and envelope warning/Source labels do not consume the compact body budget. Existing output has no reliable title metadata: a body heading may appear as body text, but **do not call it an extracted page title** or add HTML parsing/fetching for one. If no nonblank body exists, show the URL alone; raw warning/redirect envelope is still retained on expansion. Original body, warnings and truncation markers are never altered or removed from model/session content. Malformed successful envelope returns undefined, rather than disguising arbitrary text as a page summary.

Errors/images return undefined. For the deterministic HTTP 401 error, the intended compact result is:

```text
  ⎿ failed
    url_read HTTP 401: page request failed
```

No duplicated error line, no per-block Alt+O, no `more` hint just for raw repetition/caption. Keep full diagnostic text rather than shortening away status or meaning. A distinct error detail must remain visible or produce one reachable-more hint. This relies on generic host deduplication/hint policy, not url_read-specific error handling in core.

## 6. Implementation boundaries and planned verification

After review, expected touch points: core presentation type/extension re-export; hook validation; `ToolBlockFold` field layout, availability calculation and footer; `commands.ts` global help; extension presentation helper and registration; extension README and focused tests. Internal block bookkeeping may retain expansion/crop facts but introduces no public API beyond `sources`. No new loop, provider, execution, persistence or network-policy plumbing.

Deterministic acceptance tests (not yet run or implemented):

1. Hook validator: old hooks unchanged; result-only sources, call-only fields, exact keys, bounds at/over limits, aggregate budget, sparse/decorated arrays, accessors/proxies/promises, mutation/freeze, invalid element whole-phase fallback, HTTP(S)/credential/control/canonical URL hazards. Verify generic fallback preserves errors and raw content.
2. Source layout at widths 1, 2, 5, 20, 80: long title still leaves full domain when it fits; hostname-only at narrow widths; empty title, CJK, combining marks, emoji, ANSI/OSC, newlines and bidi controls; one physical row per source, no repeated summary, three-row budget and once-only more footer. Expansion remains original wrapped raw text with independent caps.
3. Hints: no Alt+O in any block; global help documents both keys; tiny generic JSON and fully displayed URL argument have no hint solely for JSON; structured additional fields qualify; duplicate one-line errors do not; distinct details do. Recoverable crop uses exact `… more · Ctrl+O`; hard-cap counts stay explicit with no unreachable expansion promise. Repeat in readable/raw modes and after resize.
4. Search formatter fixtures: zero/one/ten results, long/truncated/empty titles, full-content markers, omitted sources, malformed/historical formats, query mismatch/multiline, reserved-delimiter evidence, URL hazards. Assert deterministic rejection categories where appropriate and exact `Source preview unavailable`; never counts or unsupported real-world diagnoses. Existing conservative rejection fixtures stay rejected.
5. url_read: source-only URL plus body, redirect URL, leading blanks, empty body, plain/HTML-derived text via stubbed execute, malformed prefix, missing/unavailable args, unsafe display URLs, HTTP 401 and multiline distinct errors, truncation. Verify exact execute output before/after presentation and no duplicate diagnostics/hints.
6. Model/session/print-legacy preservation: compare output/display/content, provider inputs and saved result bytes with baseline fixtures; live/replay semantic parity without executing a tool on replay. Hooks perform no I/O; rendering/resizing/toggles never reinvoke hooks. Stub all fetches and config inputs; use fake URLs and synthetic saved events only.
7. Existing TUI key precedence, all-fold Ctrl+O, Alt+O state inheritance/reset, diff/image/status/cap and source identity regression tests remain mandatory.

Focused command after implementation:

```sh
npx vitest run test/tool-display-polish.test.ts test/tool-presentation-hooks.test.ts test/tool-presentation.test.ts test/tool-presentation-integration.test.ts test/web-search-presentation.test.ts test/repl-tui.test.ts
npm run typecheck
npm run lint
npm run build
npm test
```

Use installed dependencies only; do not install if a tool is absent. Report exact totals and failures. Design-only validation is file/status/whitespace inspection, not a claim that these future tests passed.

## 7. Review gate

**Parent: commission an independent fresh-context adversarial design review now and close its findings before any implementation.** This document is not approved by its author. Review specifically: phase enforcement and malicious source fields; semantic vs JSON-only expansion eligibility; selected-mode/cap reachability; source title/domain width and control handling; parser ambiguity/provenance and honest unknown-cause wording; URL-read envelope recognition without a network-policy change; raw/model/session/legacy invariants. Independent code review is also warranted after implementation because this touches a public validated contract and generic renderer behavior.
