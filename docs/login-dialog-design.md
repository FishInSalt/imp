# /login Exclusive Dialog Design (feature/login-dialog)

Status: rev7 (independent final-gate review: two P2 spec-accuracy fixes —
LineInput capability seam named, pi-tui Ctrl+C claim corrected, oauth
test timing pinned; P3 notes folded)

## 0. Problem

Dogfooding /login reported "steps jump around". The audit (2026-09-25) found
the state machine correct but the presentation assembled from three
unrelated surfaces (activity spinner + ask line + editor), which interact
badly:

- **P1**: no-arg `/login` always enters the guarded long-op state
  (`loginNeedsGuard`, commands.ts:832), so the 15-minute-semantics spinner
  `⠋ waiting for login…` spins over a picker and then over the api-key
  secret prompt — while the user is just typing a key for seconds.
- **P2**: the secret prompt renders as a bare ask line above the queue/hint
  rows; the user actually types in the bordered editor below. Weak visual
  association, no cancel affordance next to the input.
- **P3** (lesser): `/logout` shows no indicator at all while `/login` spins
  heavily — inverted weight perception. Intentional; not fixed here.

pi solves this with an **exclusive LoginDialog**: a bordered dialog that
replaces the editor, owns focus and keys for the whole flow (URL/code
display, api-key input, waiting message, Esc cancel), then restores the
editor. Every step renders in one place. Decision (user, 2026-09-25):
align with pi's dialog directly (plan B) rather than patch the spinner.

## 1. Reference

- pi `LoginDialogComponent` —
  `packages/coding-agent/src/modes/interactive/components/login-dialog.ts`
  (~250 lines): Container + DynamicBorder top/bottom + title + dynamic
  content area + always-present `Input` (pi-tui). Esc → abort + reject
  pending input + `onComplete(false, "Login cancelled")`. Enter resolves
  pending input via `inputResolver`. States: showAuth (URL + Cmd+click),
  showDeviceCode (URL + code), showWaiting, showPrompt (api key),
  showInfo/showDetails/showProgress.
- pi wiring — `interactive-mode.ts:5776` (ambient), `:5803`
  (showApiKeyLoginDialog), `:5934` (showLoginDialog oauth): clear
  editorContainer, add dialog, `setFocus(dialog)`; restore editor in both
  settle and error paths. Verified parity detail: restore runs BEFORE
  the status line (`restoreEditor()` at ~5829-5834 precedes
  `completeProviderAuthentication` at 5838, which emits the status).
- pi `DynamicBorder` — 25 lines; **not** exported by pi-tui; imp vendors
  its own (no theme dependency — dim border).
- pi-tui `Input` — **is** exported (`node_modules/@earendil-works/pi-tui/
  dist/index.js`): single-line, Focusable, `onSubmit`/`onEscape`,
  horizontal scrolling, kill ring, undo. Same component pi's dialog uses.

## 2. Design

### 2.1 `LoginDialog` component (new, `src/repl/login-dialog.ts`)

```
────────────────────────────────────
  Login to Z.AI                      ← title (accent/plain bold)
                                     ← spacer
  Enter Z.AI API key                 ← state content
  [Input.......................]     ← pi-tui Input
  (esc to cancel, enter to submit)   ← dim key hints
────────────────────────────────────
```

- `Container` subclass implementing pi-tui `Focusable`; forwards
  `focused` to the inner `Input` (IME cursor positioning — same as pi).
- Own `AbortController`; `signal` exposed — codex-auth's poll and fetches
  already take a signal (unchanged).
- Key handling (`handleInput`): Esc → `cancel()` (abort controller +
  reject pending prompt + resolve dialog as cancelled); everything else →
  `input.handleInput(data)` (Enter/Escape also flow from Input's own
  onSubmit/onEscape).
- States imp needs (subset of pi's):
  - `showPrompt(message, placeholder?)` → Promise<string> — api-key entry.
    Enter with NO pending resolver is a no-op (pi null-checks
    inputResolver; rev7 P3): the always-present Input cannot misfire
    during deviceCode/waiting states.
  - `showDeviceCode({verificationUri, userCode})` — URL as OSC-8 hyperlink
    + `Cmd+click to open` hint + code line. **No auto openBrowser** (pi
    opens it; imp decision D1 — no external side effects from a view).
  - `showWaiting(message)` — dim line + `(esc to cancel)` hint (the OAuth
    poll replaces the spinner's "something is happening" role).
  - `showMessage(line)` — one-off status lines (saved/switch-hint tail).
  State transitions **replace** the content area (pi clears
  contentContainer between states; review P3-6): deviceCode renders
  URL+code, waiting replaces it once rendered — no append-stacking.
  imp's api-key flow = prompt only; oauth = deviceCode + waiting; no
  imp state needs both URL and input, so the always-present-Input with
  changing content is sound for imp's subset.
- Imp's tui.ts boundary gains: `Input`, `Focusable` re-exports
  (DynamicBorder is imp-local: 6 lines over `Text(dim("─"))`).
- Secrets note: pi renders the key unmasked in the Input and replaces it
  with `> value` after submit; imp keeps exactly that (typed key visible
  while typing — dogfood reports never flagged it as a problem; the file
  write is 0600).

### 2.2 Shell integration: the dialog rides the **selector contract**

`TuiShell` learns `openLoginDialog(build: (dialog) => Promise<void>)`:

- Registers the dialog as the live **selector**
  (`this.selector = { teardown, filterKey }`, shell.ts:822 — same field
  select() uses): SIGINT (shell.ts:430) and stdin-end (shell.ts:439) and
  close() (shell.ts:920) tear it down (finish-as-cancel), hint row hides,
  and the machine's interrupt key router already yields Ctrl+C to a live
  selector (shell.ts:323-328) and swallows Ctrl+D (shell.ts:325).
- The dialog is added to `askContainer`; focus moves to it
  (`tui.setFocus(dialog)`). The main editor stays mounted (so the layout
  doesn't jump) but has no focus; typed keys land in the dialog's Input.
- **Teardown is select()'s FULL finish() sequence** (shell.ts:752-776),
  **including its `settled` once-guard** (shell.ts:753 — teardown is
  reachable from five racing sources for a dialog: SIGINT 430, stdin-end
  439, close() 920, the dialog's own Esc, and its Ctrl+C→cancel mapping;
  a double-finish would double-run the pendingSelects drain and steal a
  second queued entry; review P1-2): `settled` gate → `selector=null` →
  `updatePlaceholder()` → removeChild → `setFocus(editor)` (null-guard:
  teardown may fire after close() began detaching — skip when editor is
  null; review P2-4) → requestRender → **re-show pendingAsks[0] if no
  askLine is live** (shell.ts:761-765) → resolve → **`pendingSelects.shift()`
  and run it** (shell.ts:769-773). The last two are load-bearing: a
  select() or ask() arriving while the dialog is open is held (select
  queues at shell.ts:729-731; ask holds while selector ≠ null at
  shell.ts:657, secret at shell.ts:668), and WITHOUT the drain steps a guardian confirm
  queued mid-dialog hangs forever.
- **Re-entrancy** (review P1 #4): `openLoginDialog` while
  `this.selector !== null` (a picker or another dialog is live) queues
  like select() does — pushes a `pendingSelects` entry (closure
  re-invocation, same as treeSelect's queue at shell.ts:846; the first
  call's promise stays pending until the queued run finishes) that
  re-runs it after the current selector finishes. It never clobbers the
  live selector. Return value `"unavailable"` fires only when `tui ===
  null || closed` (shell in shutdown). **A queued entry drained by
  close()'s drain (shell.ts:923-926) resolving "unavailable" is a
  silent no-op — NOT a fallback trigger** (falling back to the legacy
  path mid-shutdown would print the picker-less error during teardown;
  review P2-5): the command treats unavailable-after-drain as done.
- **Ctrl+C as a keypress** (review P1 #3, corrected rev7): raw-mode
  Ctrl+C is data, not SIGINT; shell.ts:323-324 passes it to the focused
  component. pi-tui's DEFAULT KEYBINDINGS already bind ctrl+c to
  `tui.select.cancel` (keybindings.js:78-81) and `Input.handleInput`
  matches it → `onEscape` — so Ctrl+C reaching the Input cancels via the
  dialog's onEscape wiring. The dialog's own Ctrl+C→cancel() mapping is
  kept as an explicit, idempotent duplicate (settled guard) — belt for
  the keybinding-table path in case focus forwarding ever misses.
- **Deletion scope is shell-conditional** (rev3 P0-9): the machine pieces
  die only on shells that HAVE the dialog. `loginNeedsGuard(line)` keeps
  existing but becomes shell-aware: `loginNeedsGuard(line, shell)` →
  `!hasDialog(shell) && (picker-may-land-on-codex || oauth-target)` —
  i.e. exactly the current predicate, suppressed on dialog shells. On
  the TUI the guard arm never fires (dialogOpen + exemption instead);
  on the readline/piped shell NOTHING changes: the 15-minute OAuth poll
  still takes the guarded state, Ctrl+C still aborts via onLongOpAbort
  (commands.ts:846-871 wiring STAYS for the fallback path), typed lines
  still queue. The "fallback unchanged" claim in §2.3 is now literally
  true.
- **Deleted from the machine (dialog shells only)** (the payoff) — the
  mechanism: `loginNeedsGuard(line, shell)` returns false on dialog
  shells → `stateful` (repl.ts:500-505) is false → the arm at
  repl.ts:513-514 (`name === "login"`) is unreachable; no code edit to
  runCommand is needed. Concretely gone on TUI: the login
  longOpLabel/spinner arm and the dialog path's onLongOpAbort usage.
  A second `/login` while a dialog is open cannot be typed (editor has
  no focus). `longOpLabel` itself SURVIVES for /compact, /tree, and the
  fallback login (repl.ts:1126-1139, :1313; commands.ts:1190/1211/1247/
  1267/1804/1811). `/compact` and `/tree` keep the guarded state
  unchanged.

### 2.2.1 Machine-level mutual exclusion (review P0 #1)

Owning the keys is NOT machine exclusion. The guard state did more than
presentation — it was the machine's mutex (repl.ts:497-504 comment):
"typed lines queue, /new refuses". Under a naive dialog the state is
idle while `dispatchCommand` is still awaited, so an extension/skill
`submitPrompt` (repl.ts:1286) would start a concurrent model turn beside
a live OAuth poll; a queued-line flush from a preceding run interleaves
the same way.

Fix: the machine gains a **`dialogOpen` boolean**. Wiring:

**Set/clear around the dispatch, with the authorized exemption.**
runCommand recognizes a dialog-capable `/login` line before awaiting
(the same shape as today's `loginNeedsGuard(line)` predicate, renamed
`loginUsesDialog` — true when the shell has a dialog AND the line is
no-arg or a login target; on the TUI that is every /login line): if so,
set `this.dialogOpen = true` **immediately before the try that wraps
dispatchCommand** (rev3 P3-16: after warmup — a warmup throw returns at
repl.ts:488-490 before the try and must never leave the flag set), clear it
in an **unconditional** arm of the same finally (rev2 pinned it inside
the `stateful`-gated block, which rev3 deletes — for /login that block
never runs and the flag would stick true forever; review P1-3).
  Residual window (rev4 P3-C): between the flag set and the wrapper
  registering the selector, a SIGINT takes the machine's idle interrupt
  path (a note, no abort target) — accepted as benign; the window is
  synchronous code up to the first await.

**The dispatch must not reject itself** (rev2 P0-1): `dialogOpen=true`
would make the widened `isActive()` refuse `/login` — its own entry
point. The existing code solves exactly this trap with
`authorizedStateful` (repl.ts:1281: `isActive: () => !authorizedStateful
&& (running || compacting)`; comment repl.ts:519-521). The dialog arm
reuses it: `authorized = loginUsesDialog(line)`, and
`isActive: () => !authorized && (running || compacting || dialogOpen)`.
The flag is set only when authorized — the opening dispatch is exempt,
every later command sees the block.

Turn-start paths check it:
- `submitTurn` and `enqueuePrompt`: refuse with the renderer note
  `▪ /login is open — finish or cancel it first (esc)` — same refusal
  shape as /new-during-compaction. All other turn-start paths funnel
  through these two (flushQueue, bang re-flush, submitPrompt wiring
  delegate; mcp.onRunStart and warmup fire only inside submitTurn).
- `allowedDuringRun: false` commands — /new /fork /resume /tree /sessions
  /logout — refuse via the existing dispatch guard (commands.ts:1850)
  through the same widened isActive. runBangCommand is not checked but
  unreachable mid-dialog (needs a typed `!` line; editor owns no keys;
  alt+enter is gated on selector === null, shell.ts:338) — noted as a
  residual for any future non-editor input path.

Editor lines cannot queue (editor owns no keys), so the queue is not a
path. SIGINT still tears the dialog down first (selector precedence at
shell.ts:430), so the mutex is escapable exactly one way. Deliberately
NOT reusing state = "compacting" for this: compacting carries spinner
and queue semantics this batch is removing; `dialogOpen` is a separate
boolean touched only by the turn-start paths and runCommand.

The dialog's teardown is owned by the **openLoginDialog wrapper**, never
the command body (rev3 P1-10): when `build` resolves (success), when
`build` rejects (error — after the command maps it to renderer.error or
silent cancel), or on dialog-initiated cancel — the wrapper runs the
finish sequence (idempotent via the settled guard). The command body
only drives dialog states through LoginDialogView; it never finishes.
Test 1/3/4 assert teardown in all three cases.

**Visible chrome while the dialog owns keys** (rev7 P3): the main
editor stays mounted WITH its draft — a half-typed line renders below
the dialog (same as every picker today; Editor.render does not gate
content on focus, editor.js:416-419 — only the cursor marker is
focused-gated). The hint row clears (updatePlaceholder's selector≠null
branch). Viewport overflow follows pi-tui's doRender scrolling
(extractCursorPosition reads the bottom `height` lines) — no special
handling, same as a long picker.

### 2.2.2 No-arg /login and the command-body rewrite (rev3 P2-11/12)

**No-arg /login**: still opens the existing select() provider picker
first; the pick lands on a target, THEN the dialog opens for that
target (two sequential selectors — mechanically sound: the picker's
finish drains pendingSelects, a dialog queued behind it opens then).
`loginUsesDialog` returns true for no-arg (the pick can land on codex),
so `dialogOpen=true` spans the picker too — harmless: the picker
already owns keys, and refusing turns during the pick is correct
anyway.

**Dialog-path command body** (replaces loginToTarget's TUI arm):

```
const outcome = await ctx.openLoginDialog({
  title: `Login to ${target.name}`,
  run: async (dialog) => {
    if (target.method === "oauth") {
      await loginCodex({
        authPath: ctx.authStorePath,
        authBaseUrl: ctx.codexAuthBaseUrl ?? process.env.IMP_CODEX_AUTH_BASE,
        signal: dialog.signal,             // dialog's own AbortController
        onDeviceCode: (p) => dialog.deviceCode(p), // was renderer.note
      });
      // success tail renders AFTER openLoginDialog resolves — see below
    } else {
      const key = await dialog.prompt(`Enter ${target.name} API key`);
      if (key === null) throw new Error("Login cancelled"); // empty submit; Esc REJECTS (see below)
      saveApiKey(target.family, key, ctx.authStorePath);
      // success tail renders AFTER openLoginDialog resolves — see below
    }
  },
});
// success tail (pi parity: restore-then-status) — rendered HERE, after
// the dialog has resolved and torn down, via the same renderer calls the
// legacy path uses: renderer.status(`Saved API key for ${target.name}`)
// or `Logged in to ${target.name}`) + the family-differs switch hint as
// renderer.note — dialog.message is in-flow progress ONLY, never the tail.
// "cancelled" (Login cancelled) → silent; other throws → renderer.error
// with imp's teaching prefix; "done" → footer refresh via runCommand's
// existing finally refreshFooter
// Prompt-cancel channel (rev4 P3-D, unified): Esc during prompt REJECTS
// prompt() with Error("Login cancelled") — the same channel as every
// other cancel — so run()'s catch surfaces it as "cancelled"; prompt()
// never resolves null on cancel (null only for a submitted EMPTY line,
// which the caller treats as cancel the same way the legacy path does).
```

The legacy loginToTarget (spinner note + ctx.secret + renderer.status)
stays verbatim for the fallback path.

### 2.3 Command layer: `ctx.loginDialog` seam

**The machine-side capability seam** (rev7 P2): `LineInput`
(line-input.ts) gains the optional method
`openLoginDialog?(options: LoginDialogOptions): Promise<"done" | "cancelled" | "unavailable">` —
the same optional-method pattern as select/secret/treeSelect
(line-input.ts:107+). Every reader derives from it:
- `runCommand`'s predicate: `loginUsesDialog(line) =
  this.input.openLoginDialog !== undefined && (no-arg || known target)`
  — threaded at repl.ts:505 as a boolean; `loginNeedsGuard(line,
  hasDialog)` keeps its pure-predicate form for testability.
- The ctx binding (repl.ts:1320-1328 pattern):
  `const openLoginDialog = this.input.openLoginDialog?.bind(this.input);
  if (openLoginDialog !== undefined) ctx.openLoginDialog = openLoginDialog;`
- TuiShell implements it; ReadlineShell does not — the fallback falls
  out of the same seam, no flags anywhere.

`CommandContext` gains:

```ts
/** Opens an exclusive login dialog (TUI). Absent on shells without one —
 *  commands fall back to select()/secret() (pick-then-prompt) or text.
 *  "unavailable" only when the shell is in shutdown (tui null/closed). */
openLoginDialog?: (options: LoginDialogOptions) => Promise<"done" | "cancelled" | "unavailable">;
```

`LoginDialogOptions`: `{ title: string; run: (dialog: LoginDialogView) => Promise<void> }`
where `LoginDialogView` is the narrow interface the command sees:
`prompt(message, placeholder?)`, `deviceCode(info)`, `waiting(msg)`,
`message(line)`, `signal`. run() throwing `Error("Login cancelled")`
propagates as `"cancelled"` (silent, pi parity); other errors surface as
`renderer.error` by the command.

- `/login` flow: if `openLoginDialog` exists → dialog path per §2.2.2
  (both api-key and oauth targets; no-arg = picker then dialog). Else →
  current select()/secret() path (readline shell, hermetic dispatch
  tests) — unchanged behavior INCLUDING the guarded OAuth state
  (§2.2's shell-conditional deletion), tests keep passing.
  **Piped-mode note** (review P2 #6): `imp < file` resolves the readline
  shell which HAS secret() — a scripted `/login zai` consumes the NEXT
  script line as the key (input.ts settleAsk). Pre-existing behavior,
  unchanged here, now documented.
- `loginNeedsGuard(line, shell)` replaces the current argument-less
  form (rev4 P0-A): the function KEEPS existing, shell-aware — `false`
  on dialog shells (the dialog + dialogOpen own the flow), exactly the
  current predicate elsewhere. Its unit test re-pins BOTH arms: dialog
  shell → always false; fallback shell → the current truth table
  (picker/codex true, zai/Z.AI false). The runCommand guard arm
  (repl.ts:505) is untouched — it simply never fires on dialog shells.
- `/logout`: unchanged (pi's logout is a selector too).

### 2.4 What the machine keeps doing during a dialog

Nothing. That is the point: the state stays `idle` (no compacting state,
no spinner, no queue semantics interplay). Codex poll cancellation is the
dialog's own AbortController via Esc/SIGINT — not the machine's
double-Ctrl+C path. `/exit` and Ctrl+D: the selector-open key routing
already swallows Ctrl+D (shell.ts:325) and SIGINT tears the selector down
first (shell.ts:430). A running OAuth poll aborted at teardown resolves
"Login cancelled" → silent.

## 3. Test plan

New `test/login-dialog.test.ts` (TUI-level, FakeTerminal):

1. api-key flow: `/login zai` → dialog renders (border, title, prompt,
   input, hints) → type + Enter → dialog tears down, THEN
   renderer.status("Saved API key for Z.AI") lands in the transcript
   (post-restore ordering, rev4 P2-B) — pin both the transcript line and
   the dialog-gone frame; the typed key never enters input history.
2. Esc during prompt: resolves cancelled, nothing stored, editor restored.
3. oauth flow with the local fake device-code server (reuse
   repl-commands.test.ts:93's fixture): device code + URL + waiting
   render; poll completes → logged-in message; dialog teardown.
4. Esc during the oauth poll: silent cancel ("Login cancelled" not
   printed), no credential written, editor restored, and a follow-up
   `/login` works (state is truly idle — no guard residue).
5. SIGINT mid-poll: same as Esc (selector teardown path). PLUS
   **Ctrl+C as a keypress** (\x03 data, not signal): cancels the dialog
   (review P1 #3).
6. Second `/login` while a dialog is open: keystrokes land in the
   dialog's input; no machine command dispatch. Editor draft (not queue
   — nothing can queue while the editor owns no keys; review P3 #10) is
   intact after teardown.
7. `/compact` and `/tree` still take the guarded state, and a
    fallback-shell `/login openai-codex` does too (regression pins for
    the shell-conditional guard; see test 15).
8. **Extension/skill `submitPrompt` during an open dialog** (review P0):
   refused with the ▪ note, no turn starts, dialog unaffected.
9. **A select()/ask() arriving mid-dialog** (guardian confirm): held;
   after dialog teardown it renders and resolves (hang-refusal pin).
10. **close() during the dialog** (shell.ts:920 path) and **stdin-end
    mid-poll**: dialog settles (cancelled), no unhandled rejection,
    process teardown clean. PLUS: a **queued dialog entry drained by
    close()** resolves unavailable and is a silent no-op (no error text
    during teardown; review P2-5).
11. Footer after login: refreshFooter ran (model family hint segment
    correct after a same-family login).
12. Focused-forwarding unit assertion: dialog.focused=false →
    input.focused=false (IME cursor edge).
13. `dialogOpen` refusal pins: a bare prompt line typed… cannot happen
    (editor has no focus) — instead assert via `enqueuePrompt` and an
    `allowedDuringRun:false` command dispatched mid-dialog (the two
    reachable paths). PLUS: the **authorized exemption** — the /login
    dispatch itself passes its own guard (rev2's P0-1 regression pin).
14. A **live askLine + dialog coexisting** in askContainer (render-order
    pin: dialog below the ask; the ask stays unanswerable until teardown
    re-shows it — review P3-7).
15. **Fallback OAuth mutex pin** (rev3 P0-9): dispatch-level — a
    no-dialog ctx running `/login openai-codex` still takes the guarded
    state (isActive refuses a concurrent command; onLongOpAbort wired).
16. **Queued dialog re-run** (rev3 P3-14): a second openLoginDialog
    queued behind a live selector re-runs after teardown (not drained
    by close, not clobbered).

Updated: the 3 existing TUI login tests (secret-prompt render/store/Esc)
rewrite to the dialog path; dispatch-level login tests keep the fallback
path (they never had a dialog). `loginNeedsGuard` test replaced per §2.3.

Gates: full vitest, typecheck (src+test), biome, build.

**Timing conventions** (rev7 P2): codex-auth's poll floor is 1000 ms
(codex-auth.ts:261 `Math.max(intervalSeconds, 1) * 1000` — even the
fake server's `interval: 0` waits 1 s before the first poll). Every
oauth test (3, 4, 5, 10) must use `frameContains` with an explicit
≥ 5000 ms budget, not the 2 s default (the M15 CI-flake lesson).

## 4. Risks

- **Focus contract**: imp's TUI focus is editor-or-pickers today; the
  dialog is a third Focusable. Mitigated by riding the selector contract
  (single `selector` field, teardown semantics identical) + test 6.
- **Input inside a bordered container**: pi-tui Input is used by pi the
  same way; the only risk is imp's tui.ts boundary missing a re-export —
  trivial.
- **Legacy shells**: no dialog → fallback path preserved; zero behavior
  change there (pinned by existing tests).
- **Scope creep guard**: pi's dialog has select-auth-type, manual-code,
  info-links states for providers imp does not have. imp implements
  exactly the four states in §2.1 and stops.

## 5. Ledger plan

Size accounting (rev7 P3): ~300 source lines (component ~180,
openLoginDialog wrapper ~60, command body + ctx/LineInput types ~60,
tui.ts re-exports ~5) and ~400-600 test lines for the 16-item plan;
net against ~80-100 machine-special-case lines that die on the TUI path.

PROJECT_PLAN.md entry `#login-dialog` after merge, including the process
note from this batch's audit: when two candidate plans differ by an order
of magnitude, both get full cost accounting before recommending one.
