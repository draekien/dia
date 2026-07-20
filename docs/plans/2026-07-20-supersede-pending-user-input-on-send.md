# Plan: Supersede a pending user-input request when the user sends a new message

Status: **proposed**
Date: 2026-07-20
Driven by: bug — sending a new message while `AskUserQuestion` (or a permission/plan prompt) is pending deadlocks the pane instead of abandoning the prompt and taking up the new message.

## Problem

When `canUseTool` is holding a tool call open (`agent-session.ts:138`, blocked on a
`Deferred` at line 176) and the user, instead of answering, submits a new message, the
pane hangs. The card disappears (renderer clears it optimistically, `pane.tsx:390-392`)
but nothing else happens and the amber pulse stays lit.

Two independent defects combine:

1. **Subprocess deadlock (the hang).** The `SendText` handler (`agent-session.ts:506`)
   calls `dropPendingRequests()`, which clears the pending map **without resolving the
   `Deferred`** (`pending-user-input.ts:74`). So `canUseTool` never returns. Per the SDK
   docs, "Execution remains paused until your callback returns, and the SDK only cancels
   the wait when the query itself is cancelled." Queuing a message on the input stream
   does **not** release a pending `canUseTool`; the current turn stays blocked and the
   queued message is never processed. The `drop` doc comment encodes the false assumption
   ("the SDK drops them once a redirect moves it on").

2. **Stuck attention (main).** `PaneHandle.sendMessage` (`pane-supervisor.ts:483`) posts
   `SendText` but never resets attention, unlike `resolvePermission`/`resolveQuestion`/
   `resolvePlanReview` (lines 516/529/542). Attention stays `AwaitingPermission`. Even
   after defect 1 is fixed, the new turn's `TurnCompleted` → `Completed` (line 304) is an
   invalid transition from `AwaitingPermission` (`attention.ts:189`), so it is rejected
   and the pane stays amber forever.

## SDK basis for the fix

- The `PermissionResult` **deny** variant carries `interrupt?: boolean`
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2074`). Returning
  `{ behavior: 'deny', message, interrupt: true }` from `canUseTool` both releases the
  callback and aborts the stale turn.
- Interrupted streaming sessions keep queued async user messages
  (`interrupt_receipt_v1` / `still_queued`, sdk.d.ts:2239), so the message offered onto
  `promptQueue` right after still runs as a fresh turn.

This is the one mechanism that unblocks the callback *and* aborts the turn in a single
return. `query.interrupt()` alone would leave our `Deferred`-blocked promise leaked.

## Phase 1 — Supersede pending requests in the subprocess

Effect edits follow `effect-ts`; test edits follow `with-testing-principles`.

- **`pending-user-input.ts`**: add a way to resolve every outstanding request with a
  "superseded" resolution, instead of only silently `drop`ping.
  - Introduce a pane-local `Superseded` resolution and widen `UserInputResolution` to
    include it (it is internal to the pane process, not a `@shared/domain/attention`
    type). Prefer a tagged struct so `toPermissionResult`'s `Match` stays exhaustive.
  - Add `interruptAll: Effect.Effect<ReadonlyArray<string>>` that resolves each pending
    `Deferred` with `Superseded` and clears the map (mirroring `resolve` + `drop`).
  - Keep `drop` as-is for the teardown paths (see Phase 1 note).
- **`agent-session.ts`**:
  - Extend `toPermissionResult` (line 109) with a `Match.tag('Superseded', …)` arm
    returning `{ behavior: 'deny', message: 'Superseded by a new message from the user.',
    interrupt: true }`. Keep `Match.exhaustive`.
  - In the `SendText` handler (line 506), replace `dropPendingRequests()` with the new
    `interruptAll` (resolve-with-supersede), keeping the existing order:
    `restartForThinkingChange()` → supersede → `Queue.offer(promptQueue, …)`.

Phase 1 note — leave `rewindToCheckpoint` (line 463) and any restart path on `drop`: the
query is torn down and replaced there, so resolving the old callbacks is unnecessary; the
leaked promise dies with the old query. `restartForThinkingChange` is a no-op in the
common (no thinking-change) case, so `SendText` must always supersede regardless.

## Phase 2 — Clear attention on send in main

- **`pane-supervisor.ts`** `sendMessage` (line 483): append
  `Effect.andThen(applyAttention(Idle.make({})))`, matching the resolve\* handlers. This
  is a valid `AwaitingPermission -> Idle` / `Idle -> Idle` transition and lets the
  subsequent `TurnCompleted -> Completed` succeed.

## Phase 3 — Tests

- **`pending-user-input.test.ts`**: add a case that `interruptAll` resolves each
  registered `Deferred` with `Superseded`, returns the dropped ids, and empties the
  registry (contrast the existing `drop` test at line 47 which asserts the Deferred is
  left unresolved).
- **`agent-session.ts` mapping**: if `toPermissionResult` is unit-testable in isolation,
  assert `Superseded` → `{ behavior: 'deny', interrupt: true }`. (The end-to-end
  interrupt behavior is only verifiable against the live CLI — see caveat.)
- **`pane-supervisor.test.ts`**: assert `sendMessage` drives attention to `Idle` when the
  pane was `AwaitingPermission`, and that a following `TurnCompleted` reaches `Completed`.

## Phase 4 — Verify, document, commit

- `pnpm typecheck`, `pnpm test`, `pnpm build` green; `pnpm diagnostics` clean for the
  touched files.
- **Live verification (required):** in a real dev session, trigger `AskUserQuestion`,
  send a new message instead of answering, and confirm the agent abandons the question
  and processes the new message, and the pulse clears. `interrupt: true` on the deny is
  the one item not provable by unit test (same class of caveat as
  `docs/reasoning/2026-07-20-askuserquestion-answers-keyed-by-question-text.md`).
- Reasoning-log entry (`docs/reasoning/`): a pending `canUseTool` is only released by
  returning from the callback or cancelling the query — queuing an input message does
  not; supersede with deny + `interrupt: true`. Add to `docs/REASONING.md`.
- Conventional-commit messages, per phase where practical.

## Explicitly out of scope

- Gating the composer while a prompt is pending (the redirect-by-typing flow is the
  desired behavior; this plan makes it work rather than blocking it).
- Reworking `drop` semantics for the rewind/restart paths.
- Any change to how answers are keyed (covered by the 2026-07-20 reasoning log).

## Sequencing / risk

1 → 2 → 3 → 4. Phase 1 fixes the hang; Phase 2 fixes the residual stuck indicator; both
are small and localized. The only real uncertainty is the live-CLI behavior of deny +
`interrupt: true`, addressed by the mandatory live check in Phase 4.
