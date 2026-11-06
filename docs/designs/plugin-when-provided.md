# Plugin optional services (`ctx.whenProvided`)

Runs part of a plugin while a set of service keys is provided, closes that part before a provider of any key closes, and runs it again when every key is provided again. Issue #188.

## Interface

```ts
// src/shared/plugin/api.ts, on PluginServices (host and renderer contexts)
readonly whenProvided: <const Keys extends readonly [string, ...Array<string>]>(
  keys: Keys,
  setup: (services: { readonly [K in Keys[number]]: unknown }) => Effect.Effect<void, unknown, Scope.Scope>
) => Effect.Effect<void, WhenProvidedRefusedError, Scope.Scope>

/**
 * Failure of `ctx.whenProvided` called outside the plugin's setup or an enclosing `whenProvided`
 * setup, or called by an adapter plugin. `message` names the plugin and the reason.
 */
export class WhenProvidedRefusedError extends Data.TaggedError('WhenProvidedRefusedError')<{
  readonly plugin: string
  readonly message: string
}> {}
```

Example (agent overview, #182):

```ts
export const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(OVERVIEW_KEY, overview)
    yield* ctx.whenProvided([ORG_KEY], ({ org }) => ctx.provide(OVERVIEW_HIRES_KEY, hiresFrom(org)))
  })
```

Contract, stated in the `PluginServices` JSDoc:

- `whenProvided` registers `setup` for the lifetime of the scope it is called in (the plugin's scope, or an enclosing `whenProvided` setup's scope) and returns at once. It never runs `setup` itself. `keys` has at least one key (the type rejects `[]`).
- It may be called only by a feature plugin, from the fiber that runs its own setup or an enclosing `whenProvided` setup, or from a fiber forked inside one, while that setup runs. Any other call fails with `WhenProvidedRefusedError` and registers nothing. A call in a scope that is already closed (an abandoned, timed-out setup) logs a warning and registers nothing, as `provide` does.
- After the setup that registered it succeeds, and whenever every key in `keys` is provided by a running plugin, the registry runs `setup` in a new child scope of the registering scope, with the value of each key under its own name. `setup` has `PLUGIN_SETUP_TIME_LIMIT` (10 s).
- Before a provider of any key in `keys` closes by unload or reload, the registry closes the child scope. It runs `setup` again once every key is provided again.
- A failing or timed-out `setup` closes its child scope with the failure and is logged as an error naming the plugin and the keys. The plugin stays `Loaded`, and its `reloadError` is not set. That `setup` runs again only after one of its keys stops being provided and is provided again.
- A key provided inside a `setup` is withdrawn when the child scope closes; plugins and `whenProvided` setups that depend on that key close first. Inside a `setup`, `provide` of a key that is already provided, by any plugin including its own, fails with `ServiceKeyTakenError`.
- Keys passed to `whenProvided` need no entry in `plugin.json` `inject`. `ctx.inject` of such a key still fails with `ServiceNotDeclaredError` unless `inject` lists it; `setup` receives the values instead.

## Key Data Structures

Internal to `makePluginRegistry`; none crosses the module boundary except the error above.

```ts
interface Watcher {
  readonly plugin: string
  readonly keys: ReadonlyArray<string>
  readonly setup: (services: Record<string, unknown>) => Effect.Effect<void, unknown, Scope.Scope>
  readonly parent: Scope.Scope
  readonly provided: Set<string>
  readonly nested: Set<Watcher>
  state: WatcherState
}

type WatcherState = Data.TaggedEnum<{
  Idle: {}
  Running: { readonly scope: Scope.Closeable }
  Failed: {}
}>
const WatcherState = Data.taggedEnum<WatcherState>()

interface SetupWindow {
  readonly plugin: string
  readonly watcher: Watcher | undefined
  accepting: boolean
}
```

Fields and invariants:
- `parent` is the scope `whenProvided` was called in. `provided` holds the keys `provide` published while this watcher's setup window was current. `nested` holds the watchers registered while this watcher's setup ran.
- `Idle` runs when every key is provided; `Running` holds the child scope; `Failed` (last run failed) becomes `Idle` when one of its keys is withdrawn.
- A `SetupWindow` exists per plugin setup run and per watcher setup run; `watcher` is `undefined` for the plugin's own setup; `accepting` is false once that setup has returned, failed or timed out.
- Watcher state is built with its constructors (`WatcherState.Idle()`, `WatcherState.Running({ scope })`, `WatcherState.Failed()`), never as `{ _tag }` literals.
- A watcher is in `watchers` exactly while its `parent` scope is open (registered with `Effect.acquireRelease` in `parent`); a nested watcher is also in its outer watcher's `nested` for that time.
- `Running.scope` is a child of `parent`, so closing `parent` closes it.
- Each key in `provided` is also in the owning entry's `provided`; it is removed when its `provide` is released.

## Internal Decomposition

- **`CurrentSetup`** (`Context.Reference<SetupWindow | undefined>`, default `undefined`) — provided around each plugin setup run and watcher setup run; fibers forked inside inherit it (verify in `node_modules/effect/src/internal/effect.ts` fork). `Effect.provideService(CurrentSetup, window)` wraps the effect passed to `withinTimeLimit`, and `Effect.ensuring(Effect.sync(() => { window.accepting = false }))` wraps the `withinTimeLimit` call in the caller, for the plugin's setup and for each watcher run. On timeout `accepting` becomes false when `withinTimeLimit` returns; the abandoned setup fiber may run until its interrupt lands, and its calls are refused.
- **`servicesFor(name, entry).whenProvided`** — fails with `WhenProvidedRefusedError` when the entry is an adapter, when `CurrentSetup` is `undefined`, belongs to another plugin, or is not `accepting`; returns after a warning when the current `Scope` is closed; each refusal first logs error `A plugin called whenProvided outside its setup` `{ plugin, reason }`, with `reason` one of `adapter`, `no-setup`, `other-plugin`, `setup-ended`; otherwise registers a `Watcher` in the current `Scope` and adds it to `CurrentSetup.watcher?.nested`. Logs debug `Registered a setup that waits for services` `{ plugin, keys }`.
- **`servicesFor(name, entry).provide`** — refuses with `ServiceKeyTakenError` a key already in `entry.provided` when either `CurrentSetup.watcher` is set or the key is in one of the plugin's watchers' `provided`; when `CurrentSetup.watcher` is set it adds the key to `watcher.provided` (removed in the release). A duplicate `provide` of a plugin's own key with neither condition keeps today's behaviour.
- **`servicesFor(name, entry).inject`** — unchanged, except that the `ServiceNotDeclaredError` message for a key one of the plugin's watchers watches says to use the value `whenProvided` passes to its setup, or to declare the key in `inject` if the plugin requires it.
- **`runWatchers`** — for every `Idle` watcher whose own plugin `isRunning` and whose keys are all in `slots` with an owner that `isRunning` (the same test `open` applies to `inject`, so a `RestartRequired` provider whose old version still runs counts): fork a child scope from `parent`, run `setup` under `CurrentSetup` with `withinTimeLimit`, then mark it `Running` (log info `Started a setup whose services are provided` `{ plugin, keys }`) or close the scope with the failure, mark it `Failed` and log error `A setup whose services are provided failed` `{ plugin, keys, cause }`. Iterates over a copy of `watchers`.
- **`closeDependantsOf(keys)`** — the dependant step of today's `closeWithDependants`, generalized: first closes each plugin that injects one of `keys` (then marks it `Waiting`, as today), then closes each `Running` watcher that watches one of `keys` (`closeWatcher`), skipping a watcher no longer in `watchers` when its turn comes (its plugin was closed in the first step), then marks each `Failed` watcher that watches one of `keys` `Idle`. Iterates over copies.
- **`closeWatcher(watcher, closing)`** — `closeWatcher` of each `Running` watcher in `nested`, then `closeDependantsOf(watcher.provided)`, then closes its child scope, then marks it `Idle`. It logs info `Closed a setup because a service it waits for is closing` `{ plugin, keys }` only when `watcher.plugin` is not `closing`, the plugin whose close started it.
- **`closeWithDependants(name)`** — `closeDependantsOf(entry.provided)` (which includes keys its watchers provided), then `closePlugin` as today. The plugin's own child scopes close inside its `Scope.close`, after other plugins' dependants of their keys have closed.
- **`settle`** — replaces the bare `openWaiting` call at the end of `loadNamed`: repeat `openWaiting` and `runWatchers` until neither changes anything, since a watcher's `provide` can satisfy a `Waiting` plugin and a newly opened plugin can satisfy a watcher.

Watchers run only from `settle` at the end of `loadNamed`, under the registry lock. `unloadLocked` and `swap` only close them. `unloadLocked` needs no `settle`: an unload withdraws keys and cannot satisfy an `Idle` watcher. Registration happens only inside a setup the lock already covers.

## Design Rationale

**Keys at the call, no manifest list** — cordis and deepseek-harness declare an optional dependency only at `ctx.inject(keys, cb)` (`cordis/packages/core/src/registry.ts:227`; `deepseek-harness/packages/core/agent-loop/src/index.ts:358`). #186 required `inject` so the registry knows a plugin's dependants before closing a provider; a `Watcher` gives it the same knowledge for the child. (User decision.)

**`setup` receives the values** — every key is provided while `setup` runs, so values need no `Option`. Lifetime comes from the ambient `Scope`, which is the child scope: `provide`, `forkScoped` and a nested `whenProvided` inside `setup` all end with it, so a child context would only widen one `inject` check. (User decision.)

**Registration during setup only** — every precedent call is in the plugin body. Registering and running both happen under the registry lock, so `whenProvided` never takes the lock and cannot race a close or deadlock against a load it runs inside. A runtime-chosen dependency is expressed by one `whenProvided` in setup that reacts inside the child. (User decision.) `CurrentSetup` is per run rather than per plugin, so a fiber forked by an earlier setup cannot register during a later watcher run.

**Adapters refused** — an adapter cannot declare `inject` (ADR-0029: adapters do not depend on feature plugins); `whenProvided` would be a second way to depend on one.

**Run after the registering setup succeeds** — running `setup` inline would put the child's time and failures inside the parent's setup, and a parent setup that fails later would have run the child for nothing. Deferring to `runWatchers` keeps one place where children start.

**Closing a child closes what depends on its keys, nested first** — without `provided` and `nested`, a key a child or a nested child provided would disappear while a plugin that injects it keeps the closed value: the stale-value problem of #186. The lease drain of ADR-0055 does not apply to child keys (Known limits).

**A child may not reuse a provided key** — two `provide` calls by one plugin share one slot, and the first release deletes it while the other is live; refusing the duplicate inside a child keeps the slot owned by one scope.

**A failed `setup` waits for its keys to change** — retrying in `settle` would loop on a setup that always fails; retrying on the next provide of one of its keys gives it a changed input.

## Rejected Alternatives

- **`"optional"` list in `plugin.json`** — no precedent in cordis or deepseek-harness; a second list that can drift from the calls.
- **Cordis-style child context** — needs a second host and renderer context through `deps.extend` to widen one `inject` check; `child.inject` would return an `Option` that is always `Some`.
- **Callable any time** — needs a held-lock flag (the `Semaphore(1)` lock is not reentrant) and a locked path, and a call from a `use` lease during an unload waits up to 30 s. No caller needs it.
- **A per-plugin `registering` flag** — accepts a call from a fiber an earlier setup forked while a later watcher setup of the same plugin runs.

## Tests (`plugin-registry.test.ts`, `describe('whenProvided')`)

1. The plugin loads before the provider: `setup` does not run; after the provider loads, `setup` runs once with the provider's value. (criterion 1)
2. The provider unloads: the child scope's finalizer runs before the provider's finalizer; `setup` does not run while it is unloaded; after the provider loads again, `setup` runs again with the new value. (criterion 2)
3. A provider reload closes the child before the old provider's finalizer and runs `setup` once against the new version.
4. A failing `setup`: the plugin stays `Loaded` with no `reloadError`, an error log names the plugin and keys, and `setup` runs again only after the provider reloads. (criterion 3)
5. A `setup` that never ends fails after `PLUGIN_SETUP_TIME_LIMIT` (`TestClock`), and the plugin stays `Loaded`.
6. `whenProvided` called from a fiber the setup forked, after setup ended, fails with `WhenProvidedRefusedError` and `setup` never runs. (criterion 4)
7. A fiber forked by the plugin's setup calls `whenProvided` while a later watcher setup of the same plugin runs: it fails with `WhenProvidedRefusedError`.
8. An adapter plugin's `whenProvided` fails with `WhenProvidedRefusedError`.
9. Unloading the plugin itself closes its running child scope, without the `Closed a setup because…` log. (criterion 5)
10. A key provided inside `setup` is withdrawn when the provider of a watched key unloads, and a plugin that injects that key closes first and becomes `Waiting`.
11. A nested `whenProvided` inside `setup` runs after the outer setup; when the outer child closes, a plugin that injects a key the nested setup provided becomes `Waiting` before the nested finalizer runs, which runs before the outer finalizer.
12. `provide` inside `setup` of a key its own plugin already provides fails with `ServiceKeyTakenError`.
13. A failure of the plugin's own setup after it called `whenProvided` never runs the registered `setup`.
14. A plugin that both injects and watches the provider's key: unloading the provider closes the plugin once (one child finalizer run, no "Closed a setup" log for the watcher) and it becomes `Waiting`.
15. A `Failed` watcher on keys A and B: unloading A's provider marks it `Idle` and `setup` does not run while A is absent; loading A again runs it once. Unloading B's provider and then A's, and loading A first, does not run it until B is provided too.
16. A provider reload whose new setup fails rolls back; the watcher's `setup` runs again against the rolled-back version.
17. A provider that is `RestartRequired` while its old version runs: a plugin registering a watcher on its key runs `setup`.
18. Two watchers of one plugin, W2 watching a key W1's setup provides: both run in one `settle`; unloading W1's provider closes W2 first, then W1.
19. A fiber forked by the plugin's top-level setup that provides a key a running watcher provided fails with `ServiceKeyTakenError`.
20. Each refusal of `whenProvided` logs an error with its `reason`.

`whenProvided([], …)` is a compile error (checked by `pnpm typecheck` through a `@ts-expect-error` line in the test file). Criterion 6 (all shipped plugins load on API 0.0.21) is checked in the dev app.

## Other changes

- `PLUGIN_API_VERSION` in `src/shared/plugin/manifest.ts:24`: `0.0.20` → `0.0.21`; `"api"` in all 9 `plugins/*/plugin.json`.
- `WhenProvidedRefusedError` reaches plugins through `export * from '../shared/plugin/api'` in `src/host/plugin-api.ts:51`; no change there.
- `PluginServices` literals gain `whenProvided`: `slots.test.tsx`, `session-rail.ts` and `plugin-registry.test.ts` if they build one, plus any other found by grep.
- New ADR `0056-run-part-of-a-plugin-while-optional-services-are-provided.md`, extending ADR-0019's plugin context; README index row; ADR-0019 gains an "Amended by ADR-0056" line.
- `PROTOCOL_VERSION` unchanged: no RPC changes.

## Known limits

- Closing a child does not wait for `registry.use` leases on keys it provided: a lease on a child-provided key is granted on the owning plugin's leases (`plugin-registry.ts` `use`), and closing the child does not interrupt a running `use`. Host feature reads today use keys provided at the top of a plugin's setup.
- After a timed-out `setup`, its fiber can run on until it is interrupted, concurrently with the closed child scope (as for a timed-out plugin setup, `withinTimeLimit`).
- Watcher `setup`s run one after another under the registry lock; N slow watchers delay every `load` and `unload` by up to N × `PLUGIN_SETUP_TIME_LIMIT`.
- App shutdown closes child scopes with their plugin scope, in no defined order between plugins (as today for plugins).

## Refinement Record

**Round 1**

Applied
- *Correctness* (blocker) — keys provided during a child's setup had no `Running` record to land in; `provided` moved onto `Watcher`.
- *Correctness* (blocker) — closing an outer watcher left a nested watcher's dependants with stale values; `nested` added and `closeWatcher` closes nested watchers first; test 11 extended.
- *Correctness* (major) — the per-plugin `registering` flag accepted calls from fibers forked by an earlier setup; replaced by the per-run `CurrentSetup` reference; test 7 added.
- *Correctness* (major) — no closed-scope guard in `whenProvided`; added, as `provide` has.
- *Define Errors Out of Existence* (major) — `[]` was accepted and `E` was unused; keys typed as a non-empty tuple, `E` removed.
- *Correctness* (minor) — "failed setup" removed from the close-ordering sentence; own child scopes close inside the plugin's `Scope.close`.
- *Correctness* (minor) — lock paragraph corrected: watchers run only from `settle`; `unloadLocked` needs none; iteration over copies.
- *Consistency* (minor) — the ADR-0055 rationale now matches Known limits.
- *Correctness* (minor) — `plugin-api.ts` already re-exports `api.ts`; bullet changed.
- *Project rules* (minor) — logs named for register, start, fail and close; `reloadError` untouched; ADR-0019 amendment line; manifest path.
- *Correctness* (minor) — adapters refused (ADR-0029); a duplicate `provide` inside a child refused with `ServiceKeyTakenError`; error renamed `WhenProvidedRefusedError` to cover both refusals; tests 7, 8, 12 added.

**Round 2**

Applied
- *Correctness* (major) — a plugin that injects and watches one key was closed, then its dead watcher closed again; `closeDependantsOf` closes plugins first and skips watchers no longer registered; test 14.
- *Correctness* (major) — a `RestartRequired` provider still runs and serves `inject` (`open` checks `slots.has`), but watchers required `Loaded`; both now use `isRunning`; test 17.
- *Correctness* (minor) — where `accepting = false` is set is stated: `ensuring` around the `withinTimeLimit` call, `provideService` around the effect inside it.
- *Consistency* (minor) — the duplicate-key refusal is scoped to watcher setups; top-level behaviour unchanged.
- *Names as Documentation* (minor) — `SetupWindow.open` renamed `accepting` (collided with the registry's `open`).
- *Edge cases* (minor) — tests 15 (multi-key `Failed`) and 16 (reload rollback) added.
- *Project rules* (minor) — inline `//` comments removed from the data-structure block; meanings moved to the field list; tagged literals noted as plain internal state like `status`.

**Round 3**

Applied
- *Correctness* (major) — test 15 contradicted the contract (a `Failed` watcher already had both keys); rewritten.
- *Project rules* (major) — refusals of `whenProvided` were not logged; each logs an error with its `reason`; test 20.
- *Correctness* (minor) — the duplicate-key guard covered only watcher-side `provide`; it also refuses a top-level fiber providing a key a watcher provided; test 19.
- *Project rules* (minor) — watcher state uses `Data.taggedEnum` constructors instead of `{ _tag }` literals.
- *Edge cases* (minor) — sibling chain inside one plugin; test 18.
- *Consistency* (minor) — the close log no longer fires when the watcher's own plugin is closing; test 9 asserts that.
- *Correctness* (minor) — lock occupancy by slow watchers added to Known limits.
- *Least astonishment* (minor) — `ServiceNotDeclaredError` for a watched key points to the `whenProvided` value instead of only to `inject`.
- *Consistency* (minor) — the list of `PluginServices` literals to update widened.
