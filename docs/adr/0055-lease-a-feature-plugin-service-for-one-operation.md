---
status: "accepted, amended by ADR-0060"
date: 2026-11-07
decision-makers: William Pei
---

# Lease a feature plugin's service for one operation, and close a plugin only after its leases end or 30 seconds pass

## Context and Problem Statement

Host code reads a plugin's service with `registry.inject`, which records nothing, and keeps the value. A pane reads the worktrees plugin's `GitOps` when it opens and calls `removeWorktree` on it when it closes, hours later, after `unload worktrees`, so the unloaded plugin's code still runs. A `plugin_reload meta` during a meta repo push closes the plugin's scope while the push runs. ADR-0019's lifecycle closes a plugin's scope, and its dependants' scopes, without regard to host code that is calling its services. How does dia keep a plugin open while host code calls it, and how does it treat host code that holds a service for hours?

## Decision Drivers

* A plugin reload must not interrupt an agent turn that is streaming (ADR-0019).
* An unload or reload holds the registry lock (`Semaphore(1)`); a wait with no limit blocks every later load and unload (the reason for `PLUGIN_SETUP_TIME_LIMIT`, issue #185).
* Adapter plugins never unload or reload (ADR-0029).
* cordis waits, with no limit, for each fiber that injects a service to unload before it disposes the provider (`cordiverse/cordis` `packages/core/src/fiber.ts:481-489`, `reflect.ts:233-243`), and does not detect a service object kept in a variable. deepseek-harness keeps no whole service object in UI code (`deepseek-ai/deepseek-harness` `packages/client/AGENTS.md:17`) and aborts a running turn when the plugin running it reloads (`packages/core/agent-loop/src/index.ts:494-520`).

## Considered Options

* A lease covers one operation (`registry.use`); host code keeps no service object after it
* A holder keeps its lease for its lifetime (a pane until it closes, a session until it ends)
* Keep `inject` and document that a caller must read again before each operation

## Decision Outcome

Chosen option: "A lease covers one operation", because it matches cordis and deepseek-harness, which read a service again for each operation and keep no service object, it bounds every lease by one call so a 30-second limit is enough, and it never makes a reload wait for, or interrupt, an agent turn.

* `registry.use(key, f)` runs `f` with the value under `key` and holds the providing plugin open until `f` ends. It returns `None` without running `f` while no plugin provides `key` or while its provider is closing.
* Closing a plugin (unload, reload, a failed setup) stops granting leases on it, waits up to `SERVICE_USE_TIME_LIMIT` (30 seconds) for its running leases, then interrupts the rest; a `use` whose `f` has not finished by then fails with `ServiceWithdrawnError`, so a caller can tell it from a service that was not provided. cordis has no limit; dia keeps one so the registry lock is never held forever.
* Host code keeps data (for example `WorktreeInfo`) across operations, never a service object. A pane calls `use` again when it closes.
* `registry.inject` stays, without a lease, for two cases: a service an adapter plugin provides, and a value read again each time `changes` emits its key (the renderer's `Slot`). The registry does not enforce this; the Biome plugin `biome-plugins/noRegistryInject.grit` fails `pnpm lint` on every `.inject(...)` call under `src/` outside tests, and each allowed caller suppresses it with its reason. An `AgentSession` keeps running adapter code after the read that started it; this is allowed only because an adapter never unloads or reloads (ADR-0029). If an adapter ever becomes reloadable, its readers must move to `use`.
* Plugin-to-plugin reads (`ctx.inject`) hold no lease: a plugin that reads a service declares it, and closing the provider closes that plugin first.
* App shutdown closes plugin scopes without waiting for leases.

### Consequences

* Good, because unloading or reloading a feature plugin no longer closes it under a running call, and a call that starts after the unload gets `None` instead of the old plugin's code.
* Good, because an agent turn is never interrupted by a feature plugin reload: a turn holds no lease.
* Bad, because a reload can take up to 30 seconds while a long call (a push to a slow remote) runs, and other loads wait for the registry lock meanwhile.
* Bad, because after the 30 seconds an interrupted call runs until its next interruptible point, concurrently with the plugin's finalizers; a call in an uninterruptible region (a scope finalizer) keeps running after the plugin's scope closes. Its caller still returns at once.

## Pros and Cons of the Options

### A holder keeps its lease for its lifetime

* Good, because a pane would use the same `GitOps` from open to close.
* Bad, because every unload of `worktrees` would wait 30 seconds and then interrupt each open worktree pane's lease; neither cordis nor deepseek-harness has a lease that outlives an operation.
* Bad, because a session holding a feature service would be interrupted by a reload, against ADR-0019.

### Keep `inject` and document that a caller must read again before each operation

* Good, because it needs no registry change.
* Bad, because a reload still closes the plugin while a call runs (the meta push).

## More Information

* Amends ADR-0019's plugin lifecycle (closing a plugin) and relies on ADR-0029 (adapters do not reload).
* Design: `docs/designs/plugin-service-leases.md`. Issue #187.
