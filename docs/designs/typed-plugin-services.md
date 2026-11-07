# Typed plugin services

Lets a plugin declare a service's type and a runtime check in a module it exports, so a consumer that imports the key reads the service with that type, and a value that fails the check is treated as not provided. Issue #199.

## Success criteria

1. In a packaged build with `org` loaded, the Example page shows `Hello from the example plugin's host entry · <n> roles`, where `<n>` is the number of `org` roles when `org` last became provided.
2. With `org` unloaded, the Example page shows the greeting without a count, and the `example` plugin stays `Loaded`.
3. `ctx.inject(OrgService)` has type `Option<Org>`, and providing a value that is not an `Org` under `OrgService` is a compile error (`tsc` on `plugins/example` and `plugins/org`; a `// @ts-expect-error` line in a test).
4. When a provider gives a value that fails the key's guard, `inject` returns `none`, `use` returns `none` without running its callback, `whenProvided` does not run its setup, and a warning names the key and the provider.
5. No file under `src/` declares `Org` or names `ORG_KEY` (a test greps for it).
6. String keys behave as before: the existing tests pass with no assertion changed. Only the test fakes of `inject` and `provide` change, because the overloads give an unannotated fake parameter no type.

Out of scope: `AGENT_BACKEND_KEY`, `META_REPO_KEY`, `WORKTREES_KEY` keep string keys and their seams (deferred to #201, comment 6701958969); the org domain schemas in `src/shared/domain/org.ts` stay (#201).

## Part 1: `ServiceKey`

In `src/shared/plugin/api.ts` (platform-neutral, ADR-0013), re-exported by both `@dia/plugin` barrels (`src/shared/plugin/api.ts` is the shared barrel; `src/host/plugin-api.ts` does `export * from '../shared/plugin/api'`):

```ts
/**
 * A typed service key. `name` is the key the registry stores the service under and the name a
 * manifest's `inject` lists; `is` checks that a provided value has the shape `A`. Make one with
 * {@link ServiceKey.make} in a module the providing plugin exports (ADR-0059), and import it from
 * both the provider and every consumer.
 */
export interface ServiceKey<A, Name extends string = string> {
  readonly name: Name
  readonly is: (value: unknown) => value is A
}

/** Constructors for {@link ServiceKey}. */
export const ServiceKey = {
  /**
   * A key named `name` whose values must pass `is`. `A` is inferred from `is`'s type predicate.
   */
  make: <const Name extends string, A>(
    name: Name,
    is: (value: unknown) => value is A
  ): ServiceKey<A, Name> => ({ name, is })
}

/** A key a plugin context accepts: a typed {@link ServiceKey} or a plain string key. */
export type AnyServiceKey = ServiceKey<unknown> | string

/** The name a key is stored under. */
type KeyName<K extends AnyServiceKey> = K extends ServiceKey<unknown, infer N> ? N : K
/** The value type a key reads as: the key's type for a `ServiceKey`, `unknown` for a string. */
type KeyValue<K extends AnyServiceKey> = K extends ServiceKey<infer A> ? A : unknown
```

`PluginServices` changes (renderer and Host contexts both extend it):

```ts
readonly provide: {
  <A>(key: ServiceKey<A>, value: A): Effect<void, ServiceKeyTakenError | ServiceKeyReservedError, Scope>
  (key: string, value: unknown): Effect<void, ServiceKeyTakenError | ServiceKeyReservedError, Scope>
}
readonly inject: {
  <A>(key: ServiceKey<A>): Effect<Option<A>, ServiceNotDeclaredError>
  (key: string): Effect<Option<unknown>, ServiceNotDeclaredError>
}
readonly whenProvided: <const Keys extends readonly [AnyServiceKey, ...Array<AnyServiceKey>]>(
  keys: Keys,
  setup: (services: { readonly [K in Keys[number] as KeyName<K>]: KeyValue<K> }) =>
    Effect<void, unknown, Scope>
) => Effect<void, WhenProvidedRefusedError, Scope>
```

A caller holding a `string | ServiceKey` value narrows it before the call; no third overload is added (no caller holds one: `callKey` in `plugin-messages.ts:23` and `slotKey` in `slots.ts:32` return `string`).

`PluginRegistry.inject` and `PluginRegistry.use` gain the same two overloads (`use`'s `f` receives `A` for a `ServiceKey<A>`).

The `PluginServices` JSDoc (`api.ts:66-86`) gains: a key is a string or a `ServiceKey`; a read with a `ServiceKey` returns its type and treats a value that fails the key's `is` as not provided; `whenProvided` passes each value under the key's name.

## Part 2: the registry

The registry stores every service under the key's name, as now. A string key and a `ServiceKey` with the same name address the same slot.

- `provide(key, value)`: uses `nameOf(key)` everywhere it uses `key` now (the adapter-key check, the slot, `entry.provided`, `providedKeys`). It does not run `is`; the overload types the value.
- A read with a `ServiceKey` runs the reader's `key.is(value)` on the slot's value; a guard that throws counts as failing (`passes = (key, value) => { try { return key.is(value) } catch { return false } }`, internal).
  - One internal `checkedSlot(key)` looks up the slot, runs the guard, and on failure logs `Effect.logWarning('A provided service failed its key check', { key: name, provider })` and returns `none`. `inject` and `use` both read through it.
  - `inject` returns the checked slot's value, or `none`.
  - `use` calls `checkedSlot` in its acquire step before the lease check. A failing value takes the existing `NotProvided` grant: `use` returns `none`, `f` is not forked and no lease is taken.
  - A watcher stores its `typedKeys`. `isReady` becomes `keysProvided(watcher)` (every key's slot exists and its owner is running, as today), and `rejectedSlot(watcher)` returns the first key whose slot value fails its guard, with that slot's provider. `runWatchers` runs a watcher only when `keysProvided` holds and `rejectedSlot` finds none; when `keysProvided` holds and `rejectedSlot` finds a key, it logs the warning with the watcher's plugin, the failing key and its provider, and marks the watcher `Failed`, the state a failed setup takes. The registry resets a `Failed` watcher to `Idle` when one of its keys is withdrawn, so the guard runs and the warning is logged once per provided value.
- A read with a string key is unchanged.
- `inject` with a `ServiceKey` checks the manifest's `inject` list against `key.name`.
- A `Watcher` stores `keys: ReadonlyArray<string>` (the names) and `guards: ReadonlyMap<string, (value: unknown) => boolean>` keyed by name (`() => true` for a string key), both built in `whenProvided`. `closeDependantsOf`, `closeWatcher`, the `ServiceNotDeclaredError` message and every log keep reading `keys` as names.
- `PluginInfo.provides`, `entry.provided`, `dependantsOf` and `closeDependantsOf` are unchanged: they see names only. `ServiceKeyTakenError.key`, `ServiceKeyReservedError.key`, `ServiceNotDeclaredError.key` and `ServiceWithdrawnError.key` carry the name.

`src/shared/plugin/plugin-registry.fake.ts`'s `fakeUse` takes `key: AnyServiceKey`, reads `read(nameOf(key))`, runs `key.is` for a `ServiceKey` (returning `None` when it fails), with no cast; its callers (`meta-repo-seam.test.ts`, `worktrees-seam.test.ts`, `pane-supervisor.test.ts`, `pane-workspace.test.ts`) are unchanged. `fakeInject` is its `inject` counterpart; the six test files that faked `inject` inline (`adapter-status-feed`, `model-catalog-feed`, `pane-supervisor`, `transcript-reader`, `agent-backend`, `tab-content`) build their fake with it, and `slots.test.tsx`'s fake `provide` takes `key: AnyServiceKey`. `nameOf` and `passes` are exported from a new internal module `src/shared/plugin/service-key.ts` that the registry and the fakes import.

`nameOf = (key: AnyServiceKey) => typeof key === 'string' ? key : key.name`; neither it nor `passes` is exported from `@dia/plugin`.

An arrow assigned to an overloaded property gets no contextual parameter types, so `servicesFor`'s `provide` and `inject`, and the registry's `inject` and `use`, are written with `key: AnyServiceKey` parameters, and compute `const name = nameOf(key)` once. They need no cast: a function whose parameter is `AnyServiceKey` is assignable to both overloads, while one whose parameter is `string` is not (TS2322), because it cannot receive the `ServiceKey<A>` the first overload passes. Cordis keys are always strings (`.repos/cordis/packages/core/src/reflect.ts:8-13`), so its implementations take `name: string`; dia's typed key is an object, so its implementations take `AnyServiceKey`.

## Part 3: `plugins/org`

New `plugins/org/service.ts`, listed in `plugins/org/plugin.json` › `exports`, `tsconfig.plugin-exports.json` › `include` and `tsconfig.web.json` › `include`:

```ts
import { type BuiltInRoleDeleted, /* … every type org-seam.ts imports, all from @dia/plugin */ ServiceKey } from '@dia/plugin'
import { Effect, Predicate } from 'effect'

/** The org (ADR-0033), as the `org` plugin provides it under {@link OrgService}. (JSDoc moved from org-seam.ts.) */
export interface Org { /* members moved unchanged from src/host/services/org-seam.ts */ }

const EFFECTS = ['roles', 'hiredAgents', 'settings'] as const
const FUNCTIONS = ['setRoleEnabled', 'copyRole', 'editRole', 'deleteRole', 'hire', 'dismiss', 'setOverallCap'] as const

/** Whether `value` has every {@link Org} member: the reads as effects, the changes as functions. */
export const isOrg = (value: unknown): value is Org =>
  EFFECTS.every((m) => Predicate.hasProperty(value, m) && Effect.isEffect(value[m])) &&
  FUNCTIONS.every((m) => Predicate.hasProperty(value, m) && Predicate.isFunction(value[m]))

/** The key the `org` plugin provides its {@link Org} under. */
export const OrgService = ServiceKey.make('org', isOrg)
```

- `plugins/org/host.ts`: `ctx.provide(OrgService, org)`.
- `plugins/org/org.ts`: imports `Org` from `./service`; its JSDoc at line 99 says `OrgService` instead of `ORG_KEY`.
- `src/host/plugin-api.ts` adds `RoleEdit` to its `../shared/domain/org` export and exports `AgentName` from `../shared/domain/project`, as types: `service.ts` may import only `effect` and `@dia/plugin` (ADR-0059, `plugin-exports.test.ts`), and `Org.editRole` and `Org.hire` use them.
- Deleted: `src/host/services/org-seam.ts`; `ORG_KEY` in `src/shared/plugin/api.ts`; `export type { Org }` in `src/host/plugin-api.ts`; the `org-seam.ts` entry in `tsconfig.web.json` › `include`.
- `PLUGIN_API_VERSION` → `0.0.24`; every `plugins/*/plugin.json` `api` → `"0.0.24"`.

## Part 4: `plugins/example`

`host.ts` reads the org as an optional service (its `effect` import becomes `import { Effect, Option, Ref, Stream } from 'effect'`):

```ts
import { OrgService } from '@dia-plugin/org/service'

const roleCount = yield* Ref.make(Option.none<number>())
yield* ctx.whenProvided([OrgService], ({ org }) =>
  Effect.gen(function* () {
    yield* Ref.set(roleCount, Option.some((yield* org.roles).length))
    yield* Effect.addFinalizer(() => Ref.set(roleCount, Option.none()))
  })
)
yield* ctx.serve(ReadGreeting, () =>
  Ref.get(roleCount).pipe(Effect.map(Option.match({
    onNone: () => `Hello from the ${ctx.name} plugin's host entry`,
    onSome: (n) => `Hello from the ${ctx.name} plugin's host entry · ${n} roles`
  })))
)
```

No `inject` entry is added to `plugins/example/plugin.json`: a listed key the registry cannot satisfy puts the plugin in `Waiting` (`plugin-registry.ts:799`), which would break criterion 2. The count is read when `org` becomes provided; a role added later shows after the next `org` reload.

`example` imports `@dia-plugin/org/service`, so a reload of `org` that changed `service.ts` or a file it imports closes and reopens `example` (ADR-0059, `reloadImporters`); a reload that changed neither leaves `example` open. Unloading `org` does not close `example`; the `whenProvided` finalizer clears the count then. `example` needs `plugins/org` in the catalog to load: with `org` uninstalled, the import is refused and `example` fails to load.

## Tests

| Criterion | Test |
| --- | --- |
| 1, 2 | `verify-in-app`, packaged build: page text with `org` loaded, then after unloading `org` in Settings › Plugins |
| 3 | `src/shared/plugin/service-key.test.ts`: `expectTypeOf(ctx.inject(OrgLikeKey))`, `// @ts-expect-error` on `provide(key, wrongValue)`; `pnpm typecheck` covers the real plugins |
| 4 | `plugin-registry.test.ts`: a provider gives a value failing the key's `is`; `inject` returns `none`; `use` returns `none` with `f` not called, and closing the provider straight afterwards completes under `TestClock` without advancing it and without logging "Waiting for calls that use the plugin's services" (`drainLeases` waits only when a lease is active); a watcher's setup does not run; the warning carries `key` and `provider`; a guard that throws behaves as failing; a running typed watcher closes before its provider closes |
| 5 | new `src/host/plugins/org-ownership.test.ts`: no `.ts`/`.tsx` file under `src/` matches `ORG_KEY` or `(interface|type) Org\b` |
| 6 | the existing suites, with only their `inject`/`provide` fakes changed |

## ADR

New ADR-0060 "Type a plugin service by a key its provider exports", amending ADR-0055 (`use` takes a typed key and checks the value) and ADR-0056 (`whenProvided` takes typed keys); its row is added to `docs/adr/README.md` after 0059, and the status of 0055 and 0056 becomes "accepted, amended by ADR-0060".

## Design rationale

**A key value, not module augmentation** — user decision. `@dia/plugin` maps to two files in different tsconfigs, and an interface cannot be augmented through a module that only re-exports it.

**The reader's guard runs on read** — the override case puts provider and consumer on different versions of `service.ts`; only the consumer's `is` encodes what the consumer expects. A guard at `provide` would run the provider's own check, which passes.

**One slot per name** — string keys and typed keys interoperate, so a Host string-key reader and a plugin typed-key reader of one service see the same provider, and the manifest's `inject` list keeps names.

**`A` inferred from the guard** — `ServiceKey.make('org', isOrg)` needs no explicit type argument, and a key cannot claim a type its guard does not check.

## Refinement Record

**Round 1**

Applied:
- *Correctness* (blocker) — a `Watcher` holding key objects broke `closeDependantsOf` (`plugin-registry.ts:715`), the `ServiceNotDeclaredError` message (516) and log fields. Watchers store names plus guards.
- *Project rules* (blocker) — `service.ts` needs `RoleEdit` and `AgentName`, which `src/host/plugin-api.ts` does not export (verified by grep). Both are exported as types.
- *Correctness* (blocker) — `plugins/org/org.ts:99` names `ORG_KEY`. Updated; criterion 5's grep limited to `.ts`/`.tsx` under `src/`.
- *Project rules* (major) — `any` in `AnyServiceKey`, `KeyName`, `KeyValue`. Replaced by `unknown`; a `tsc` probe confirmed the `whenProvided` remap gives `{ org: Org; plain: unknown }`.
- *Correctness* (major) — `isReady` is synchronous and frequent, and a guard may throw. Guards are evaluated without logging in `isReady`, a throw counts as failing, `use` gets a `Rejected` grant, watchers log once per state change.
- *Correctness* (minor) — names flow unchanged through `PluginInfo.provides`, `dependantsOf` and error `key` fields; stated.
- *Wording* (minor) — the `PluginServices` JSDoc update added to Part 1.

Rejected:
- *Correctness* (blocker) — "`provide(OrgService, {})` compiles because `A` widens to `{}`; use `NoInfer`." A `tsc` probe of `<A>(key: ServiceKey<A>, value: A)` reports `TS2739: Type '{}' is missing the following properties from type 'Org'`, so the plain signature already rejects it.

**Round 2**

Applied:
- *Correctness* (blocker) — the warn-once rule for watchers needed state the draft did not name. Resolved without new state: `isReady` split into `keysProvided` and `guardsPass`, and `runWatchers` warns on each `settle` pass that finds a rejected watcher. `settle` runs once per load or unload (`plugin-registry.ts:866-872`), and a rejected watcher does not count as run, so the repeat is bounded. The finding's `rejected: boolean` field was not adopted.
- *Correctness* (blocker) — an arrow assigned to an overloaded property gets no contextual parameter types. Implementations take `AnyServiceKey`, compute `nameOf` once and are cast to the overloaded type.
- *Strategic Programming* (minor) — a `string | ServiceKey` caller matches neither overload; stated, with no current caller holding one.
- *Testing* (major) — "no lease held" was not observable. The test closes the provider under `TestClock` and checks that the close neither waits nor logs the lease-wait message.
- *Information Hiding* (minor) — parallel `keys` and `guards` arrays. `guards` is a map keyed by name.
- *Correctness* (minor) — criterion 1's count is a snapshot. Criterion 1 now says "when `org` last became provided".


**Round 3**

Applied:
- *Correctness* (major) — the import edge from `example` to `org/service.ts` was not stated. Part 4 now states it, corrected: the finding said every `org` reload closes `example`; under ADR-0059 only a reload that changed `service.ts` or its imports does (#198 criterion 5). Also states that `example` fails to load when `org` is uninstalled.
- *Correctness* (major) — `fakeUse` (`plugin-registry.fake.ts:10`) types `key: string` and stops compiling against the overloaded `use`. It takes `AnyServiceKey`; `nameOf` and `passes` live in `src/shared/plugin/service-key.ts`.
- *Project rules* (minor) — the ADR row in `docs/adr/README.md` and the 0055/0056 status changes stated.
- *Wording* (minor) — `org-ownership.test.ts` marked new; Part 4's `effect` import stated.

No change (round 1):
- *Project rules* (minor) — an interface and a const both named `ServiceKey`: `biome lint` on the probe reports nothing.
