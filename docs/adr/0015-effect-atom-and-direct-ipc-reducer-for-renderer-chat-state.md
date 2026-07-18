---
status: "accepted"
date: 2026-07-18
decision-makers: William Pei
---

# Use effect-atom and a direct IPC-event reducer for renderer chat state

## Context and Problem Statement

[ADR-0014](0014-tanstack-ai-usechat-for-renderer-chat-state.md) adopted TanStack AI `useChat` + `ChatClient`, fed by a custom IPC→AG-UI `ConnectionAdapter`, as the pane's chat-state engine. In use, two problems surfaced. First, `useChat`'s message/run state is component-local: splitting a pane remounts the surviving `Pane` (its parent chain gains a `ResizablePanelGroup`), which destroys the state; because `ChatClient` only subscribes to the IPC stream inside `connect()` and `connect()` runs only from `sendMessage`, a mid-stream split leaves the remounted pane a passive observer that never re-attaches — the response freezes mid-turn (a documented "known gap" in `docs/reasoning/2026-07-18-usechat-pane-wiring.md`). Second, fixing that by hoisting the client out of React means dropping `useChat` (the React binding) and driving `ChatClient` directly — at which point the engine no longer earns its keep: dia already hand-writes the IPC→AG-UI translation, so `ChatClient` only performs a *second* assembly on top, giving a double translation (**IPC → AG-UI → messages**) where dia owns the first hop and rents the second. Given that, should the renderer keep TanStack AI at all, or hold chat state in an Effect-native store fed directly from IPC?

## Decision Drivers

* Streaming must survive a split remount — the pane's chat state has to outlive the component that renders it.
* The renderer is a pure observer of a per-pane IPC event stream (per ADR-0003/0007); the state layer should reflect that, not assume it drives a conversation.
* Reduce translation layers and hand-maintained reconciliation, not grow them — ADR-0014's own driver.
* Prefer one coherent state model over straddling ecosystems, and isolate/limit young third-party dependencies.
* Keep dia's design-owned rendering (markdown pipeline, shadcn presentational primitives) intact.

## Considered Options

* Keep TanStack AI `ChatClient`, but hold it in an effect-atom family so it survives remounts (persist-the-client).
* Drop TanStack AI entirely: hold chat state in effect-atom, fed by a direct IPC-event reducer.
* Prevent the remount by restructuring `PaneTreeView` so a leaf's ancestor chain stays stable across a split.

## Decision Outcome

Chosen option: **drop TanStack AI and hold chat state in effect-atom, fed by a direct IPC-event reducer**, superseding ADR-0014. The renderer already owns the hard part of streaming reconciliation (the current adapter's `translateEvent` tracks open text/thinking parts and closes them on tool boundaries); this decision *relocates* that logic from "emit AG-UI chunks" into a pure reducer that folds IPC events straight into a small message-parts model, deleting both the AG-UI adapter and the `ChatClient` layer between them.

The state lives in a per-pane `Atom.family` (`@effect-atom/atom` + `@effect-atom/atom-react`). Each pane's atom is an `Atom.subscriptionRef` whose scoped constructor fetches the pane's history, seeds a `SubscriptionRef<PaneChatState>`, and forks (scoped) a `Stream` of that pane's `window.dia.on*` IPC events, folding each event into the ref via the pure reducer. `useAtomValue` binds the component to it. Three properties follow:

1. **Remount durability without a snapshot dance.** The atom lives in the effect-atom `Registry`, which is outside the React tree, so a split remount re-attaches to the *same* atom — its `SubscriptionRef` and forked IPC subscription never stopped. This removes the `resolveInitialMessages`/messages-mirror workaround ADR-0014 needed, and closes the mid-turn gap entirely: the subscription is continuous (not gated on `sendMessage`), so nothing is dropped across a remount.
2. **Lifetime is idle-TTL-managed.** `Atom.setIdleTTL` keeps a pane's atom alive across the brief zero-subscriber window a remount creates, then disposes it (interrupting the forked fiber → releasing IPC subscriptions) once the pane is truly gone (closed). There is no per-node registry removal API; idle-TTL is the disposal mechanism.
3. **Sending is a separate, explicit action.** The renderer never routed user turns through the observer stream. On submit, the pane optimistically appends a user message to the atom (a pure `appendUserMessage`) and calls `window.dia.sendMessage`; the assistant reply arrives back through the same IPC fold. `PaneMessageAppended{role:"user"}` stays ignored (no duplication), and the reducer derives `isLoading` from attention exactly as ADR-0014 did (`Completed`/`Errored` end the turn; `AwaitingPermission` keeps it loading).

Permission, clarifying-question, and attention state stay on TanStack Query with their existing `on*` IPC effects, unchanged — the conversation/control-affordance split from ADR-0014 is preserved. shadcn's `Message`/`Bubble`/`MessageScroller` primitives are presentational and stay; only the message *type* they render changes from `@tanstack/ai-client`'s `UIMessage` to dia's local parts model.

### Consequences

* Good, because the split-mid-stream freeze is fixed at its root (component-tied state lifetime) rather than compensated for, and the in-flight-delta gap is eliminated by a continuous, registry-held subscription.
* Good, because a whole translation layer disappears: IPC → AG-UI → messages collapses to IPC → messages, deleting `ipc-connection-adapter.ts` (+ tests) and the `@tanstack/ai-react`/`@tanstack/ai-client` dependencies.
* Good, because the reducer is a pure, exhaustively testable function (mirroring the main-process `agent-session-reducer.ts` pattern), and the atom composes the IPC stream dia already models with `Stream.asyncPush`.
* Good, because it introduces one coherent Effect-native renderer state store (effect-atom) that later renderer state can also adopt.
* Bad, because dia now owns the message-parts model and its rendering types outright (previously borrowed from TanStack AI); the payoff is full control over dia's exact domain (thinking parts, tool parts with resolved output).
* Bad, because it reverses a recent decision (ADR-0014) and adds a still-young dependency (effect-atom) in place of the ones removed; mitigated by the reducer/atom being small and behind dia's own types.
* Neutral, because run completion is still *inferred* from the `Completed`/`Errored` attention transition (unchanged from ADR-0014); the same explicit-run-lifecycle-IPC follow-up remains available if it proves fragile.
* Neutral (minor risk), because idle-TTL disposal means a closed pane's atom lingers briefly; reusing a paneId within the TTL (only the last-pane-close reset reuses `initialPaneId`) could surface stale state. Bounded by the TTL and the multi-second directory-picker recreate flow; revisit with explicit close-eviction if it bites.

## Pros and Cons of the Options

### Keep ChatClient, persist it in an effect-atom family

* Good, because it is the smallest diff and leaves ADR-0014 intact.
* Good, because it still fixes remount durability (the client outlives the component).
* Bad, because it keeps the double translation (IPC → AG-UI → messages) and the young `@tanstack/ai-*` dependencies for a `ChatClient` whose React binding — the part that made it worthwhile — is no longer used.
* Bad, because closing the in-flight-delta gap needs a heal step (reconcile on `PaneMessageAppended`), since the client only subscribes during a `sendMessage` run.

### Drop TanStack AI; effect-atom + direct IPC reducer

* Good, because it removes a dependency and a translation layer while fixing the bug and the gap more directly.
* Good, because it fits Effect/effect-atom idiomatically and matches dia's existing pure-reducer pattern.
* Bad, because dia rebuilds the message-parts model and adapts `MessageView` to it, and reverses a two-day-old ADR.

### Prevent the remount in `PaneTreeView`

* Good, because it needs no chat-state change — `useChat` state would simply survive.
* Bad, because a leaf's ancestor chain genuinely changes shape on split; keeping it stable across arbitrary tree depths is fragile React-reconciliation gymnastics (a stable `key` cannot prevent a parent-chain change), and it leaves the double-translation critique unaddressed.

## More Information

* Supersedes [ADR-0014](0014-tanstack-ai-usechat-for-renderer-chat-state.md). Retains ADR-0014's invariants that still hold: attention-derived run boundaries, tool calls surfaced already-resolved with output, and permission/question prompts kept out-of-band as overlay cards.
* Extends, does not supersede, [ADR-0005](0005-tailwind-and-shadcn-ui-for-styling.md): the shadcn chat primitives remain; only their message type changes.
* The IPC→state fold reuses the `Stream.asyncPush` scoped subscribe/unsubscribe pattern from the removed adapter (see `docs/reasoning/2026-07-18-ipc-agui-adapter-as-effect-stream.md`); the AG-UI chunk translation and `Stream.mapAccum` are replaced by the pure reducer + `SubscriptionRef`.
* Follow-up if fragile: an explicit `PaneRunStarted`/`PaneRunFinished` IPC event (still deferred), and explicit per-pane atom eviction on close if idle-TTL lingering proves problematic.
