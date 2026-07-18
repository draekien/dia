---
status: "superseded by ADR-0015"
date: 2026-07-18
decision-makers: William Pei
---

# Use TanStack AI `useChat` with a custom IPC ConnectionAdapter for renderer chat state

## Context and Problem Statement

dia's chat pane hand-rolls its conversation state: a TanStack Query cache holds an append-only timeline of message and tool items, and a set of `window.dia.on*` IPC listeners mutate that cache as the agent streams. As the conversation surface grows (reasoning, richer tool rendering, ret/regenerate, message parts), maintaining a bespoke state model and its streaming reconciliation by hand is increasingly costly. Should the renderer adopt a purpose-built chat-state engine, and if so which one, given that the agent — including tool execution and permission handling — runs in a separate per-pane utility process ([ADR-0003](0003-agent-sdk-runs-in-electron-utility-process.md), [ADR-0007](0007-one-utility-process-per-pane.md)) and the renderer is only a thin observer of an IPC event stream?

## Decision Drivers

* The renderer never calls a model, never executes tools, and never owns the agent loop — all of that lives in the utility process. Any adopted engine must run as a pure *observer* fed by dia's existing IPC events, not assume it drives the conversation.
* Minimize churn to the cross-process IPC contract (`@shared/ipc/contract`) — the engine should adapt to dia, not the reverse — extending it only where a real capability gap exists (tool output was not carried at all).
* Preserve dia's design-owned rendering: the streaming reveal animation and the `rehype-highlight` + line-numbers markdown pipeline (per `src/renderer/CLAUDE.md` and the "native-not-decorative" principle).
* Prefer an internally coherent stack over straddling two AI SDK ecosystems.
* Reduce, not grow, the amount of bespoke streaming-reconciliation code the pane maintains.

## Considered Options

* Keep the bespoke TanStack Query timeline (status quo).
* TanStack AI `useChat` + a custom `ConnectionAdapter` + shadcn's native Base UI chat primitives.
* Vercel AI SDK `@ai-sdk/react` `useChat` + AI Elements.
* TanStack AI `useChat` engine + AI Elements used as presentational views.

## Decision Outcome

Chosen option: **TanStack AI `useChat` + a custom `ConnectionAdapter` + shadcn native chat primitives**, because it is the one internally coherent stack that treats the renderer as a pure sink. TanStack AI's agent loop lives entirely in its server-side `chat()`/`TextEngine`, which dia replaces wholesale with a client-side `ConnectionAdapter` whose `connect(messages)` translates dia's IPC event stream into AG-UI events (built as an Effect `Stream` and handed to `useChat` as an `AsyncIterable` via `Stream.toAsyncIterable`). `useChat` only projects those events into its `messages` state — it does not call a model, does not execute tools, and does not own the loop. shadcn's native `Message`/`Bubble`/`MessageScroller` primitives (the suite the linked shadcn TanStack AI helper is designed for) are plain presentational components with no SDK coupling, so dia keeps feeding its own markdown renderer and reveal animation into them.

Two invariants make the fit safe:

1. **Run boundaries are derived from attention.** dia has no run-lifecycle IPC event. The adapter emits `RUN_STARTED` when `connect()` is invoked and returns when `PaneAttentionChanged` reports a terminal turn state: `Completed` → `RUN_FINISHED` (`finishReason: "stop"`), `Errored` → `RUN_ERROR`. It is deliberately **not** keyed on `Idle` — `Idle` is both the at-rest state and the settle-target `Completed` decays to, so it does not mark a turn's end. A pending permission or clarifying question sits in `AwaitingPermission` (not a terminal state), so `useChat`'s `isLoading` correctly stays true through a blocked turn.
2. **Tool calls are surfaced as already-resolved, with their output.** Tools have already executed in the utility process. The IPC contract is extended minimally so `ToolCallCompleted`/`PaneToolCallCompleted` carry the tool's `output` (and an `isError` flag) alongside the existing `input` — the reducer already receives the SDK `tool_result` block and previously discarded its content. The adapter emits `TOOL_CALL_START/ARGS/END` followed by `TOOL_CALL_RESULT`, and finishes the run with `finishReason: "stop"` — never `"tool_calls"` — so `useChat` renders a fully-resolved tool call and never waits on a client-side execution that will not come (which would otherwise stall `isLoading`). Tool calls that end without a result (turn aborted before the `tool_result` arrived) are flushed with empty output.

Permission and clarifying-question prompts stay **outside** `useChat`, on their existing IPC channels rendered as overlay cards, because they are blocking request/response round-trips and AG-UI's only non-standard-content extension point (`CustomEvent`) is fire-and-forget with no gating. The user message is added optimistically by `useChat`, so the adapter ignores `PaneMessageAppended{role: "user"}` to avoid duplication.

### Consequences

* Good, because the renderer's bespoke streaming-reconciliation logic is replaced by a documented engine, leaving dia to own only a single well-scoped translation module (IPC events → AG-UI events).
* Good, because the change is overwhelmingly renderer-only: the sole main/pane-process change is one additive field (tool `output`/`isError`) threaded through the reducer, pane→main protocol, and main→renderer translation, reusing data the reducer already had in hand.
* Good, because dia retains its own markdown pipeline and reveal animation by composing them into presentational primitives rather than adopting a foreign renderer.
* Bad, because run completion is *inferred* from the `Completed`/`Errored` attention transition rather than signalled explicitly; if a future change let those states fire mid-turn, a run would end prematurely. Mitigation: if this proves fragile, add an explicit run-lifecycle IPC event in a follow-up (a contract change, deliberately deferred).
* Neutral, because `useChat` becomes the source of truth for the message timeline while attention, permission, and question state remain in TanStack Query — two state stores coexist, split along the conversation/control-affordance boundary.
* Neutral, because dia now depends on TanStack AI packages (`@tanstack/ai-react`, `@tanstack/ai-client`) that are young; the adapter isolates that dependency behind the AG-UI event contract.

## Pros and Cons of the Options

### Keep the bespoke TanStack Query timeline

* Good, because no new dependency and no migration.
* Good, because it already works and is fully under dia's control.
* Bad, because every new conversation capability (reasoning, message parts, richer tool state, regenerate) is hand-built and hand-reconciled against the stream.

### TanStack AI `useChat` + custom ConnectionAdapter + shadcn native primitives

* Good, because it is a pure-observer fit: the client is a sink, the adapter is the sole source of truth, no client-side tool execution.
* Good, because it is one coherent ecosystem — the engine and the shadcn helper/primitives are built for each other.
* Good, because the components are presentational, so dia's markdown + reveal rendering survive intact.
* Bad, because the shadcn native primitive set is thinner than AI Elements — tool/reasoning blocks are composed by hand (dia already has these).
* Bad, because it depends on young TanStack AI packages.

### Vercel AI SDK `useChat` + AI Elements

* Good, because AI Elements is the richest prebuilt suite (Conversation, Tool, Reasoning, Sources, …).
* Bad, because it reverses toward a different engine (`@ai-sdk/react`) than the one chosen, and its richer components (`Tool`/`Reasoning`/`Sources`) are typed against Vercel's `UIMessage`/`ToolUIPart` shapes.
* Bad, because it would pull dia's renderer into the Vercel AI SDK ecosystem for no gain over the utility-process architecture dia already has.

### TanStack AI engine + AI Elements as presentational views

* Good, because it keeps the chosen engine while reusing AI Elements' prebuilt UI.
* Bad, because it straddles two ecosystems: dia would map TanStack/IPC data onto Vercel's part-type/state-enum conventions and maintain that shape-mapping glue indefinitely.

## More Information

* The shadcn "TanStack AI helper" (`ui.shadcn.com/docs/helpers/tanstack-ai`) is a mock/demo utility only — it streams scripted conversations with no model, API route, or network — so it is useful for developing/previewing components but is never part of the shipping data path.
* Extends the styling stack of [ADR-0005](0005-tailwind-and-shadcn-ui-for-styling.md) with a chat-specific component family; does not supersede it.
* The renderer's React components stay plain React + TanStack Query/Form, but the connection adapter models the IPC→AG-UI bridge as an Effect `Stream` (`Stream.asyncPush` for scoped subscribe/unsubscribe, `Stream.mapAccum` for the stateful chunk translation, `Stream.toAsyncIterable` at the `useChat` boundary). This reuses the `effect` dependency the renderer already carries via the shared schemas and does not conflict with [ADR-0002](0002-react-typescript-for-renderer.md), which governs the UI framework rather than library choice; it also avoids a hand-rolled async queue and the `@effect/language-service` async-generator diagnostic friction a plain-TS generator would incur.
* Follow-up to reconsider if fragile: an explicit `PaneRunStarted`/`PaneRunFinished` IPC event would remove the attention-derived run-boundary inference noted in Consequences.
