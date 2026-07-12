# `Effect.fn` accepts trailing pipe-transform arguments after the generator body

**Date:** 2026-07-12

## Context

Rewriting `agent-session.ts`'s `runSession` needed to wrap the entire generator body in `Effect.catchAllCause` (to log-and-swallow session failures, matching the original code's `.catch(cause => console.error(...))` behavior) without breaking `Effect.fn`'s single-declaration style into a separate `.pipe()` at every call site.

## Reasoning / Learning

`Effect.fn(name)(body, a, b, ...)` isn't limited to `(body)` — it accepts additional positional functions after the generator body, each of the form `(effect, ...originalArgs) => Effect<...>`, applied left to right to the produced effect. Confirmed from `node_modules/effect/dist/dts/Effect.d.ts` (`namespace fn`, the `Gen` overloads). Passing `(effect, config) => effect.pipe(Effect.catchAllCause(...))` as the second argument lets `runSession(config, promptQueue)` return an already-recovered effect, so every call site doesn't need to remember to attach its own catch-all.

## Implication

When a whole `Effect.fn`-defined workflow needs a blanket recovery/transform (logging, retries, timeouts), prefer passing it as a trailing argument to `Effect.fn` over `.pipe()`-ing at each call site — it keeps the recovery behavior co-located with the function definition and can't be forgotten by a caller.
