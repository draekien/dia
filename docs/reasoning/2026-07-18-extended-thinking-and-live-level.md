# Extended thinking rendering + live, per-pane thinking level

**Date:** 2026-07-18

## Context

Two combined pieces of work: (1) render the model's extended-thinking output in the
chat pane, and (2) let the user pick a per-pane thinking level (`off` / `adaptive` /
`low` / `medium` / `high`) both at pane creation and live, mid-conversation, from the
running pane's header.

## Reasoning / Learning

**A running Agent SDK query's thinking/effort options are fixed for its lifetime.** You
cannot mutate `thinking`/`effort` on a live `query()`. So a live level change is deferred
to the next turn boundary: on the next `SendText`, if the desired level differs from the
active one and a `sessionId` exists, the pane process interrupts the current query fiber
and forks a fresh `query({ resume: sessionId, ...thinkingOptions(next) })`. Resuming (not
a cold start) preserves the conversation. This lives entirely in the pane process
(`agent-session.ts` `restartForThinkingChange`), driven by three `Ref`s: `desiredLevelRef`
(set by `Init` and `SetThinkingLevel`), `configRef` (the active config, level included),
and `fiberRef` (the current query fiber to interrupt). A no-op when the level is unchanged
or no session has started yet.

**The level map is a deliberate product decision, not an SDK passthrough.** `off` →
`{ thinking: { type: 'disabled' } }`; `adaptive` → `{ thinking: { type: 'adaptive' } }`;
`low`/`medium`/`high` → `{ thinking: { type: 'adaptive' }, effort: <level> }` (adaptive
thinking *capped* at that effort, not `thinking: { type: 'enabled' }`). Extracted to the
pure `thinking-options.ts` so it's unit-testable — `agent-session.ts` runs `Effect.runFork`
and touches `process.parentPort` at import, so nothing in it can be imported from a test.

**Thinking always precedes the answer in one turn, so the reasoning→text transition is a
one-way close.** In the IPC→AG-UI adapter, a `thinking_delta` opens a
`REASONING_MESSAGE_*` stream; the first subsequent `text_delta` closes the open reasoning
message before opening the answer text. Any turn-boundary event (tool call, appended
assistant message, `Completed`/`Errored`) closes reasoning then text, in that order, so
neither is ever left dangling. The reducer keeps thinking and text on separate outbound
tags (`AssistantThinkingDelta` vs `AssistantTextDelta`) — they must never be conflated
into one accumulated string.

**`thinkingLevel` rides on the `PaneLeaf` node, not just the config.** The live header
dropdown reads the current level from the layout tree (like `cwd`/`sourceRepo`), so it
survives remounts/restores. `setThinkingLevel` updates both the persisted config and the
tree node, then broadcasts `LayoutChanged`. Old persisted records without the field decode
via `Schema.optionalWith(ThinkingLevel, { default: () => 'adaptive' })`.

## Implication

- Any future "change a live query's options" need (model, cwd, permissions) follows the
  same interrupt-and-resume-at-turn-boundary pattern; don't reach for a mutation API that
  doesn't exist.
- The dropdown is intentionally *not* disabled while the pane is working: the
  restart-at-next-turn design makes an anytime change safe, and no "streaming/working"
  attention state exists to gate on (attention is only Idle/AwaitingPermission/Errored/
  Completed).
- The UI thinking disclosure is a plain collapsed `<details>` (no elapsed timer, no
  auto-collapse, no reveal animation) — matches the tool-output disclosure pattern.
