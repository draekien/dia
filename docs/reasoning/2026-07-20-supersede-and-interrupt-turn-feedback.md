# Superseding a pending prompt, interrupting a stall, and the error/crash split

**Date:** 2026-07-20

## Context

Sending a new message while a pane was blocked on `AskUserQuestion` (or a
permission/plan prompt) deadlocked the pane, and a silently stalled turn left
the user with no way out. Fixing both meant deciding how a pending `canUseTool`
is released, how to abort a turn we *expect* to fail without lighting a red
pulse, and how "retryable error" differs from "dead pane" in the state machine.

## Reasoning / Learning

**A pending `canUseTool` is released only by returning from the callback or
cancelling the query.** The callback blocks on a `Deferred`; queuing a new
message onto the SDK input stream does **not** wake it. So the old `SendText`
handler's `dropPendingRequests()` (clear the map, leave the `Deferred`
unresolved) left `canUseTool` hung forever. The fix is `interruptAll`: resolve
every pending `Deferred` with a pane-local `Superseded` tagged value, which
`toPermissionResult` maps to `{ behavior: 'deny', message, interrupt: true }`.
The deny **with `interrupt: true`** is the single mechanism that both releases
the callback and aborts the stale turn; `query.interrupt()` alone would leak the
`Deferred`-blocked promise. Queued async user messages survive the interrupt
(`still_queued`), so the superseding message runs as the next turn.

**Two abort paths, one suppression.** Supersede (deny+interrupt) covers aborts
where a request is pending. A *silent* stall has no pending `Deferred`, so the
stall UI's "Interrupt & retry" calls `query.interrupt()` directly. Both aborts
surface from the SDK as an **error-subtype turn result** (there is no
`'interrupt'` result subtype), which would otherwise map to `TurnErrored` → red
`Errored` pulse. `abortExpectedRef` (a `Ref<boolean>` armed when we initiate an
abort, cleared on the next terminal outcome) intercepts exactly one such result
and rewrites it to a clean `TurnCompleted`, so an intentional interrupt settles
green, not red.

**`Errored` is recoverable; `Crashed` is terminal — a state, not a flag.** An
earlier draft carried a `fatal: boolean` on `PaneError`. Because `fatal` only
ever means something in the error case, it became a distinct terminal attention
state instead: `Errored` (a failed turn — `Errored -> Idle` is a valid recovery
transition, and the renderer shows a Retry) versus `Crashed` (the pane process
died — terminal, no outbound transitions, steady red dot with no ping ring).
Retryability is therefore a property of the pane's live attention, not a boolean
on the transcript's error row — the row carries only the message.

## Implication

- Never "drop" a pending request by clearing the registry alone — resolve the
  `Deferred` (with `Superseded` for redirect, or tear the query down entirely on
  rewind/restart where the leaked promise dies with the old query).
- Any code that deliberately aborts a turn must arm `abortExpectedRef` first, or
  the interrupt shows as an error.
- Prefer a distinct state over a nullable boolean flag when the flag is only
  meaningful in one variant — the flag becomes a state-machine transition you
  can validate, not a scattered conditional.
- **Live-CLI verification still required** (not unit-provable): deny +
  `interrupt: true` actually abandoning a pending `AskUserQuestion`,
  `query.interrupt()` on a silent stall, and `abortExpectedRef` suppressing the
  resulting error result so the pulse clears.
