# A forked timer fiber that clears its own tracking ref via a recursive call can interrupt itself

**Date:** 2026-07-12

## Context

`PaneSupervisor`'s `applyAttention` forks a 3-second timer on reaching `Completed`, storing the
fiber in `settleFiberRef` so a later transition can cancel it. When the timer fires, it recurses
into `applyAttention({ _tag: 'Idle' })` on its own fiber. Live logs showed attention getting
permanently stuck at `Completed` — a later `AwaitingPermission` transition was rejected as
invalid minutes after the timer should have fired, with no `Completed -> Idle` transition ever
having been emitted.

## Reasoning / Learning

`applyAttention`'s first step is unconditional: read `settleFiberRef`, and if `Some`, interrupt
it and clear it. That's correct when some *other* fiber (e.g. handling a fresh `TurnErrored`)
calls `applyAttention` while a settle timer is still pending. But when the timer itself fires and
recurses into `applyAttention(Idle)`, it is running *on* the fiber referenced by
`settleFiberRef` — nothing had cleared that ref before the recursive call. So the timer fiber
reads its own fiber back out of the ref and calls `Fiber.interrupt` on itself, aborting its own
execution before it reaches the code that would actually apply the `Idle` transition and emit
`PaneAttentionChanged`. The rejected-transition log surfaced later was a symptom, not the cause —
attention was frozen at `Completed` because the fiber meant to unfreeze it killed itself first.

## Implication

When a forked effect's own continuation recurses into a function that reads back a ref tracking
"the currently pending fiber," clear that ref *before* the recursive call, not after — otherwise
the continuation can self-interrupt. A `TestClock`-driven regression test
(`pane-supervisor.test.ts`, "auto-settles Completed back to Idle after 3 seconds") now guards
this; without the fix it fails deterministically instead of relying on a live 3-second wait.
