# /login Exclusive Dialog Design (feature/login-dialog)

Status: proposed

## 0. Problem

Dogfooding /login reported "steps jump around". The audit (2026-09-25) found
the state machine correct but the presentation assembled from three
unrelated surfaces (activity spinner + ask line + editor), which interact
badly:

- **P1**: no-arg `/login` always enters the guarded long-op state
  (`loginNeedsGuard`, commands.ts:830), so the 15-minute-semantics spinner
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
- pi wiring — `interactive-mode.ts:5773` (ambient), `:5803`
  (showApiKeyLoginDialog), `:5923` (showLoginDialog oauth): clear
  editorContainer, add dialog, `setFocus(dialog)`; restore editor in both
  settle and error paths.
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
  - `showPrompt(message, placeholder?)` → Promise<string> — api-key entry
  - `showDeviceCode({verificationUri, userCode})` — URL as OSC-8 hyperlink
    + `Cmd+click to open` hint + code line. **No auto openBrowser** (pi
    opens it; imp decision D1 — no external side effects from a view).
  - `showWaiting(message)` — dim line + `(esc to cancel)` hint (the OAuth
    poll replaces the spinner's "something is happening" role).
  - `showMessage(line)` — one-off status lines (saved/switch-hint tail).
- Imp's tui.ts boundary gains: `Input`, `Focusable` re-exports
  (DynamicBorder is imp-local: 6 lines over `Text(dim("─"))`).
- Secrets note: pi renders the key unmasked in the Input and replaces it
  with `> value` after submit; imp keeps exactly that (typed key visible
  while typing — dogfood reports never flagged it as a problem; the file
  write is 0600).

### 2.2 Shell integration: the dialog rides the **selector contract**

`TuiShell` learns `openLoginDialog(build: (dialog) => Promise<void>)`:

- Registers the dialog as the live **selector**
  (`this.selector = { teardown, filterKey }` — shell.ts:811): SIGINT/close
  tears it down (finish-as-cancel), hint row hides, a second picker cannot
  open on top (pendingSelects FIFO), and the machine's interrupt key
  router already yields Ctrl+C/Esc to a live selector (shell.ts:313).
- The dialog is added to `askContainer`; focus moves to it
  (`tui.setFocus(dialog)`). The main editor stays mounted (so the layout
  doesn't jump) but has no focus; typed keys land in the dialog's Input.
- Teardown (cancel or completion): remove from container, `selector=null`,
  `setFocus(editor)`, `updatePlaceholder()` — the exact `finish()` sequence
  of select() (shell.ts:748-769).
- **Deleted from the machine** (the payoff): the `login` guard special-case
  in runCommand (repl.ts:505), `longOpLabel "waiting for login…"`
  (repl.ts:514), and `onLongOpAbort`'s login supersede comment block —
  a second `/login` while a dialog is open is **impossible to type**
  (editor has no focus), so the supersede path dies with the guard.
  `/compact` and `/tree` keep the guarded state unchanged.

### 2.3 Command layer: `ctx.loginDialog` seam

`CommandContext` gains:

```ts
/** Opens an exclusive login dialog (TUI). Absent on shells without one —
 *  commands fall back to select()/secret() (pick-then-prompt) or text. */
openLoginDialog?: (options: LoginDialogOptions) => Promise<"done" | "cancelled" | "unavailable">;
```

`LoginDialogOptions`: `{ title: string; run: (dialog: LoginDialogView) => Promise<void> }`
where `LoginDialogView` is the narrow interface the command sees:
`prompt(message, placeholder?)`, `deviceCode(info)`, `waiting(msg)`,
`message(line)`, `signal`. run() throwing `Error("Login cancelled")`
propagates as `"cancelled"` (silent, pi parity); other errors surface as
`renderer.error` by the command.

- `/login` flow: if `openLoginDialog` exists → dialog path for **both**
  api-key and oauth targets (title `Login to <name>`; api-key =
  one prompt state; oauth = deviceCode + waiting + the poll). Else →
  current select()/secret() path (readline shell, hermetic dispatch
  tests) — unchanged behavior, tests keep passing.
- `loginNeedsGuard` shrinks to `() => false`-equivalent: **deleted**; the
  guard branch in runCommand goes with it. Its unit test moves to assert
  the new invariant instead ("no /login line takes the guarded state").
- `/logout`: unchanged (pi's logout is a selector too).

### 2.4 What the machine keeps doing during a dialog

Nothing. That is the point: the state stays `idle` (no compacting state,
no spinner, no queue semantics interplay). Codex poll cancellation is the
dialog's own AbortController via Esc/SIGINT — not the machine's
double-Ctrl+C path. `/exit` and Ctrl+D: the selector-open key routing
already swallows Ctrl+D (shell.ts:316) and SIGINT tears the selector down
first (shell.ts:430). A running OAuth poll aborted at teardown resolves
"Login cancelled" → silent.

## 3. Test plan

New `test/login-dialog.test.ts` (TUI-level, FakeTerminal):

1. api-key flow: `/login zai` → dialog renders (border, title, prompt,
   input, hints) → type + Enter → saved line, dialog gone, editor focus
   back; the typed key never enters input history.
2. Esc during prompt: resolves cancelled, nothing stored, editor restored.
3. oauth flow with the local fake device-code server (reuse
   repl-commands.test.ts:93's fixture): device code + URL + waiting
   render; poll completes → logged-in message; dialog teardown.
4. Esc during the oauth poll: silent cancel ("Login cancelled" not
   printed), no credential written, editor restored, and a follow-up
   `/login` works (state is truly idle — no guard residue).
5. SIGINT mid-poll: same as Esc (selector teardown path).
6. Second `/login` while a dialog is open: keystrokes land in the
   dialog's input; no machine command dispatch; after the dialog closes
   the queued editor draft is intact.
7. `/compact` and `/tree` still take the guarded state (regression pins
   for the deleted branch).

Updated: the 3 existing TUI login tests (secret-prompt render/store/Esc)
rewrite to the dialog path; dispatch-level login tests keep the fallback
path (they never had a dialog). `loginNeedsGuard` test replaced per §2.3.

Gates: full vitest, typecheck (src+test), biome, build.

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

PROJECT_PLAN.md entry `#login-dialog` after merge, including the process
note from this batch's audit: when two candidate plans differ by an order
of magnitude, both get full cost accounting before recommending one.
