# Wiring `useChat` into the pane: lazy connect, initialMessages-once, and the paneId remount gate

**Date:** 2026-07-18

> **Superseded (2026-07-18) by [ADR-0015](../adr/0015-effect-atom-and-direct-ipc-reducer-for-renderer-chat-state.md).**
> `useChat` and the IPC→AG-UI adapter were dropped for effect-atom + a direct
> IPC-event reducer; `pane.tsx` no longer uses any of the wiring below. The
> "known gap" (a split *mid-turn* freezing the response) was this document's
> unresolved bug and is what motivated the rewrite — it is now fixed at the root
> (registry-held, remount-durable state). Kept as a historical record of why the
> `useChat` approach was abandoned; see
> [effect-atom pane chat state](2026-07-18-effect-atom-pane-chat-state.md) for the
> current design.

## Context

ADR-0014 adopts TanStack AI `useChat` as the pane's chat-state engine, driven by
the IPC→AG-UI `ConnectionAdapter`. Wiring it into `pane.tsx` surfaced three
non-obvious behaviours of `useChat`/`ChatClient` that shape how the pane mounts.

## Reasoning / Learning

- **`connect()` is lazy; nothing fires on mount unless `live` is set.**
  `use-chat.js` only calls `client.subscribe()` inside an effect gated on
  `options.live`; otherwise `connect()` runs solely from `sendMessage`/`reload`.
  This matters because dia's adapter has a *side effect* in `connect` — it calls
  `window.dia.sendMessage(paneId, latestUserText)`. If we ever pass `live: true`,
  mounting a pane would immediately re-send the last user turn to the utility
  process (a phantom run). **Do not pass `live`** — the pane is an observer that
  only opens a connection when the user submits.

- **`initialMessages` is read once, at `ChatClient` construction.** Later prop
  changes to `initialMessages` are ignored (only `connection`/`body`/`tools`
  changes recreate the client). Pane history is fetched async via
  `getPaneHistory`, so the client must not be created until history resolves.
  Solution: gate on the history `useQuery` in `Pane` (render nothing until
  settled) and mount `PaneChat` with `key={paneId}`. The key guarantees a fresh
  client per pane and a clean remount if the pane identity changes, instead of
  reaching for `chat.setMessages` in an effect.

- **Two state stores coexist by design.** `useChat` owns the message timeline;
  attention (pulse), pending permission, and pending question stay in TanStack
  Query with their own `on*` IPC effects. The four message/tool `on*` effects
  the old pane carried are gone — those events are now the adapter's job. The
  attention/permission/question effects remain because they are *not* part of
  the chat stream (permission/question are excluded per ADR-0014, and attention
  drives the pulse independently).

- **`useChat` message state is component-local, so a remount blanks the pane —
  splitting forces exactly that remount.** `PaneTreeView` renders a split as a
  nested `ResizablePanelGroup`, so splitting a leaf moves the surviving `Pane`
  from a direct child to inside a new group: its position in the React tree
  changes and React remounts it (a stable `key={paneId}` cannot prevent a
  parent-chain change). `useChat`'s in-memory `messages` die with the unmount,
  and `getPaneHistory` returns the *persisted* transcript, which does not yet
  contain the live session's turns — so the remounted pane came back **blank**.
  The old bespoke timeline never had this bug because it lived in the global
  TanStack Query cache, which is independent of component mount lifecycle. Fix:
  mirror `chat.messages` into the Query cache (`['pane', paneId, 'messages']`) on
  every change, and seed `initialMessages` from that snapshot when present,
  falling back to mapped history (`resolveInitialMessages`). This restores the
  remount durability the Query-cache timeline had for free. Known gap: a split
  *mid-turn* still loses in-flight deltas, because `useChat` only reconnects the
  adapter on `sendMessage` (and we must not set `live` — see above); the snapshot
  only preserves what had streamed before the remount.

Rendering notes worth keeping: tool output is read directly off the `tool-call`
part (`part.output`), and the separate `tool-result` part is skipped to avoid
duplication. The streaming reveal animation applies only to the *final text
part of the last assistant message while `isLoading`* — a text→tool→text turn
renders as multiple parts, and only the growing tail should animate. Thinking
parts are not rendered because the adapter emits no thinking chunks.

## Implication

- Never enable `live` on the pane's `useChat` while `connect` sends the user
  message — it would double-send on mount.
- Async initial history → keep the `key={paneId}` remount gate; don't switch to
  mutating `initialMessages` or calling `setMessages` post-mount unless the
  once-at-construction behaviour changes upstream.
- DOM component tests now exist: `.test.tsx` files run under jsdom via a
  per-file `// @vitest-environment jsdom` docblock (`@testing-library/react` +
  `jsdom`, with `@vitejs/plugin-react` added to `vitest.config.ts`). Test the
  prop-driven `MessageView` with hand-built `UIMessage[]`, not `useChat` itself.
