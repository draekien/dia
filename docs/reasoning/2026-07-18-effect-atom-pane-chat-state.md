# Pane chat state in effect-atom: registry-held durability, idle-TTL disposal, and an implicit streaming turn

**Date:** 2026-07-18

## Context

Splitting a pane *mid-turn* froze the streaming response (the
[useChat wiring](2026-07-18-usechat-pane-wiring.md) known gap): a split remounts
the surviving `Pane`, and `useChat`'s component-local state died with it. ADR-0015
replaced TanStack AI with effect-atom + a direct IPC-event reducer. Building it
surfaced a few non-obvious points about effect-atom and about modelling the
streaming turn.

## Reasoning / Learning

- **The default registry is already a process-global singleton, so no
  `RegistryProvider` is needed for remount durability.**
  `@effect-atom/atom-react`'s `RegistryContext` is
  `React.createContext(Registry.make(...))` — the default value is created once at
  module load, outside the React tree. `useAtomValue` reads it without any
  provider. A component remount (the split) re-attaches to the *same* atom, whose
  `SubscriptionRef` and forked IPC subscription never stopped. Mounting a
  `RegistryProvider` is only for scoping/overrides (e.g. a per-window registry or
  `defaultIdleTTL`); we deliberately don't, keeping wiring to zero.

- **Atom lifetime: idle-TTL is the disposal mechanism; there is no per-node
  registry remove.** An `Atom.family` memoises one atom per `paneId` in the
  registry, and the registry exposes no "evict this node" call. Bare, an atom is
  disposed the moment its subscriber count hits zero — which a remount briefly
  causes, tearing down the IPC subscription we're trying to preserve.
  `Atom.setIdleTTL(Duration.seconds(30))` bridges that zero-subscriber window: the
  atom (and its forked fold fiber → IPC listeners) survives the remount and is
  disposed only ~30s after the pane is truly gone. Bounded risk: reusing a
  `paneId` within the TTL could surface stale state, but only the last-pane-close
  reset reuses an id, behind a multi-second recreate flow. Revisit with explicit
  close-eviction if it bites.

- **`Atom.subscriptionRef(effect)` gives `Writable<Result<A,E>, A>`: read is a
  `Result`, write is a bare `A`.** So `useAtomValue` yields `Result<PaneChatState>`
  (pending until history loads) — unwrap with `Result.getOrElse(..., () =>
  emptyPaneChatState)` at the component and in the send action. Writing sets the
  underlying ref directly, and the forked fold fiber's subsequent
  `SubscriptionRef.update`s build on the written value — this is what makes the
  optimistic user-message append persist and later deltas fold on top of it.

- **The "current streaming turn" needs no stored id — it's derivable from the
  public state.** The reducer folds into `{ messages, isLoading }` with *no*
  hidden `streamingId` field (contrast the removed adapter's `TranslationState`
  with its open-message ids). The rule: a delta extends the trailing message iff
  it is an assistant message *and* `isLoading` is true; otherwise it opens a new
  assistant message. `appendUserMessage` sets `isLoading` true, and only a
  terminal attention (`Completed`/`Errored`) clears it — so the trailing-assistant
  window is exactly one turn. This keeps every field of the state view-meaningful
  (nothing to hide from `MessageView`) and the reducer pure/total, mirroring the
  main-process `agent-session-reducer.ts`. `PaneMessageAppended{assistant}` is only
  a backstop: it appends the final text *only* when no deltas built the turn (i.e.
  not currently streaming an assistant message).

- **The `Stream.asyncPush` scoped subscribe/unsubscribe survived the rewrite; the
  AG-UI translation did not.** The IPC fold reuses the exact
  `Stream.asyncPush((emit) => Effect.acquireRelease(subscribe, unsubscribe))`
  pattern from the deleted adapter (a single `push` typed over the
  `PaneStreamEvent` union, relying on parameter contravariance so one handler
  satisfies all six `on*` listener types). What's gone: `mapAccum` +
  `StreamChunk` emission + `toAsyncIterable`. Instead the stream is run for its
  effects — `Stream.runForEach` folding each event into the `SubscriptionRef` via
  the pure `reducePaneChat` — forked with `Effect.forkScoped` so it lives for the
  atom's scope.

## Implication

- Renderer state that must outlive a component (survive remounts) belongs in an
  effect-atom family in the global registry, not in component-local state; pair it
  with `setIdleTTL` to bridge the zero-subscriber remount window.
- When modelling a streaming/append log, prefer deriving "what's open" from the
  already-public state over a private cursor field — it keeps the state fully
  view-meaningful and the reducer total.
- The `asyncPush` IPC-subscription pattern is the renderer's canonical way to turn
  `window.dia.on*` callbacks into an Effect `Stream`; new pane-event consumers
  should fold with a pure reducer into a `SubscriptionRef`, not translate to a
  foreign protocol.
