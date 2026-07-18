# Wiring `useChat` into the pane: lazy connect, initialMessages-once, and the paneId remount gate

**Date:** 2026-07-18

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
