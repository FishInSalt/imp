# Tool output integrity

Status: approved; independent fresh-context adversarial design review closed after resolving read-path quoting and pre-aborted search handling. Implementation still requires tests and independent code review.

Worktree: `/Users/z/Z/Agent_demo/imp-tool-output`

Branch: `fix/tool-output-integrity`

Inspected base: `ffd643dd151e8b24c5ac806547281dde190d7f7d`

## 1. Scope and compatibility

Fix raw tool results that lose text silently, miscount lines/bytes, manufacture text at chunk boundaries, hide directory names, or misstate process/artifact completeness. Keep plain-text tool outputs and existing tool/result types. Do not introduce a blanket JSON envelope, model-result schema changes, execution architecture changes, new search modes, URL/network/security work, or changes to task/MCP limits.

Preserve `write`'s compact receipt and `edit`'s compact model-facing `content` receipt, with the diff confined to `output`/`display`. Preserve image reading and image processing. Changes to display code are restricted to recognizing the revised built-in notices/statuses, including historical notices during replay. Keep numeric bash exit behavior: an ordinary nonzero numeric exit is reported via `exitCode` and `Exit code: N`, not reclassified as a tool error.

Retain **per-stream**, not aggregate, bash budgets. That is the least behavioral change: stdout and stderr already receive separate truncation and storage. Update the tool description to say so. Headers, status lines, and notices are outside payload budgets; never advertise a 50KB aggregate result cap. Here `KB` in existing user-facing notices means 1024 bytes, and `MB` means 1024² bytes. New precision-sensitive notices use integer bytes.

## 2. Confirmed findings at the base

These are source findings, not claims that regression tests have already been run.

| Source | Confirmed behavior | Existing coverage and gap |
| --- | --- | --- |
| `src/core/tools/read.ts` | Slices joined UTF-8 bytes mid-line, counts that fragment as a shown line, and directs the next call past it. If the byte cut remains in the last selected line, the line-count comparison can suppress the notice entirely. Fractional offset/limit pass validation. `split("\n")` counts an empty file as one line and a terminal LF as another line. | `test/tools.test.ts` covers ordinary offset/limit, 2000-line cap, beyond EOF, binary rejection, and an oversized first line; not these boundary cases. |
| `src/core/tools/grep.ts` (`runSearch`, shared by `find.ts`) | Decodes and splits each stdout chunk independently; a split line becomes two lines and a split UTF-8 character can become replacements. The guard counts UTF-16 code units, discards the entire crossing chunk, and fabricates a `+1` line. stderr appends 2000 characters **per chunk**, without an aggregate bound. Byte truncation can invalidate both UTF-8 and the stated shown-line count. Null exit status without timeout/abort can be mistaken for success. | `test/search-tools.test.ts` uses real rg/fd and skips when unavailable. It does not control chunks, guard crossing, stderr flooding, or signal closes. |
| `src/core/tools/bash.ts` | Tail/full counters and slicing use string length rather than bytes; chunks decode independently. Reaching the full cap exactly, followed by more chunks, never sets `fullCapped`. Even capped artifacts are called “Full output”. A signal close can return `isError: false` with no exit status. `trim`/`trimEnd` discard whitespace-only output and trailing source whitespace. | `test/tools.test.ts` covers small stdout/stderr, exit 3, timeout/abort, tail truncation, and reading an artifact. No deterministic byte/cap/signal boundaries. |
| `src/core/tools/ls.ts` | A failed `stat` silently skips the name, including dangling symlinks; all failures can produce `(empty directory)`. | `test/ls-tool.test.ts` covers sorting, caps, errors, and cancellation, not dangling/stat-failure names. |
| `src/core/tools/edit-diff.ts`, `edit.ts` | Zero-match advice says to match CRLF, although `edit.ts` normalizes both the file and edits to LF before matching. | `test/edit-write.test.ts` verifies BOM/CRLF preservation using a single-line edit, not multiline LF input against CRLF. |
| `src/repl/tool-presentation.ts` | `notice()` uses anchored built-in grammars; arbitrary notice changes will no longer be promoted beyond retained body text. Bash timeout recognition only accepts integer seconds. | `test/tool-presentation.test.ts` pins current notice contracts and promotion beyond 1000 lines. Extend rather than replace those tests. |

## 3. Shared definitions and bounds

### Text and lines

A logical line is LF-terminated, or the nonempty final unterminated sequence. A terminal LF does not create an extra line; empty input has zero lines. Blank lines inside input count. CR before LF remains payload text (no broad line-ending normalization). Read retains its existing decoder/BOM policy; edit retains its separate normalization policy.

For read/search previews, represent selected complete line contents joined by LF, without a synthetic terminal empty record. A source terminal LF is not an additional record. A blank line has zero content bytes but still occupies a record; derive counts from records, never by splitting the rendered empty string. For bash, preserve source whitespace and line terminators, including whitespace-only streams; headers/separators are formatting, not source payload. Count bash tail lines with the same logical-line definition.

All named byte budgets use raw Buffer lengths when retaining subprocess bytes, and `Buffer.byteLength(text, "utf8")` when budgeting rendered text. Never use JavaScript string length as bytes. Valid UTF-8 must survive arbitrary chunk partitions unchanged. A byte cut may discard an incomplete UTF-8 code point at the cut boundary; it must never introduce a replacement character solely because of that cut. Truly invalid source bytes may decode with replacement characters; artifacts retain original bytes. Recheck rendered byte budgets after replacement decoding (invalid source can expand). Byte-boundary trimming and payload omission both count as truncation.

Small pure internal helpers for logical-line splitting and UTF-8-safe head/tail limits are allowed. They must not become a generic tool-result framework. Sharing low-level byte helpers is appropriate; read/search/bash truncation policies are intentionally different.

### Budget table

| Tool/store | Payload limit | Direction and accounting |
| --- | --- | --- |
| read text | 2000 logical lines and 51,200 rendered bytes | Whole-line prefix of requested range, LF join included |
| grep/find stdout preview | clamped requested line limit (existing defaults 100/200, max 1000), and 51,200 rendered bytes | Whole-line prefix; no partial line reported as a result |
| grep/find stdout collection | 1,048,576 raw bytes total | Retain prefix; first additional byte triggers existing stop policy |
| grep/find stderr collection/display | 2,000 raw bytes total; rendered diagnostic at most 2,000 bytes | Retain prefix across all chunks, continue draining; one truncation notice |
| bash rolling tail | 262,144 raw bytes **per stream** | Retain suffix; separately track total observed raw bytes |
| bash preview | 500 logical lines and 51,200 rendered bytes **per stream** | Tail; a byte-limited leading line fragment is explicitly identified |
| bash artifact prefix store | 10,485,760 raw bytes **per stream** | Retain prefix; compare total observed bytes to retained bytes |
| ls | existing clamped entry limit (default 500/max 5000), 51,200 rendered bytes | Whole entries including each existing trailing LF |

No new read input-memory guarantee: read still loads the file to support existing image/binary handling. This change concerns output integrity, not streaming large-file input.

## 4. Read contract

1. Change parameter schemas to positive integers and validate with `Number.isSafeInteger` and `>= 1` at runtime before file I/O (also rejects invalid values on image calls consistently). Omitted values retain defaults. No coercion or rounding. Error wording: `Error: offset must be a positive safe integer (1-indexed), got VALUE` and `Error: limit must be a positive safe integer, got VALUE`.
2. Count lines according to section 3. Empty file with absent offset or offset 1 returns empty output without error; offset >1 returns the existing beyond-EOF error with `0 lines total`. For nonempty files, offsets beyond the actual final line error. Bound range arithmetic by remaining line count, not an unchecked offset-plus-limit sum.
3. Select at most the requested range and 2000 lines. Add complete line contents only while the LF-joined payload stays within 51,200 bytes. Never show a partial line. If the next whole line does not fit, stop **before** it; the next offset is exactly that omitted line. No skipped remainder and no silent byte truncation, including when the omitted line is the last requested line.
4. If the first requested line alone exceeds 51,200 rendered bytes, return a teaching notice and no line payload. Retain the existing `[Line N is SIZE, exceeds the 50KB limit. Use bash: ...]` shape and size formatting. The suggested `sed -n 'Np' ... | head -c 51200` is explicitly a bounded preview, not a promise to retrieve the whole line. Keep this fallback instead of adding byte pagination. Shell-quote the resolved absolute path actually used for the read, after the existing path resolver has handled `~`, `@` path syntax, and any supported variants; do not quote the original requested path or independently reconstruct its resolution. Quoting a requested `~` would disable shell expansion, and a requested leading-hyphen name could be parsed as an option. The quoted absolute actual-read path avoids both problems. Verify the emitted command reads the same fixture for spaces, apostrophes, controlled-HOME `~` forms, supported `@` forms/variants, and leading-hyphen filenames. This is correctness of the existing hint, not a general shell-security redesign.
5. Emit the existing notice forms:
   - `[Showing lines S-E of T (50KB limit). Use offset=E+1 to continue.]` for a byte-limited prefix.
   - `[Showing lines S-E of T (2000 line limit). Use offset=E+1 to continue.]` for the hard line limit.
   - `[R more lines in file. Use offset=E+1 to continue.]` when only the requested range ends before EOF.
   Use evaluated integer values, not literal expressions. Choose bytes if a line was rejected for bytes; otherwise hard-line cap, otherwise requested-range remainder. `E` comes from accepted records, not rendered newline count. The oversized-first-line case has its own notice, never a fabricated `S-0` range.

Examples: `a\n` has one line; `\n` has one blank line; `a\n\n` has two lines. A small first line followed by a >50KB second line returns the first line and `offset=2`; the next call returns the oversized-line hint. A two-line requested range whose second line crosses the cap must have a notice, even though the old split-based count would still be two.

## 5. grep/find collection, counts, and errors

Keep argv construction, defaults/clamping, ignore behavior, and process launch architecture. In shared `runSearch`, check `signal.aborted` after asynchronous binary detection completes and before spawning or registering child/abort listeners or timers. This must cover both an already-aborted call and cancellation while binary detection is pending, for both grep and find. Return the existing cancellation error wording immediately, with zero child spawns and zero newly registered listeners or timers; do not wait for an abort event that has already fired. Buffer bounded raw stdout before decoding (or equivalently use an incremental decoder with a bounded partial-line buffer); no chunk-local splitting. A prefix Buffer implementation is the simplest option: retain at most 1 MiB, join/decode only at finalization, then form logical lines. Copy retained slices so a small view does not keep a giant incoming Buffer alive. Counters count all bytes observed, even after retention stops.

At exactly 1 MiB, do not stop or claim truncation. On the first byte beyond it, retain the portion up to the cap, mark collection incomplete, and send the existing SIGTERM/SIGKILL escalation once. Discard/drain later stdout; do not grow retention. A partial last record at the guard boundary is not a complete observed line, even if the retained text happens to end on a code-point boundary. Include only LF-terminated records from an incomplete collection. On natural EOF without collection truncation, include the nonempty final unterminated record.

For an uncapped normal result, total `T` is the exact number of stdout logical lines (including blank/context/separator lines, not “match count”). For a guard-stopped result, `C` is only the number of complete LF-terminated lines in the retained prefix. It is a proven lower bound, possibly zero; never add a fabricated line or infer an exact total from the bytes. Ignore any later received tail in that count. Display `S` is the number of whole lines actually emitted after **both** preview caps.

Emit the existing `[Truncated: REASONS. Narrow the search (subdirectory path, glob, or more specific pattern) instead of raising the limit.]` envelope, with this ordered reason grammar:

- Complete collection: `showing first S of T lines` whenever preview omits records.
- Incomplete collection: `showing first S lines; at least C complete lines observed; total unknown; 1048576-byte collection limit` (even when S=C=0).
- Append `, 50KB limit` if a whole next line was rejected for preview bytes.

The old line-limit reason remains compatible; the new incomplete grammar replaces invented `N+` totals. An oversized first result emits zero result lines and a truncation notice identifying the byte limit; do not emit `No matches`. No partial filename or match is presented as a complete result. Empty stdout from a successfully completed search may say `No matches for LABEL`; an interrupted/capped/error result may not.

stderr retention is independently capped at 2,000 raw bytes across the whole process, not per chunk, with total bytes observed tracked separately. If bytes are omitted, append `[stderr truncated: showing first 2000 bytes or fewer.]` on a separate line; “or fewer” covers safe decoding cuts. Decode only after collection and apply the rendered cap. On success, preserve a nonempty diagnostic as a `stderr:\n` section after stdout; on error include it after the error header. Whitespace alone is not proof of no stderr; do not let a diagnostic flood create an unbounded result. No stop/kill is triggered solely by the stderr display cap.

Handle `close(code, signal)` truthfully. Precedence: spawn error, explicit cancellation, timeout, deliberate stdout-guard stop, external signal/missing status, then numeric exit. Deliberate guard stop returns partial search output plus the mandatory unknown-total notice (not a false external-signal error). External signal: `Error: BIN terminated by signal SIGNAL.`; null code without signal: `Error: BIN ended without an exit status.` Both are tool errors. rg code 1 remains normal no-match; fd nonzero is an error (fd has no rg-style no-match exit 1). Other numeric failures return `Error: BIN exited with code N:` plus bounded stderr, never `No matches`. Keep existing cancellation/timeout error wording; preserving partial stdout on those search errors is not required in this change.

Bound persistent collection payload to 1,048,576 + 2,000 bytes plus fixed counters/flags; decoding/line views may temporarily allocate proportionally to that bounded prefix. Do not retain per-chunk strings or an unbounded pending line. Use fake children to verify one stop escalation, settlement once, and cleanup of timeout/escalation timers and abort listeners after close/error. This is local lifecycle correctness, not process-group redesign.

## 6. Bash bytes, artifacts, and termination

### Collection and preview

Keep raw Buffer-backed rolling tail and prefix stores per stream. Update total raw byte counters on every event, including after both stores are full. Compute `fullCapped = totalBytes > retainedPrefixBytes`, so exactly-full followed by one byte is correctly incomplete. Retain copies, not views onto arbitrarily large incoming chunks; avoid unbounded lists of chunks (coalesce/fixed-size segments as appropriate).

At rest, retained raw payload is at most `2 × (10,485,760 + 262,144) = 21,495,808` bytes. In-flight Node chunks, bounded copy buffers, UTF-8 decoding allocations, and JavaScript object overhead are additional; do not claim that number as an RSS ceiling. Do not build a second concatenated 20 MiB artifact string in memory. Write headers and retained byte segments sequentially to an exclusive, uniquely named temp file. No unbounded disk spooling or new options. Only create artifacts when a preview was truncated, as today.

Decode the retained tail safely, preserving UTF-8 across source chunks. If its first line was clipped by rolling retention, track that fact; if subsequent line limiting discards the clipped record entirely, it is no longer a partial displayed line. Apply last-500-logical-lines then last-51,200-rendered-bytes limits. Byte truncation may retain a leading partial line, unlike read/search. Add `[STREAM preview starts within a line.]` for stdout/stderr only when the actual displayed first record is partial. Preserve trailing spaces and LF, and show whitespace-only streams instead of `(no output)`. `(no output)` applies only when both source byte counts are zero. Stream headers retain `stdout:` / `stderr:`.

Any discarded source bytes/lines or boundary bytes must produce the ordinary truncation notice. Per-stream limits permit up to 102,400 rendered payload bytes, plus framing/notices; do not silently change to 51,200 aggregate.

### Artifact truthfulness

Keep the current `$ COMMAND`, `[stdout]`, `[stderr]` framing, but write each retained raw prefix unchanged; framing is not a merged chronological transcript. Include a footer for each capped stream:

`[STREAM artifact incomplete: retained first R of O observed bytes (10485760-byte per-stream limit).]`

Here `R` is the actual retained byte count and `O` is the total received by finalization. A normal completion with both prefixes complete may use the existing `Full output saved to PATH` sentence. “Full” means all bytes received on both streams, not byte-identical stdout without framing.

Use the existing outer notice prefix and teaching suffix, with exactly these alternatives in its middle:

- Normal completion, all bytes retained: `Full output saved to PATH` (unchanged).
- Any artifact prefix capped: `Partial output saved to PATH (artifact prefix capped; per-stream limit 10485760 bytes)`.
- Command timeout/abort/signal/missing status but all observed bytes retained: `Partial output saved to PATH (command interrupted; all observed bytes retained)`.
- Both interruption and prefix capping: `Partial output saved to PATH (command interrupted; artifact prefix capped; per-stream limit 10485760 bytes)`.

All use `[output truncated: only the tail is shown above. MIDDLE — read it with the read tool if you need more (tip: pipe through head/tail or narrow the grep to keep output small)]`. Do not call an interrupted command's artifact the full intended command output. Store the interruption status in the artifact footer as well.

A create/write/close failure must not advertise a recoverable path. Emit `[output truncated: only the tail is shown; saving the output artifact failed (tip: pipe through head/tail or narrow the grep to keep output small)]`. Clean up only the partial file owned by that invocation, best effort. Concurrent invocations must not collide; timestamp-plus-pid alone is insufficient. Temp files are runtime artifacts, not user files; tests own and remove theirs.

### Exit truthfulness

Use both close arguments. Preserve numeric normal exits, including nonzero `exitCode` and `isError: false`. For an otherwise unexplained signal, return `isError: true`, no invented numeric exitCode, and `Error: command terminated by signal SIGNAL. Partial output:` followed by formatted output. For null code/no signal use `Error: command ended without an exit status. Partial output:`. Preserve existing timeout and abort wording/precedence. A pre-aborted call must not launch a child. Ensure no late event repeats formatting/artifact creation after settlement; clear owned timers/listeners at settlement. Do not add process-group management or redesign command execution.

## 7. ls and edit advice

`ls` treats successful `readdir` names as the listing snapshot. Failed `stat` must not delete a name. On success, retain directory `/` suffix behavior (including symlinks to directories). On failed `stat`, emit the original bare name, count it against entry and byte caps, and increment a displayed-unknown counter. Dangling symlinks and names disappearing between calls are therefore visible. Only a zero-name `readdir` may produce `(empty directory)`.

Add one independent notice after existing cap notices when needed:

`[Directory type unavailable for N displayed entries; names shown without a directory suffix.]`

Count only stat failures whose names were actually emitted; do not claim to have examined omitted names. Preserve ordering, whole-entry byte caps, entry-limit advice, and cancellation behavior. No requirement to add per-entry error annotations or a new symlink type.

In `edit-diff.ts`, remove the misleading final CRLF sentence from zero-match advice; keep advice to reread current content and copy exact whitespace with unique context. Do not put normalization claims in the pure `applyEdits` helper, which itself still performs exact matching. Test the LF/CRLF normalization through `createEditTool`, where it actually happens. Do not change matching, atomicity, BOM handling, line-ending preservation, or model receipts. Use `write`'s existing empty/terminal-LF receipt counts as the consistency reference; no write output change is needed.

## 8. Display compatibility

Update `src/repl/tool-presentation.ts` in the same implementation batch as notice producers. Use anchored grammars for:

- Existing read pagination plus the oversized-line fallback (currently not promoted).
- New search unknown-total reason, zero displayed lines, stderr cap notice, and existing reason variants.
- New ls unknown-directory-type notice.
- Bash complete/partial/failure artifact variants, per-stream preview-fragment notice, and artifact capped-stream footer.
- Bash signal/missing-status error headers and fractional timeout seconds (existing timeout accepts fractions).

Keep **all old accepted forms**, including old search `N+`, empty reason, old artifact-failure wording, and `[full output itself capped at 10MB]`, for persisted-history replay. Producers stop emitting misleading forms; replay must not reinterpret old records as if their capture was fixed. New error headers preserve failure status and metadata when body retention hides them. Do not broaden recognition to arbitrary lines mentioning “truncated”, paths, or signals. Existing textual status spoofability is explicitly not solved by a schema redesign here.

Test producer output through `outputBlock` with >1000 filler lines and in replay mode; assert exact promoted notice/status text. Preserve unrelated task/MCP grammars and edit's display-only diff behavior. No provider/loop/persistence changes are necessary.

## 9. Deterministic verification plan

No real model APIs, credentials, user configuration, or user files. All fixture files and runtime artifacts belong to test-created temp directories. Prefer mocked `node:child_process` children (EventEmitter plus controlled Buffer streams), isolated module mocks for binary detection/filesystem failures, and fake timers for lifecycle tests. No sleeps, terminal dependencies, chmod permission assumptions, or dependence on installed rg/fd in the new regressions. Existing optional rg/fd smoke tests may remain.

### Required cases

1. **Read (`test/tools.test.ts`, optionally a focused new file):** empty, `a`, `a\n`, `\n`, `a\n\n`, CRLF; offsets at/beyond EOF; invalid 0/negative/fraction/NaN/infinity/string/unsafe integer and schema constraints; 2000/2001 lines; exactly 51,200 joined bytes and one byte over; multibyte boundary; small line then oversized line; byte cut formerly inside the final selected line with `limit=2`; blank first line at cap; paginate all accepted lines without omission/duplication. Verify oversized-path hints for spaces, apostrophes, controlled-HOME `~` paths, supported `@` path syntax and variants, and leading-hyphen filenames. Execute each emitted bounded-preview command and assert its bytes equal the expected prefix of the same fixture actually read, not merely that the hint contains quote characters; assert no file mutation. Keep HOME changes isolated to the test process/mock and restore them afterward. Check image regressions after moving validation.
2. **Search (new deterministic runner tests, retain `test/search-tools.test.ts`):** the same logical output emitted as one chunk, byte-sized chunks, and adversarial UTF-8/LF partitions must yield identical text/counts. Include blank lines, context separators, final newline/no newline, a huge single line, cap-crossing chunk whose prefix still fits, exactly 1 MiB then EOF versus one more byte, retained prefix ending mid-line or mid-code-point, and observed complete-line lower bound zero. Verify `S` after line/byte limits; no manufactured `+1`; no “No matches” on omitted nonempty output. Feed many stderr chunks and one huge chunk: total retained/rendered diagnostics stay bounded and one notice appears. Exercise rg no-match, fd code 1 error, ordinary failures, signal/null status, guard-induced close, timeout/abort, and error followed by close; assert settlement/kill counts and timer cleanup. For both grep and find through shared `runSearch`, test an already-aborted signal and an abort during deferred asynchronous binary detection: resolve detection, assert the existing cancellation error, zero spawn calls, zero child/abort listener registrations, and zero timeout/escalation timer creation (not merely eventual cleanup).
3. **Bash (new deterministic stream tests plus `test/tools.test.ts` smoke tests):** byte/chunk invariance; valid 2/3/4-byte UTF-8 crossing each boundary; whitespace-only/trailing whitespace preservation; 500/501 logical lines with and without terminal LF; each stream independently below/at/above 51,200, 262,144, and 10,485,760 bytes. Include exactly-full prefix plus a later byte, a single oversize chunk, both streams capped, and a rolling-tail fragment later removed by line limiting. Assert rendered per-stream byte caps, exact total/retained counters, partial-line tags, and artifact payload raw bytes. Use bounded generated buffers, not shell floods. Verify complete/partial/interrupted artifact wording, sequential bounded writes, unique concurrent artifacts, create/write/close failure without promised path, and owned-file cleanup. Exercise code 0/3, signal, null/no signal, pre-abort, timeout/abort with output, and late close after error.
4. **ls (`test/ls-tool.test.ts` plus isolated stat mock tests):** temp dangling symlink, symlink to directory, injected EACCES/ENOENT, all stats failing, mixed types, cap reached before an unknown entry, and bytes cap before unknown entry. Names never disappear solely due to stat failure; unknown count includes displayed entries only; empty marker requires truly empty snapshot. Existing sort/cap/cancel tests remain.
5. **Edit/write (`test/edit-write.test.ts`):** multiline LF `oldText` matching CRLF+BOM input, replacement preserving CRLF+BOM, true zero-match message no longer demanding CRLF, unchanged-file-on-failure; exact compact model receipt versus display diff. Verify unchanged write counts for empty/terminal-LF fixtures.
6. **Presentation (`test/tool-presentation.test.ts`, integration suite):** every new notice and every legacy notice survives body retention; statuses for signal/null/fractional timeout remain failed; near-match arbitrary output is not promoted; replay of legacy forms remains readable; edit model receipt stays separate from display.

After implementation and independent code review, run targeted suites, then `npm run typecheck`, `npm run test`, and `npm run lint`. Report exact results, skipped tests, and any pre-existing failures; do not claim green verification from this design-only change. If formatter checks unrelated files, do not rewrite them as part of this scope.

## 10. Review gate and implementation order

The parent agent obtains an independent adversarial review of this document before any implementation. Review must specifically challenge: terminal-LF/empty-line semantics, byte-vs-rendered limits, guard counts and external signals, artifact completeness and bounded retention, preservation of compact model receipts, and notice-parser replay compatibility.

After the design review closes: implement/test small byte/line helpers and read; search collector/diagnostics; bash collectors/artifact wording; ls/advice; and presentation compatibility alongside each producer change. An independent code review is warranted because these changes combine asynchronous subprocess events, bounded buffers, model-visible recovery instructions, and replay grammar. No merge/commit or edits outside this worktree are part of this design task.
