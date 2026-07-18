# IPC→AG-UI connection adapter is an Effect `Stream`, not an async generator

**Date:** 2026-07-18

## Context

ADR-0014 adopts TanStack AI `useChat` driven by a custom `ConnectConnectionAdapter`
whose `connect(messages)` must return `AsyncIterable<StreamChunk>`. The first cut wrote
`connect` as `async function*` with a hand-rolled promise-based event queue bridging
`window.dia.on*` IPC callbacks into the generator. That tripped `@effect/language-service`:
`newPromise` (the queue) and `asyncFunction` (the generator) both fire as warnings, and
warnings fail `pnpm typecheck`/`pnpm diagnostics`. Worse, the inline `asyncFunction:off`
directive on the async **generator** produced a paradox — with the directive present the
tool reported `TS377000 "directive has no effect"`, with it removed `TS377081 asyncFunction`
fired. Both fail the build; the no-effect checker doesn't credit an async-generator
suppression even though the suppression works.

## Reasoning / Learning

The renderer already carries the `effect` dependency (shared schemas import it), and
ADR-0002 only governs the UI framework (React vs Svelte), not library choice — so modelling
the adapter with Effect is free and non-conflicting. Rewriting the bridge as a `Stream`
removes the async generator and the hand-rolled queue entirely:

- `Stream.asyncPush<PaneStreamEvent>((emit) => Effect.acquireRelease(subscribe, unsubscribe))`
  — register the five `window.dia.on*` listeners (and the abort listener) on acquire, push
  each event with `emit.single`, `emit.end()` on abort; the scope's release unsubscribes.
  Cleanup is guaranteed whether the run ends normally, errors, or `useChat` tears the stream
  down early.
- `Stream.mapAccum(state, translate)` threads the one piece of cross-event state (the open
  assistant text-message id) purely; `translate` returns `readonly [state, ReadonlyArray<StreamChunk>]`
  and `Stream.mapConcat((cs) => cs)` flattens the per-event chunk batches.
- `Stream.takeUntil(isRunTerminal)` ends the stream after the `RUN_FINISHED`/`RUN_ERROR`
  chunk (attention-derived, per ADR-0014), which closes the scope and releases subscriptions.
- `Stream.make(runStarted).pipe(Stream.concat(translated), Stream.toAsyncIterable)` — the
  `RUN_STARTED` prefix plus the boundary conversion. `Stream.toAsyncIterable` needs `R = never`
  (the whole pipeline is `Stream<StreamChunk, never, never>`) and runs on the default runtime.

**Non-obvious consequence for tests:** `Stream.concat` subscribes the body stream lazily,
only on the pull *after* the `RUN_STARTED` prefix drains — so the IPC listeners are registered
later than they were with the eager async generator, and register on an Effect fiber
(asynchronously) rather than synchronously. A test that emits events by calling the mock's
listeners *between* manual `.next()` calls races the subscription and drops events. Drive the
test through the mock's `sendMessage` hook instead: the adapter registers all listeners and
the abort listener *before* it calls `window.dia.sendMessage`, so firing the scripted IPC
events (or an abort) from the mock's `sendMessage` guarantees they land on live listeners.
This also models reality — main only streams a response once it has received the message —
and lets the test just `for await` the whole iterable to completion.

## Implication

- Keep the adapter as a `Stream`; don't revert to `async function*` (re-introduces the
  queue + both diagnostics + the async-generator no-effect paradox).
- New IPC→chunk mapping goes in the pure `translate`/`mapAccum` step, mirroring how
  SDK→protocol mapping lives in the pure `agent-session-reducer.ts` — unit-test it at the
  `AsyncIterable` boundary (what `useChat` actually consumes), not the `Stream` internals.
- `tsconfig.test.json` sets `asyncFunction: "off"` because vitest test bodies are plain
  `async` at the non-Effect consumer boundary (Effect-based tests use `@effect/vitest`
  `it.effect`); this is test-only and doesn't relax node/web.
- The `asyncFunction`/`newPromise` diagnostics are a real signal in the renderer too: reach
  for Effect `Stream`/`Effect` rather than suppressing, now that Effect is an accepted tool
  in renderer library modules (not components).
