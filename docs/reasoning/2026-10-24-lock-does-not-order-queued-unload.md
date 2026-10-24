# A registry lock does not order a queued `unload` before the next load

**Date:** 2026-10-24

## Context

`PluginRegistry.start()` loads lazy plugins one after another in a background fiber. A plugin the user unloads before its turn must not be loaded afterwards (ADR-0027). The first version checked `entry.status._tag === 'Loading'` inside `lock.withPermits(1)` at the start of each queued load.

## Reasoning / Learning

The test "skips a queued plugin that was unloaded before its turn" failed: `b-late` was opened and then closed (`['b-late:open', 'b-late:close']`). While `a-slow` held the lock, `registry.unload('b-late')` waited on it. When `a-slow` finished, the loading fiber took the lock again for `b-late` before the waiting `unload` ran, so the status was still `Loading` at the check, and the unload ran after the load.

The lock gives mutual exclusion, not first-come ordering between a waiter and a fiber that releases and immediately asks again.

## Implication

Do not express "cancel the queued work" through lock order or through state that the cancelling operation writes only after it holds the lock. The registry keeps a `Set` of names `start` queued; `load` and `unload` remove the name when they are called, before they wait for the lock, and the queued load takes its name out of the set when it begins and skips when the name is absent.
