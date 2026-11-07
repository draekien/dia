# Plugin service leases (issue #187)

Scope: `makePluginRegistry` in `src/shared/plugin/plugin-registry.ts` gains `use`, per-open lease state and a drain before every close of a plugin scope; the worktrees and meta seams (`src/host/services/worktrees-seam.ts`, `src/host/services/meta-repo-seam.ts`) and their callers (`pane-supervisor.ts`, `pane-workspace.ts`, `rpc-handlers.ts`) move from `inject` to `use`. This spec is committed as `docs/designs/plugin-service-leases.md`. ADR-0055 records the lifecycle rule; ADR-0019 gains an "Amended by ADR-0055" line; `docs/adr/README.md` gains its index row.

## Purpose

Host code reads a feature plugin's service with `registry.inject` and calls it with nothing recording the call, so `unload` or a reload closes the plugin's scope while the call runs, and a pane keeps the `GitOps` it read at open and calls it at close, hours later, after `unload worktrees`. After this change a caller borrows a feature service for one operation through `use`; closing the provider waits for those operations, up to a limit.

Success criteria (confirmed with the user):

1. `unload` of a provider waits for a running `use` to finish before the provider's finalizers run.
2. A `use` that runs past the limit is interrupted, the unload completes, and the interruption is logged (`TestClock`).
3. `use` after the provider unloaded returns `None` and does not call `f`.
4. In the dev app, closing a worktree pane after `unload worktrees` does not run the worktrees plugin's code (log).

## Interface

`src/shared/plugin/plugin-registry.ts`:

```ts
/**
 * How long closing a plugin waits for the `use` calls that hold its services before it
 * interrupts them.
 */
export const SERVICE_USE_TIME_LIMIT: Duration.Duration = Duration.seconds(30)

/**
 * Failure of {@link PluginRegistry.use} when the plugin providing the service closed while `f`
 * ran and `f` did not finish within {@link SERVICE_USE_TIME_LIMIT}; `f` may have partly run.
 * `message` names the plugin and the key.
 */
export class ServiceWithdrawnError extends Data.TaggedError('ServiceWithdrawnError')<{
  readonly key: string
  readonly plugin: string
  readonly message: string
}> {}

export interface PluginRegistry {
  readonly use: <A, E, R>(
    key: string,
    f: (value: unknown) => Effect.Effect<A, E, R>
  ) => Effect.Effect<Option.Option<A>, E | ServiceWithdrawnError, R>
}
```

The other `PluginRegistry` members keep their types.

`PluginRegistry` JSDoc gains: "`use` runs `f` with the value a loaded plugin provides under a service key and returns `Some` of its result. It returns `None` without running `f` while no plugin provides the key or while its provider is closing. It fails with {@link ServiceWithdrawnError} when the provider closed while `f` ran and `f` did not finish within {@link SERVICE_USE_TIME_LIMIT}, and with `f`'s error when `f` fails. Closing a plugin, by `unload`, a reload or a failed setup, first waits for the `use` calls on its services to end. Do not keep the value after `f` returns; call `use` again for the next operation." Its `inject` sentence becomes: "`inject` reads the value under a service key without holding the provider open. Use it only for a service an adapter plugin provides (adapters never unload) or for a value read again each time `changes` emits its key (the renderer's `Slot`)."

`worktrees-seam.ts` — `resolveGitOps` is replaced by:

```ts
/**
 * Runs `f` with the {@link GitOps} the loaded `worktrees` plugin provides, holding the plugin open
 * until `f` ends. Returns `None` without running `f`, after logging why, when the plugin is not
 * loaded, is closing, or provides a value without every `GitOps` operation. Fails with `f`'s error,
 * or with `ServiceWithdrawnError` when the plugin closed while `f` ran.
 */
export const withGitOps: <A, E, R>(
  registry: Pick<PluginRegistry, 'use'>,
  f: (gitOps: GitOps) => Effect.Effect<A, E, R>
) => Effect.Effect<Option.Option<A>, E | ServiceWithdrawnError, R>
```

`meta-repo-seam.ts` — `withMetaRepo(registry, run)` (its callback parameter renamed from `use` to `run`) and `resolveSessionAdditions(registry)` keep their return types and never fail; `registry` becomes `Pick<PluginRegistry, 'use'>`.

## Behaviour

### Lease state (private)

```ts
interface Leases {
  closing: boolean
  readonly active: Map<Fiber.Fiber<unknown, unknown>, string>
  readonly drained: Deferred.Deferred<void>
  readonly withdrawn: Deferred.Deferred<void>
}
```

`active` maps each running lease's fiber to the service key it was granted for.

`Entry` gains `leases: Leases | undefined`. `open` creates a fresh `Leases` at the `Scope.fork` that creates the plugin's scope (after the Waiting and no-setup early returns), so a `use` of a key the setup provides is counted from the moment the key is in `slots`. The `swap` rollback reopens the previous version through `open`, so it gets a fresh `Leases`.

### `use(key, f)`

`Effect.acquireUseRelease`:

- acquire (uninterruptible, so no caller interruption can fall between the check and the registration): read `slots.get(key)` and `entries.get(slot.owner)?.leases`. When the slot is absent, or `leases` is absent or `closing`, the acquire returns that outcome and nothing is registered. Otherwise `Effect.forkDetach(f(slot.value), { startImmediately: true })` and `leases.active.set(fiber, key)` in the same acquire, which returns `{ leases, fiber, key, plugin }`. `forkDetach` creates the fiber interruptible whatever the acquire's region (`forkUnsafe`, `internal/effect.ts:5557-5579`, does not inherit interruptibility unless asked), so `Fiber.interrupt` stops `f` at its next interruptible point.
- use: not provided → log debug `No plugin provides the service` `{ key }`, return `None`. Closing → log debug `The plugin providing the service is closing` `{ key, plugin }`, return `None`. Registered → `Effect.raceFirst(Fiber.await(fiber), Deferred.await(leases.withdrawn))`. Both sides are interruptible and `raceFirst` (`internal/effect.ts:1787`, through `raceAllFirst` at 1708-1744) does not wait for the loser, so an `f` stuck in an uninterruptible region does not hang the caller. The fiber's exit gives `Some(a)` or `Effect.failCause(cause)` (the cause unchanged, including an `f` that interrupts itself). Withdrawn → log warning `A call using the service ended because its plugin closed` `{ key, plugin }`, fail with `ServiceWithdrawnError` (`The "<plugin>" plugin closed while a call using "<key>" was running`).
- release (only when registered; it and the withdrawn branch use the captured `leases`, never `entry.leases`, which `closePlugin` clears): delete the fiber from `active`; if `leases.closing` and `active` is empty, complete `drained`; `Effect.forkDetach(Fiber.interrupt(fiber))`, so a caller that is itself interrupted stops `f`.

`f` runs in a detached fiber that inherits the caller's context, including a `Scope.Scope` the caller provides, as `withinTimeLimit` (#185) does; `docs/reasoning/2026-11-06-timeout-waits-for-uninterruptible-loser.md` explains the detached fork and `startImmediately`.

### Closing a plugin

A private `closePlugin(name, entry, scope, exit)` replaces each `Scope.close` of a plugin scope: `closeWithDependants`, and both failure branches of `open` (setup failed or timed out; adapter contract not met).

`closePlugin` runs uninterruptibly except the wait in step 2 (`Effect.uninterruptibleMask`), so an interrupted unload still runs steps 3 and 4.

1. `leases.closing = true` (new `use` calls now return `None`).
2. If `active` is non-empty: log info `Waiting for calls that use the plugin's services` `{ plugin, calls: active.size }`, then `Deferred.await(drained).pipe(Effect.timeoutOption(SERVICE_USE_TIME_LIMIT))`, restored to interruptible and run with `Effect.exit`.
3. On timeout or interruption of the wait, with `active` still non-empty: log warning `Interrupted calls that still used a closing plugin` `{ plugin, keys: [...active.values()] }`, complete `withdrawn` (each waiting `use` fails with `ServiceWithdrawnError` at once), and `Effect.forkDetach(Fiber.interrupt(fiber))` for each fiber in `[...leases.active.keys()]`; a release after this completes `drained` a second time, which `Deferred.succeed` ignores; the close does not wait for them.
4. `entry.leases = undefined`, then `Scope.close(scope, exit)`. From step 4 until `Scope.close` removes the slots, a `use` of the plugin's keys returns `None` through the absent-`leases` branch.

`closeWithDependants` closes dependants first (unchanged), so a dependant's leases drain before its provider's. Plugin-to-plugin reads (`ctx.inject`, #186) hold no lease; they are covered by that ordering.

Limits:
- After a timeout, an interrupted `f` stops at its next interruptible point; until then it runs concurrently with the plugin's finalizers. An `f` in an uninterruptible region (for example a scope finalizer) keeps running after the scope closes. #185 documents the same limit for setups.
- On the setup-failure branch, `closePlugin` can add up to `SERVICE_USE_TIME_LIMIT` to a failed load when a `use` of a key the setup already provided is running.
- A `use` whose `f` calls `registry.load` or `unload` while that plugin is closing waits on the registry lock held by the close; after `SERVICE_USE_TIME_LIMIT` it is withdrawn and the close continues. No call in `src/` does this.
- When the registry's own scope closes (app shutdown), plugin scopes close as children of it without `closePlugin`; running `use` calls are not waited for.

### Callers

| Caller | Before | After |
| --- | --- | --- |
| `pane-supervisor.ts` `openPane` (worktree request) | `resolveGitOps`; keeps `gitOps` for `setUpWorktreeTab` and for the release of `acquire` | `withGitOps(plugins, (gitOps) => setUpWorktreeTab({ …, gitOps, acquire }))`, run with the pane scope provided as today. `None` keeps today's not-loaded branches (Reattach → `WorktreeReattachError` "Load the worktrees plugin to resume this pane"; Create → warning and project directory). `ServiceWithdrawnError` → the open fails with `WorktreeCreateError` or `WorktreeReattachError` (by the request's tag) whose `cause` is the error's message. |
| release of `acquire` (pane close) | `gitOps.removeWorktree(info, paneId)` with the `gitOps` read at open | `withGitOps(plugins, (gitOps) => gitOps.removeWorktree(info, paneId))`; `None` → log warning `Left the pane worktree on disk because the worktrees plugin is not loaded` `{ paneId, path }`; failures keep the existing `Failed to remove pane worktree` log |
| `pane-workspace.ts` `removeWorktree` | `resolveGitOps` then `removeWorktree` | `withGitOps`; `None` → `WORKTREES_PLUGIN_NOT_LOADED`; failure, including `ServiceWithdrawnError`, → the existing `Could not remove the worktree: …` text |
| `pane-workspace.ts` restore | `resolveGitOps` then `reattachWorktree` | `withGitOps`; `None` → `notRestored('Load the worktrees plugin to restore this worktree')`; `reattachWorktree` failure → `notRestored(String(failure.cause))` as today; `ServiceWithdrawnError` → `notRestored(error.message)` |
| `withMetaRepo` | `inject`, then `use(repo)` | `registry.use(MetaRepoKey, (value) => …)`: a value without every `MetaRepo` member → log error `The meta repo service lacks MetaRepo members` and return `MetaRepoFailed` "The meta plugin is not loaded." as today; otherwise `run(repo)` with the existing defect handling. `None` → `MetaRepoFailed` "The meta plugin is not loaded."; `ServiceWithdrawnError` → `MetaRepoFailed` "The meta plugin was unloaded during the call." |
| `resolveSessionAdditions` | `inject`, then `forNewSession` | `registry.use(MetaRepoKey, …)`, whose `is` checks `forNewSession` (ADR-0062); `None` or `ServiceWithdrawnError` → `NO_ADDITIONS`, with a warning log for the latter |
| `resolveAgentBackend`, `agentBackendChanges`, `Slot` | `inject` | unchanged (ADR-0055) |

The pane keeps `WorktreeInfo` (data) across its life; it keeps no `GitOps`.

Known limit at pane open: the lease covers worktree creation and the `.worktreeinclude` copy. If the worktrees plugin closes during them and they do not finish within `SERVICE_USE_TIME_LIMIT`, the open fails with `ServiceWithdrawnError`'s message, the pane scope's release finds the plugin closing, and the new worktree stays on disk with the `Left the pane worktree on disk` warning. A later restore of that tab reattaches the directory (`reattachWorktree` handles an existing unregistered directory).

## Errors

`ServiceWithdrawnError` (Interface). `use` passes every failure of `f` through unchanged.

## Tests

`src/shared/plugin/plugin-registry.test.ts`, `TestClock`; every `use` under test is forked with `{ startImmediately: true }` or followed by `Effect.yieldNow()` before `unload` starts:

1. `unload` of a provider whose service is in a running `use` (blocked on a `Deferred`) does not run the provider's finalizer until the `Deferred` completes; then `use` returns `Some` and `unload` returns `Unloaded`.
2. A `use` blocked on `Effect.never` during `unload`: after `TestClock.adjust(SERVICE_USE_TIME_LIMIT)` the unload completes, the finalizer has run, and `use` fails with `ServiceWithdrawnError`.
3. A `use` blocked on `Effect.uninterruptible(Effect.never)` during `unload`: after the limit, `use` fails with `ServiceWithdrawnError` and the unload completes.
4. After `unload`, `use(key, f)` returns `None` and `f` is not called.
5. A `use` that starts while the provider is closing (another `use` holds it) returns `None` without calling `f`.
6. A reload (`load` of a loaded plugin) waits for a running `use` the same way as `unload`.
7. A `use` running during a reload whose new setup fails returns `Some` after it ends, and a `use` started after the rollback reads the rolled-back version.
8. A failure of `f` reaches the caller unchanged.
9. Interrupting the caller of `use` interrupts `f` and lets a later `unload` close without waiting.
10. On `unload` of a provider with a dependant whose service is in a running `use`, the dependant's finalizer waits for that `use`, and the provider closes after the dependant.
11. A setup that provides a key and then fails, while a `use` of that key runs, closes after the `use` ends; the same for an adapter whose setup does not meet the adapter contract.
12. Interrupting an `unload` during its wait still closes the plugin: its finalizer runs and `use` of its key returns `None`.

Seam tests (`worktrees-seam.test.ts`, `meta-repo-seam.test.ts`), `pane-workspace.test.ts` and `rpc-handlers.test.ts` replace the `inject` fake with a `use` fake; `pane-workspace.test.ts` covers `None` and `ServiceWithdrawnError` for remove and restore; `meta-repo-seam.test.ts` covers the withdrawn message. `pane-supervisor.test.ts`: closing a worktree pane after the worktrees service stops being provided does not call the `removeWorktree` of the `GitOps` provided at open and logs the warning.

## Refinement Record

Round 1:
- **Closing check and lease registration not atomic** (blocker, correctness) — applied: one `Effect.sync` checks and registers a token before the fork.
- **An uninterruptible `f` hangs the caller of `use`** (blocker, correctness) — applied: `raceFirst` of `Fiber.await` and a per-open `withdrawn` `Deferred`; replaces the interrupts-only inference. Test 3.
- **Withdrawal during `openPane` can leave an orphan worktree** (major) — applied as a documented limit: it needs the worktrees plugin to close during pane open and the setup to run past 30 s; restore reattaches the directory. Splitting the lease per git call would change `setUpWorktreeTab` for this case only.
- **Interrupted `f` overlaps the provider's finalizers after a timeout** (major) — applied as a documented limit, the same as #185's.
- **`Leases` creation and failure paths underspecified** (major) — applied: created at `Scope.fork`; setup-failure delay stated; rollback test 7; absent-`leases` window stated.
- **`ServiceWithdrawnError` adds nothing over `None`** (major, Define Errors Out of Existence) — applied: removed; every caller mapped it to its `None` outcome.
- **`withMetaRepo` shape check and parameter name** (minor) — applied.
- **Tests incomplete or non-deterministic** (minor) — applied: `startImmediately`/`yieldNow`; tests 3, 5, 9, 10 added.
- **Doc updates missing from Scope** (major, project rules) — applied: ADR index row, ADR-0019 amendment line, spec path.
- **ADR cites a local clone path** (minor) — applied: cites `cordiverse/cordis` and `deepseek-ai/deepseek-harness`.
- **ADR should say plugin-to-plugin reads are covered by dependant ordering** (minor) — applied.

Round 2:
- **Registration outside `acquire` leaks a lease when the caller is interrupted** (blocker, correctness) — applied: registration and fork in the uninterruptible acquire; `active` keyed by fiber. The proposed test for it was dropped at implementation: with registration inside the uninterruptible acquire no test can interrupt the caller between the two, so it could not fail.
- **A withdrawn `None` sends `openPane` Create into the not-loaded branch** (major, correctness; Define Errors Out of Existence) — applied: `ServiceWithdrawnError` reinstated; round 1's reason ("every caller maps it to `None`") did not hold for `openPane`. Each caller's mapping is in the table.
- **Caller tests missing** (major) — applied: `pane-workspace.test.ts`, `rpc-handlers.test.ts`; test 11 for the setup-failure and adapter-contract branches.
- **An interrupted `unload` leaves the plugin half-closed** (major, correctness) — applied: `closePlugin` uninterruptible except the wait; test 12.
- **Comments in spec code blocks** (minor) — applied.
- **Restore message wrong for a withdrawn call** (minor) — applied through the reinstated error.
- **ADR: `inject` restriction is a convention** (minor) — applied in ADR-0055.
- **Spec path in Scope** (minor) — applied.

Round 3:
- **Spec does not say the forked `f` stays interruptible inside the uninterruptible acquire** (minor) — applied, with the `forkUnsafe` citation.
- **Wrong line citation for `raceFirst`** (minor) — applied.
- **Undefined `fibers` in `closePlugin` step 3** (minor) — applied.
- **Release must use the captured `Leases`** (minor) — applied; double completion of `drained` stated.

Stopped after round 3 (budget): no blocker or major finding raised in it.
