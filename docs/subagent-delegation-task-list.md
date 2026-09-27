# Subagent delegation: assignable task list

- Date: 2026-09-27
- Source baseline: `85ccd36`
- Status: backlog and acceptance criteria; NOT an approved implementation design.

## Purpose and assignment rules

This document separates correctness fixes from proposed features. It is intended to be handed to agents that have no prior conversation context. All code paths below are relative to the `imp` repository root. Re-read the source before changing it; this baseline can change as other tasks are integrated.

The requested direction is:

1. Make delegation cleanup, model selection, result records, and usage accounting reliable.
2. Add synchronous continuation of an identified, already-settled child, without building a background-task system.

Repository agreements still apply: create a dedicated branch/worktree before editing; a design must pass fresh-context adversarial review before implementation; evaluate independent implementation review; merge to main only with `--no-ff`. This backlog does not satisfy the design-review gate. Obtaining a review that uses paid services remains subject to the operator's approval rules.

Do not treat the following as authorization to launch paid model calls, change global configuration, clean existing user worktrees, or publish changes. Use scripted/fake providers and disposable test repositories. Code, tests, documentation, identifiers, and commit messages stay in English.

### Evidence labels

- **Observed defect:** a concrete source path produces the problematic behavior. Add a failing regression test before fixing it; this document does not claim a live incident was reproduced.
- **Contract gap:** existing behavior is intentional or underspecified, but cannot support reliable consumers. Agree on the semantics before changing it.
- **New feature:** not currently supported. Do not present its absence as a bug.

### Existing behavior to preserve unless a reviewed design explicitly changes it

- Fresh children have their own conversation history, but inherit the parent's assembled system prompt and append the agent profile.
- Normal children cannot call `task`; the parent remains responsible for delegation.
- Delegation is synchronous from the parent model's perspective. Consecutive `task` calls run in chunks of at most five, with results emitted in call order.
- The child turn cap is 60 per loop invocation. One overflow-recovery restart can run a second loop. TTY defaults to no child clock; non-TTY defaults to 60 minutes. Timeout precedence is call argument, agent configuration, then mode default.
- No budget-driven wrap-up prompts or tool-budget blocking are injected into the child.
- Child tools still pass through the parent's permission gate with the child's actual cwd.
- Worktree children use rebuilt builtin tools, not the parent's cwd-bound extension tools. A worktree is not a filesystem security sandbox.
- Child transcripts are separate JSONL files. Children do not populate the parent's conversation history.
- Model-visible result text is bounded and CJK-safe. UI-only display data must not leak into model input or persisted messages.
- Existing `isError` behavior is not a completion-status schema: a capped run or crash with partial text can intentionally be non-error-shaped.

## Assignment overview

| ID | Work package | Kind / priority | Dependencies |
| --- | --- | --- | --- |
| SA-01 | Conservative worktree cleanup | Observed defect / first | None |
| SA-02 | Unambiguous child model selection | Observed defect + contract decision / first | None |
| SA-03 | Structured task identity and terminal result | Contract gap / foundation | Coordinate with SA-01 and SA-02; integrate their outcomes first |
| SA-04 | Correct per-attempt child usage | Observed defect + accounting contract / foundation | SA-02 model semantics; coordinate result shape with SA-03 |
| SA-05 | Durable parent-plus-child usage reporting | New accounting integration | SA-03, SA-04 |
| SA-06 | Persist and validate resumable child launch state | New feature foundation | SA-01, SA-02, SA-03 |
| SA-07 | Synchronous continuation of settled children | New feature | SA-03, SA-04, SA-06; regression-check SA-01 and SA-02 |
| SA-08 | Independent integration review and acceptance | Review / release gate | All work included in the delivery |

SA-05 is not a prerequisite for building the resume engine, but its accounting integration must be verified with SA-07 before declaring the complete effort finished.

### Concurrency and ownership

- SA-01 and SA-02 can be investigated/tested independently in separate worktrees. Both may touch `src/core/tools/task.ts` and `test/task-tool.test.ts`; integrate deliberately, not by sharing a checkout.
- SA-03 owns task identity/result persistence contracts. SA-04 owns engine usage production. Freeze their interface in a reviewed design before parallel implementation.
- After SA-03/SA-04, SA-05 and SA-06 may proceed separately only if the session-entry contracts and file ownership are agreed. Both may need `src/core/session/store.ts` and `src/runner.ts`.
- SA-07 must consume the approved contracts; it must not invent a second child registry, usage ledger, or metadata format.
- Every task owner reports baseline commit, changed paths, design/review status, exact verification commands/results, and unresolved limitations. Do not replace tests with weaker expectations merely to accommodate new behavior.

## SA-01 — Preserve work whenever cleanup safety is uncertain

### Problem and evidence

In `src/core/worktree.ts`, `hasWorktreeChanges()` checks `git status`, then returns only `diff.status === 1`. A Git error other than diff's normal difference exit code can therefore be interpreted as no work. `task.execute()` may then call forced worktree/branch removal. The caller's `.catch(() => true)` does not protect against command failures returned as ordinary result objects.

There is a second case: a child can create commits whose final tree equals the creation baseline, for example a change followed by a revert or an empty commit. A tree diff alone does not preserve that commit history.

The source currently distinguishes neither verified emptiness from unknown state nor new commit history from a net tree change. This is an automatic-cleanup correctness issue, not a request for a general worktree garbage collector.

### Required outcome

- Auto-remove only a positively identified, task-owned worktree/branch whose checks all succeeded and which has no user work or changed commit identity/history relative to its creation baseline.
- Preserve on failed status, diff, ref, or ownership checks. Report the uncertainty and retained paths instead of silently treating it as a clean tree.
- Preserve dirty tracked files, staged files, untracked files, new commits, and unexpected branch/HEAD identity, including net-zero tree changes.
- Retain exclusion of the runtime-created `node_modules` link only while it is verified to remain synthetic. The existing creation-time boolean is not proof that a later occupant of that path is still the link. Do not ignore arbitrary user-created content at that path.
- Surface cleanup failures without losing the task's original outcome. Inspect early setup-error return paths as well as the final cleanup path.
- Do not promise protection against arbitrary concurrent external filesystem/Git mutation; state the race assumptions and keep the destructive window conservative.

### Scope / entry points

`src/core/worktree.ts` (`git`, `hasWorktreeChanges`, `removeChildWorktree`), `src/core/tools/task.ts` (setup failures and `finally`), `test/worktree.test.ts`, worktree cases in `test/task-tool.test.ts`.

No automatic merge, patch export, stale-worktree sweeping, sandboxing, or new cleanup CLI. Inspect shared callers before changing helper semantics; do not silently rewrite the user-facing `/worktrees` removal policy.

### Acceptance tests

- [ ] Verified untouched task-owned worktree is removed; the parent checkout is unchanged.
- [ ] Dirty/staged/untracked work, a normal commit, an empty commit, and change-then-revert commits are preserved.
- [ ] Inject status/diff/ref command failures: no destructive cleanup command is issued, and uncertainty is visible in the result.
- [ ] Unexpected branch/HEAD or ownership mismatch is preserved.
- [ ] The verified synthetic link does not prevent empty cleanup; replacing it with user work does not authorize deletion.
- [ ] Normal completion, cap, abort, timeout, crash, and setup-error paths all retain work and report applicable cleanup failures.

## SA-02 — Make child model configuration match actual routing

### Problem and evidence

In `src/core/tools/task.ts`, `agent.model` becomes the raw `model` passed to `runSubagent()`, while `provider` remains `options.getProvider()`. `parseModelRef()` is used for metadata decisions, not actual child provider routing. Even a recognized same-provider prefix can remain in the wire model ID. A cross-provider configuration can be sent to the parent's provider instead of being honored or rejected.

Some model-dependent behavior also remains parent-bound: inspect `src/runner.ts` read-tool construction and `src/core/subagent.ts` compaction/model-limit lookups. Correct routing alone is not enough if tool capability and context-window decisions use a different model.

### Proposed minimal contract to confirm in design review

1. Missing `model`: inherit the parent's current provider and wire model at dispatch time.
2. Bare model ID: select that model on the parent's provider; do not silently apply main-CLI default-provider routing to this agent-local shorthand.
3. Recognized explicit same-provider reference: validate/normalize it and strip the provider prefix for the API request.
4. Recognized explicit different-provider reference: reject before creating worktrees/sessions or calling the provider, with a useful diagnostic.
5. IDs containing an unrecognized slash prefix may be legitimate wire IDs. Do not classify every slash as a provider delimiter. Specify malformed/empty known-prefix behavior and whitespace/case normalization.

This is a recommended bounded fix, not a decision to build cross-provider delegation. If the owner wants full cross-provider children instead, obtain that decision and review its authentication, provider construction, metadata, and tool-capability design before implementation.

### Scope / entry points

`src/core/tools/task.ts`, `src/core/agents/registry.ts`, `src/core/subagent.ts`, `src/runner.ts`, `src/provider/resolve.ts`, `src/provider/compaction-settings.ts`, model metadata helpers and relevant tests. Do not change main-CLI model shorthand semantics as a side effect.

Ensure actual routing, canonical provider/model metadata, model limits, image support, and later pricing agree. Audit both shared-cwd and worktree children. Prefer a targeted capability binding over rebuilding arbitrary extensions or expanding their authority.

### Acceptance tests

- [ ] Inheritance follows a parent model/provider change made before dispatch.
- [ ] Bare and explicit same-provider overrides produce the expected wire ID and canonical metadata.
- [ ] Different-provider and malformed explicit references fail before launch side effects under the minimal contract.
- [ ] Legitimate slash-containing IDs are not incorrectly rejected or rerouted.
- [ ] A child model differing from the parent's uses child-appropriate context/output limits and image capability decisions.
- [ ] Task descriptions, agent configuration documentation, and errors describe the implemented contract rather than promising cross-provider support.

## SA-03 — Preserve structured task identity and terminal outcomes

### Problem and evidence

`src/core/subagent.ts` already produces `SubagentOutcome.status`, text, turns, and usage. `taskResult()` reduces this to text plus `isError`. `ToolExecuteResult`, `ToolResult`, and `loop.ts::runTool()` do not currently carry task-specific records through execution, persistence, and replay.

Consequently future consumers would have to parse prose to identify capped/partial work, find the transcript, attribute usage, or address a child. `sourceId` is an invocation observer identity, not currently a durable resumable child ID. `isError: false` does not imply confirmed completion.

### Required outcome

Design one runtime-owned task result contract shared by storage, UI/observers, accounting, and future continuation. It should represent at least:

- Stable logical child identity and unique execution-attempt identity; relationship to parent session and parent tool-call ID. Reuse the existing child session UUID where appropriate rather than introducing a second registry solely for naming; define identity separately for no-session runs.
- Actual terminal reason, available response text, and errors/warnings without claiming verified task success.
- Whether a transcript really exists, and its managed reference when persisted.
- Worktree disposition/path/branch, including uncertain cleanup rather than fabricated success.
- Canonical producer identity and the SA-04 usage payload.

Choose the transport deliberately: a persisted metadata entry, a typed result field with explicit forwarding, or another narrowly scoped channel. Document which data is model-visible, which is UI-only, and which survives compaction/replay. Merely adding a field to `ToolExecuteResult` is insufficient: `runTool()` currently projects selected fields and would discard it.

Keep model-visible text concise and generated from runtime facts. Do not require the child LLM to produce a JSON envelope. Do not send internal metadata to providers accidentally. Runtime-produced identity and status must not be inferred from child answer text that happens to resemble metadata.

Define pre-launch rejection separately from a child that actually ran. Define honest behavior when child sessions are disabled or persistence fails. Existing text-only sessions should remain readable; missing data must stay unknown, not become invented resumability or zero usage.

### Scope / entry points

`src/core/tools/task.ts`, `src/core/tools/types.ts`, `src/core/messages.ts`, `src/core/loop.ts`, session store/manager, runner events, task presentation and replay consumers.

No resume implementation yet; no background controller, generic workflow result system, automatic retry, or change to the existing `isError` mapping without an explicit reviewed rationale.

### Acceptance tests

- [ ] Every actual terminal outcome has the correct structured reason, including cap-without-text and crash-with-partial-text.
- [ ] A runtime-normal completion is not labeled as independently verified task success.
- [ ] IDs correlate the call, child, transcript, events, and attempt without collisions in parallel runs or no-session mode.
- [ ] Records survive the chosen persistence/replay path; compaction does not erase the authoritative identity/accounting record.
- [ ] Persistence-disabled/failed cases never advertise a usable transcript or resume capability.
- [ ] Provider wire input and UI display separation remain intentional and tested; large/CJK text behavior remains bounded.
- [ ] Changing result prose, or child text spoofing a status/usage trailer, cannot change programmatic status or accounting.

## SA-04 — Account for all reported usage in one child attempt

### Problem and evidence

In `src/core/subagent.ts`, successful and ordinary aborted runs return `result.usage` from `runAgentLoop()`. Compaction summarization is a separate provider call, outside that accumulator. `summarizedUsage` is used on crash/overflow-recovery paths but not normal success, so accounting depends on the exit path.

Do not fix this by adding `summarizedUsage` wholesale to `result.usage`: that accumulator includes removed assistant-message usage, which the loop has already counted. This would double-count summarized turns. Recomputing only from the final live history would instead omit removed turns.

Also inspect `src/core/compaction.ts`: summarization can retry or return an unusable result after paid work. Counting only accepted compaction entries is not necessarily the same as counting every reported provider usage event.

### Required outcome

- Establish one exactly-once accounting source for reported usage within an execution attempt, with child-loop and summarization usage distinguishable.
- Count each known provider usage report once, regardless of history splicing, accepted/rejected summaries, retries, or terminal outcome.
- Distinguish assistant task turns from summarizer calls; do not inflate the existing task turn count with summary calls.
- Report input/output/cache components with provider/model attribution. Do not normalize incompatible provider counters by assumption; reuse existing adapter semantics and document the total.
- When an interrupted request has no final usage report, preserve known totals and disclose incompleteness. Do not guess a token count or assert that unreported work was free.
- Prepare for resume: an attempt's delta must not include usage replayed from prior child history. Keep cumulative child usage separate.

### Scope / entry points

`src/core/subagent.ts`, `src/core/compaction.ts`, usage types in `src/core/messages.ts`, loop/provider observation seams if needed, `test/subagent.test.ts`, `test/child-compaction.test.ts`, compaction tests.

Coordinate the payload with SA-03. This task produces correct attempt usage; it does not build parent-session cost UI or change child turn/timeout/budget policies.

### Acceptance tests

- [ ] Exact token assertions for success without compression and success with one/multiple compactions.
- [ ] Retained tails and removed messages are neither lost nor counted twice.
- [ ] Overflow, compact-and-retry, retry failure, cap, abort, timeout, and crash use the same accounting rules.
- [ ] Summarizer retries/rejected summaries count every usage report that is actually available; a missing report yields an incomplete marker rather than guessed usage.
- [ ] Input/output/cache-read/cache-write components and producer attribution are preserved.
- [ ] Fixtures with existing historical usage produce only the new attempt delta in the new-attempt field.

## SA-05 — Persist and display total work usage without corrupting context metrics

### Problem and evidence

Child usage currently appears mainly in task-result prose. `src/repl/repl.ts::refreshFooter()` sums assistant messages in the parent's live history. `src/core/session/store.ts::stats()` sums message entries on the active branch and intentionally excludes compaction entries. These are not a durable total of parent calls, child calls, and summarization calls; the live footer can also lose old usage after history compaction.

A child that processes 50,000 tokens and returns 1,000 tokens creates approximately the returned-content context load in the parent, not 50,000 extra parent-context tokens. Expenditure and current context occupancy need separate definitions.

### Required outcome

- Consume structured runtime usage from SA-03/SA-04, never parse text trailers.
- Maintain a durable aggregate of known parent, child, and summarization usage, with per-provider/model attribution and an explicit incompleteness indicator where needed.
- Choose and document the scope: current attempt, logical child, active conversation branch, and whole session are different totals. A work-cost total must not silently forget already incurred calls because `/tree` changes the active branch.
- Make reload/resume, repeated rendering, and event replay idempotent. Do not count both child message history and its terminal aggregate as separate expenses.
- Choose an authoritative persistence source. Define crash windows: a child transcript may exist even when its parent result was never written. Reconcile managed records or clearly mark the aggregate incomplete; do not promise unconditional exactly-once recovery without an implementation.
- Do not rescan all transcripts on every token delta/footer render. Rebuild once as needed, then update from runtime records.
- Price canonical provider/model usage using known rates. Unknown pricing is unknown/partial, not zero or silently priced at the parent's current model. Subscription estimates are not invoices.
- Keep parent context percentage, compaction triggers, and last-response cache metrics independent of child totals.

### Scope / entry points

Runner usage/event handling, session persistence/stats interfaces, `src/repl/repl.ts::refreshFooter()`, headless usage output, `src/provider/models.ts` pricing helpers and appropriate tests. Reuse the SA-03 storage contract rather than adding a parallel ledger without a reviewed need.

No paid-provider billing integration, budget enforcement, spend-based cancellation, or new dashboard. Avoid silently changing `SessionStore.stats()` semantics for all existing consumers; introduce clearly named queries where required.

### Acceptance tests

- [ ] A fake parent plus multiple children and summaries yields exact, non-duplicated totals.
- [ ] Parent and child compaction do not erase incurred work from the documented aggregate.
- [ ] Session reload, repeated events/results, and repeated UI rendering do not add usage twice.
- [ ] Session branch switching follows the documented cost scope without mixing it into context occupancy.
- [ ] Parent model changes do not reprice historical child work at the new model's rates.
- [ ] Missing pricing/usage/persistence is visible as unknown or incomplete.
- [ ] Child-only usage increases do not change parent context percentage or auto-compaction thresholds.
- [ ] Following SA-07 integration, a resumed child's attempt delta is added once, not its full lifetime usage again.

## SA-06 — Persist enough launch state to make continuation safe

### Problem and evidence

`src/core/session/manager.ts::createChildSession()` records the parent's cwd and parent ID. It does not save a complete child execution environment. In particular, the header cwd is not a worktree child's actual cwd. `runSubagent()` gets role text, tools, model/provider, and system via live options rather than a resumable launch record.

A transcript is conversation history, not a complete restart recipe. Opening it in the current parent directory with current defaults can silently change the role, model, permissions, or target files.

### Required outcome

Extend the SA-03 identity/storage contract with a versioned, validated launch record sufficient for SA-07. Cover:

- Owning parent-session identity, logical child ID, role identity, actual provider/model, and tool contract.
- Actual execution cwd; for worktree runs, canonical repository identity, managed worktree path, branch identity, and creation baseline.
- Agent profile/system provenance and an explicit drift policy. A hash detects changes but cannot reconstruct old content by itself.
- Transcript association, execution state, and resumability reason; a saved transcript does not automatically mean resumable.

Choose a coherent policy for profile, project/global instruction, extension, and model changes. The recommended first version rejects incompatible drift with actionable diagnostics rather than silently substituting a role/model or broadening tools. Current safety/permission rules must still apply; persisted approvals or old prompt text must not override newer restrictions.

Do not serialize credentials, provider instances, executable tool closures, or arbitrary environment snapshots. A stored extension tool name alone does not prove the same implementation/configuration is available. Specify validation or conservative refusal for incompatible extension state.

Use managed identity lookup, not a model-supplied arbitrary transcript filename. Restrict lookup to the owning logical parent session, including that parent's normal restore after restart. Validate schema, path containment/symlink behavior, and repository/worktree ownership before reopening. Legacy children lacking required metadata can remain readable but explicitly non-resumable; do not guess their original launch state.

Persistence and worktree cleanup must agree: an automatically removed empty worktree means the old child cannot be resumed in place under the first-version policy. Do not keep all worktrees forever merely to manufacture resumability, and do not recreate a different checkout silently.

### Scope / entry points

`src/core/session/manager.ts`, `src/core/session/store.ts`, `src/core/tools/task.ts`, agent registry, model resolution, worktree identity helpers, runner system/tool assembly, metadata tests.

This task supplies creation/load/validation APIs and tests, not the user-facing resume tool. Coordinate session-entry ownership with SA-05.

### Acceptance tests

- [ ] Generic/named, shared-cwd/worktree children persist the actual execution identity and environment.
- [ ] A parent restarted with its normal session restore can resolve its eligible child; unrelated parents/projects cannot.
- [ ] Missing/corrupt metadata, legacy transcripts, disabled persistence, and unknown versions are safely rejected for resume while ordinary history remains readable.
- [ ] Missing/replaced worktree, changed branch/repository identity, and unsafe paths never fall back to the parent cwd. Ordinary commits made by the child on its own branch are expected work, not automatically an identity mismatch; define how unexpected history changes are detected.
- [ ] Profile/model/tool/extension drift follows the documented policy; current permission restrictions are not weakened.
- [ ] Partial launch/metadata-write failure does not leave an advertised resumable child without a valid record.
- [ ] No secrets or executable runtime objects are written into launch records.

## SA-07 — Continue one settled child synchronously

### Desired behavior, not current API

Illustrative only; finalize the schema in design review:

```ts
// First dispatch returns a runtime-issued child ID.
task({ agent: "reviewer", prompt: "Inspect authentication validation." });

// Later, continue that child's effective history with an additional instruction.
task({ resume: "child-123", prompt: "Check whether callers already validate the second case." });
```

This is continuation of a settled child's conversation. It is NOT live steering, automatic retry, a background job, an OS process checkpoint, a filesystem snapshot, or an independent fresh review.

### Required outcome

- Resolve and validate the child using SA-06, then build its effective history from the session tree and latest compaction checkpoint, not by replaying every JSONL entry as a message.
- Append the new instruction once. Keep the child's own prior context, not the parent's conversation. Do not resend its original task as a new user message or replay past tool side effects.
- Validate/repair incomplete tool-use/result pairs conservatively before sending the next request. Distinguish recorded history from truncated/missing crash data; never claim a partial tool operation completed.
- Keep the original logical child identity and allocate a new attempt identity. Persist new history without rewriting old entries and report the new attempt's usage separately from lifetime usage.
- Reconstruct the approved role/model/tool contract in the original validated cwd/worktree, under current permission checks. Refuse incompatible state; no fallback to a fresh child or parent cwd without an explicit caller decision. Distinguish expected child commits and current dirty work from a replaced repository or branch; resume is not a requirement that the tree remain at its creation commit.
- Permit only one active execution per child. Enforce this across processes if restoring the same parent in multiple processes is supported; otherwise explicitly reject unsupported ownership. A per-process map alone is not a cross-process lease. Specify stale-owner recovery without risking two writers.
- Support continuation only after execution has actually settled. An abort flag alone does not prove a still-running tool released the transcript/worktree.
- Reset the execution allowance for the new explicit attempt under the existing cap/timeout policy. Do not automatically resume capped children in a loop.
- Document that files can change between attempts. Require current file inspection before relying on old observations for edits; do not imply transcript restoration restores filesystem state.
- Return a normal synchronous task result. Existing unrelated fresh tasks can still run concurrently; two calls targeting one child cannot.

### API decisions to close before code

- Whether to add `resume` to `task` or a separate narrowly scoped tool.
- Which launch parameters are forbidden with resume. Recommended first version keeps role/model/worktree immutable, permits an explicit attempt timeout, and rejects contradictory overrides.
- How the parent learns eligible IDs and non-resumability reasons without needing a fleet/list-management subsystem.
- How lock ownership, aborted/crashed attempts, persistence failure, and vanished worktrees are represented and recovered.

### Scope / entry points

Task schema/dispatch, `src/core/subagent.ts` history initialization/accounting, session context construction and append handling, SA-06 registry/validation, runner permission/event integration, usage integration and task UI tests.

No background notifications, wait tool, live steer, scheduling, recursive delegation, cross-project resume, automatic provider switching, or automatic worktree recreation. Independent review still needs a NEW fresh-context child.

### Acceptance tests

- [ ] Fresh dispatch behavior remains unchanged; continuation receives the old effective child context plus exactly one new instruction.
- [ ] A compressed child resumes from summary plus retained tail, not the full raw transcript.
- [ ] Completed, capped, aborted, timed-out, and crashed attempts can be continued only when their stored state and ownership checks permit it.
- [ ] Tool pairing is valid; executed tool side effects are not automatically repeated by history restoration.
- [ ] Missing/incompatible role, model, tools, worktree, metadata, and permissions fail before model/tool execution.
- [ ] Two concurrent resumes of one child yield at most one active writer; unrelated children retain normal concurrency.
- [ ] Parent restart, stale ownership, and interrupted persistence follow the reviewed recovery rules.
- [ ] New history extends the child transcript, parent linkage remains correct, and attempt usage excludes historical calls.
- [ ] Parent cancellation, timeout classification, cap/overflow behavior, task activity identity, CJK output and cleanup safety remain correct.

## SA-08 — Independent integration review and final acceptance

Assign this to a fresh-context reviewer who did not implement the reviewed paths. Review the actual integrated changes, not only individual agent summaries. This task does not retroactively replace the required pre-implementation design reviews.

### Review focus

- Automatic deletion still requires positive safety evidence; Git errors, empty commits, and net-zero changes cannot authorize losing work.
- Selected wire model, provider, context limits, tool capabilities, persistence metadata, and pricing agree.
- Structured status originates from runtime facts. `completed`, `isError`, and verified task success are not conflated.
- Identity, terminal persistence, and usage have one documented authority and clear behavior for crash windows.
- Compaction, retries, replay, and resume neither lose known usage nor count it twice. Unknown information remains unknown.
- Restored child state cannot expand permissions or silently change role, model, cwd, branch, or extensions.
- One child has one active writer; cancellation/timeout does not permit a replacement writer while old work still runs.
- No unrequested background framework, automatic retry loop, or provider migration was introduced.

### Verification protocol for implementers and reviewer

Run from the repository root. Inspect current tests and setup before execution; use only fake providers and workspace/designated-scratch fixtures. Any fixture cleanup or command requiring explicit approval under the operator's safety rules must obtain that approval first.

Select relevant existing tests and add the new regression tests; these examples are not an exhaustive acceptance suite:

```bash
npm run typecheck
npm run lint
npm test -- test/worktree.test.ts test/task-tool.test.ts
npm test -- test/subagent.test.ts test/child-compaction.test.ts test/compaction.test.ts
npm test -- test/loop-concurrency.test.ts test/task-live-display.test.ts test/task-source-identity.test.ts
```

Also run the new persistence, model-selection, usage, and resume tests produced by this effort. The integration owner should run the complete local fake-provider suite after inspecting its current configuration and safety requirements. Do not use real providers to validate token arithmetic, and do not modify real `~/.imp` files or existing user worktrees.

Deliver:

- [ ] Reviewed design references and decisions, including unresolved limitations.
- [ ] Exact commands, test counts, and any failures/skips, with affected paths.
- [ ] Independent findings resolved or explicitly deferred by the owner, not silently dismissed.
- [ ] Documentation distinguishes current supported behavior from deferred features.
- [ ] No claims of completed implementation, approved design, or passing tests without actual evidence.

## Suggested assignment message

> Implement task SA-XX from `docs/subagent-delegation-task-list.md`. Read the common constraints, the complete task, and its dependencies before editing. Treat the stated source behavior as a regression target, not as permission to expand scope. Re-read current source, confirm the proposed contract, and obtain the required independent design review before implementation. Use a dedicated branch/worktree. Do not silently choose a different provider, cwd, permission policy, result format, or accounting scope. Return changed paths, exact test results, review findings, and remaining decisions. Stop if a dependency's contract is unavailable or incompatible.
