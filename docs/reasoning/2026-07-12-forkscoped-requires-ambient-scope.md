# `Effect.forkScoped` silently requires `Scope` at the fork call site, not just somewhere in the fiber

**Date:** 2026-07-12

## Context

`PaneSupervisor`'s `applyAttention` needed to fork a ~3s auto-settle timer (`Completed` → `Idle`) that cancels itself if superseded by a newer attention event. The natural first instinct was `Effect.forkScoped`, since the pane's lifetime is already scope-bound elsewhere (`openPane` runs under `Effect.scoped`).

`applyAttention` is called from three different places: the long-lived stream-processing fiber inside `startProcess` (forked while `Scope.Scope` was ambient in its environment), `handle.resolvePermission` (called from the same context), and `handle.markErrored`, which `openPane`'s crash-handling exit-stream listener calls from a *separately forked* fiber that never had `Scope.Scope` provided.

## Reasoning / Learning

Effect resolves an effect's requirements (its environment) at the point it is *forked*, not lazily at the point some inner combinator like `forkScoped` runs. Whether `Scope.Scope` is in the environment depends on which fiber lineage `applyAttention` happens to be invoked from — it is not a property of the function itself, and nothing at the type level flagged the mismatch here because both call sites type-checked fine (the ambient `Scope` was available transitively in one lineage and not the other, both compiling against the same signature).

Concretely: `Effect.forkScoped` inside `applyAttention` would work when called from the stream-processing fiber (which does have `Scope.Scope` ambient from where it was forked), but would fail/hang or behave unexpectedly when called via `handle.markErrored` from `openPane`'s exit-handler fiber, which was forked without a `Scope` in its environment.

The safer fix was to sidestep the whole problem: use a fork that takes its scope as an argument instead of reading it from the environment, and manage supersession manually by storing the `Fiber` and calling `Fiber.interrupt` on it. This was first written with a plain `Effect.fork`; Effect v4 has no `Effect.fork`, and `src/host/services/pane-supervisor.ts` now uses `Effect.forkIn(paneScope)`, which closes the timer fiber with the pane's scope and does not depend on which call site has `Scope` ambient. `Effect.forkChild` also has no `Scope` requirement, but it ties the child to the forking fiber, which ends when the caller returns.

## Implication

When a function forked from multiple call sites needs scoped resource semantics, don't assume `Scope.Scope` is uniformly available just because *some* caller has it. Either thread `Scope` explicitly through the function's requirements (so the type system forces every caller to provide it) or avoid `forkScoped`: pass the scope explicitly with `Effect.forkIn(scope)` and interrupt the stored fiber with `Fiber.interrupt`. Check what environment was ambient at each fork point in the call graph, not just at one of them.
