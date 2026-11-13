import { Data, type DateTime, type Effect, type Option, type Scope, type Stream } from 'effect'
import type { Rpc } from 'effect/rpc'
import type { SqlClient } from 'effect/sql'
import type { AgentNotification } from '../domain/notification'
import type { Workspace } from '../domain/project'
import type { EventFrame } from '../ipc/rpc'
import type { PluginCallAttempt } from './messages'
import type { PathsMoved } from './paths-moved'

/**
 * A typed service key (ADR-0060). `name` is the key the registry stores the service under and the
 * name a manifest's `inject` lists; `is` checks that a provided value has the shape `A`. Make one
 * with {@link ServiceKey.make} in a module the providing plugin exports (ADR-0059), or, for a service
 * the Host reads, in `src/` beside the interface it types (ADR-0062); import it from the provider and
 * from every consumer.
 */
export interface ServiceKey<A, Name extends string = string> {
  readonly name: Name
  readonly is: (value: unknown) => value is A
}

/** Constructors for {@link ServiceKey}. */
export const ServiceKey = {
  /**
   * A key named `name` whose values must pass `is`. The service type `A` is inferred from `is`'s
   * type predicate, so a key cannot claim a type its guard does not check.
   */
  make: <const Name extends string, A>(
    name: Name,
    is: (value: unknown) => value is A
  ): ServiceKey<A, Name> => ({ name, is })
}

/** A key a plugin context accepts: a typed {@link ServiceKey} or a plain string key. */
export type AnyServiceKey = ServiceKey<unknown> | string

/** The name a key is stored under: a `ServiceKey`'s `name`, or the string itself. */
type ServiceKeyName<K extends AnyServiceKey> = K extends ServiceKey<unknown, infer N> ? N : K

/** The type a key reads as: `A` for a `ServiceKey<A>`, `unknown` for a string key. */
type ServiceKeyValue<K extends AnyServiceKey> = K extends ServiceKey<infer A> ? A : unknown

/**
 * Failure of `ctx.provide` when another loaded plugin already provides `key`. `owner` is the
 * name of that plugin. The plugin that hit it fails to load and keeps no registrations.
 */
export class ServiceKeyTakenError extends Data.TaggedError('ServiceKeyTakenError')<{
  readonly key: string
  readonly owner: string
}> {}

/**
 * Failure of `ctx.inject` for a service key that the plugin's manifest does not list in `inject`.
 * `message` names the plugin and the key and says to add the key to `inject` in `plugin.json`. A
 * plugin whose setup hits it fails to load.
 */
export class ServiceNotDeclaredError extends Data.TaggedError('ServiceNotDeclaredError')<{
  readonly key: string
  readonly message: string
}> {}

/**
 * Failure of `ctx.whenProvided` called outside the plugin's own setup and the `whenProvided` setups
 * it registered. `message` names the plugin and the reason. Nothing is registered.
 */
export class WhenProvidedRefusedError extends Data.TaggedError('WhenProvidedRefusedError')<{
  readonly plugin: string
  readonly message: string
}> {}

/**
 * What every plugin context offers, on the host and in the renderer. `provide` publishes `value`
 * under `key` for the lifetime of the scope it runs in, and fails when another plugin provides
 * `key`. `inject` reads the value for `key`, which must be listed in the plugin's manifest
 * `inject`: it is empty when no loaded plugin provides `key`, and fails with {@link ServiceNotDeclaredError} when the manifest
 * does not list `key`. The plugin is reopened whenever the provider of a listed key changes.
 *
 * `whenProvided(keys, setup)` runs part of a plugin only while every key in `keys` is provided,
 * for a service the plugin can work without. Call it during the plugin's setup, or inside another
 * `whenProvided` setup. It registers `setup` for the lifetime of the scope it is called in and
 * returns at once. Once that setup has succeeded and every key is provided, the
 * registry runs `setup` with each key's value under its own name, in a child scope that is closed
 * before a provider of any key closes; `setup` runs again when every key is provided again.
 * `provide`, `Effect.forkScoped` and a nested `whenProvided` inside `setup` end with that child
 * scope. A `setup` that fails or runs past the setup time limit closes its child scope and is
 * logged, the plugin stays loaded, and it runs again only after one of its keys is withdrawn and
 * provided again. Inside `setup`, `provide` of a key already provided fails with
 * {@link ServiceKeyTakenError}. The keys need no entry in the manifest's `inject`. Any other call
 * fails with {@link WhenProvidedRefusedError}.
 *
 * A key is a string or a {@link ServiceKey}. Reading with a `ServiceKey<A>` gives `A`: `inject`
 * returns `Option<A>` and `whenProvided` passes each value under the key's name. A provided value
 * that fails the reading key's `is`, or whose `is` throws, counts as not provided, and the
 * registry logs a warning naming the key and the provider. A string key reads `unknown`.
 */
export interface PluginServices {
  readonly name: string
  readonly provide: {
    <A>(key: ServiceKey<A>, value: A): Effect.Effect<void, ServiceKeyTakenError, Scope.Scope>
    (key: string, value: unknown): Effect.Effect<void, ServiceKeyTakenError, Scope.Scope>
  }
  readonly inject: {
    <A>(key: ServiceKey<A>): Effect.Effect<Option.Option<A>, ServiceNotDeclaredError>
    (key: string): Effect.Effect<Option.Option<unknown>, ServiceNotDeclaredError>
  }
  readonly whenProvided: <const Keys extends readonly [AnyServiceKey, ...Array<AnyServiceKey>]>(
    keys: Keys,
    setup: (
      services: {
        readonly [K in Keys[number] as ServiceKeyName<K>]: ServiceKeyValue<K>
      }
    ) => Effect.Effect<void, unknown, Scope.Scope>
  ) => Effect.Effect<void, WhenProvidedRefusedError, Scope.Scope>
}

/**
 * Failure of one run of a background activity. `message` is shown on the Plugins page, cut to
 * 500 characters; `retryAt` is when the next run is due.
 */
export class ActivityRunFailed extends Data.TaggedError('ActivityRunFailed')<{
  readonly message: string
  readonly retryAt: DateTime.Utc
}> {}

/**
 * A background activity a plugin registers with {@link PluginActivities.register}. `id` must be
 * an `ActivityId` that the plugin has not registered yet; `label` is shown on the Plugins page.
 * The first run is due at `firstRunAt` (a time in the past runs at once). `run` performs one run
 * and succeeds with when the next run is due, or fails with {@link ActivityRunFailed}. `run`
 * bounds its own duration: the Host imposes no timeout.
 */
export interface ActivitySpec {
  readonly id: string
  readonly label: string
  readonly firstRunAt: DateTime.Utc
  readonly run: Effect.Effect<DateTime.Utc, ActivityRunFailed>
}

/** A registered background activity, returned by {@link PluginActivities.register}. */
export interface ActivityHandle {
  /**
   * Starts a run now and completes when it ends, whatever its outcome. When a run is already in
   * progress it waits for that run instead of starting a second one. Completes without running
   * when the activity's scope has closed.
   */
  readonly runNow: Effect.Effect<void>
}

/** Registration of background activities, offered to a plugin's `host` entry as `ctx.activities`. */
export interface PluginActivities {
  /**
   * Schedules `spec` until the scope it runs in closes (the plugin's setup scope), after which the
   * activity stops and disappears from the Plugins page. An `id` that is not an `ActivityId`, or
   * that this plugin already registered, is a defect.
   */
  readonly register: (spec: ActivitySpec) => Effect.Effect<ActivityHandle, never, Scope.Scope>
}

/** dia's window, offered to a plugin's `host` entry as `ctx.window`. */
export interface PluginWindow {
  /**
   * Whether the user can see the window (shown, not minimised and focused): the current value
   * first, then each change. Consume it in a fiber forked into the plugin's scope.
   */
  readonly attended: Stream.Stream<boolean>
  /**
   * Shows `notification` as an OS notification. Clicking it brings the window forward and shows
   * the tab of its `paneId`. A newer notification for the same `paneId` replaces the older one.
   */
  readonly notify: (notification: AgentNotification) => Effect.Effect<void>
}

/**
 * The context a plugin's `host` entry receives: {@link PluginServices} plus `events`, a fresh
 * stream of every renderer-facing event the Host publishes from now on (consume it in a fiber
 * forked into the plugin's scope; the stream ends when that scope closes); `dataDir`, the
 * absolute path of a directory only this plugin uses, which exists before setup runs and is kept
 * across reloads, overrides and restarts; `activities`, where the plugin registers background
 * activities; `database`, which opens the plugin's own SQLite database `<dataDir>/data.db`;
 * `workspace`, the projects and tabs with the visible tab, first as they are now and then after
 * each change (consume it like `events`); and `window`, dia's window.
 */
export interface HostPluginContext extends PluginServices {
  readonly events: Stream.Stream<EventFrame>
  readonly workspace: Stream.Stream<Workspace>
  readonly window: PluginWindow
  readonly dataDir: string
  /**
   * Subscribes this plugin as an owner of stored paths until the calling scope (the setup scope)
   * closes. `handle` receives every folder the Host moved (a plugin data migration) that this
   * plugin has not yet handled, oldest first: at once, and again whenever a later move is
   * recorded. Rewrite each stored path under `move.from` with `relocatePath`. A move counts as
   * handled when `handle` succeeds; after a failure it is given again at the next subscription.
   * Call it before providing services that read the stored paths.
   */
  readonly onPathsMoved: (
    handle: (move: PathsMoved) => Effect.Effect<void, unknown>
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly activities: PluginActivities
  /**
   * Succeeds once the Host's startup has settled every eager plugin (loaded, waiting, failed or
   * restart-required); at once in a plugin loaded after that. Wait on it to tell a contribution
   * that another plugin has not registered yet from one that is absent.
   */
  readonly pluginsSettled: Effect.Effect<void>
  /**
   * Opens this plugin's SQLite database, `<dataDir>/data.db`, applies `migrations`, and returns a
   * client for it. The connection closes when the scope it runs in (the plugin's setup scope)
   * closes. The file is created on the first call and kept across reloads, overrides and
   * restarts. Call it at most once per setup; a second call in the same setup is a defect, even
   * when the first call failed.
   */
  readonly database: (
    migrations: PluginMigrations
  ) => Effect.Effect<SqlClient.SqlClient, PluginDatabaseError, Scope.Scope>
  /**
   * Serves `rpc`, declared with `Rpc.make` in a module both of this plugin's entries import, for
   * calls from any plugin's `renderer` entry, until the scope it runs in closes. Declare a
   * struct `payload` (`payload: {}` when the call takes none). To serve other plugins, declare
   * `rpc` in a file listed in `plugin.json` `exports`, which they import.
   *
   * A request/response `rpc` takes a handler returning an effect and is called with `callHost`.
   * The handler can run more than once for one call, and the runs can overlap: the renderer resends
   * a call while the Host connection is down, and the first run is not cancelled, so make it safe
   * to repeat. The handler's second argument, a `PluginCallAttempt`, carries the call's `id`, the
   * same on every resend, and `resent`; a handler that must apply once records `id` and returns
   * the recorded result for an `id` it has seen. Closing the scope waits up to 30 seconds for
   * running handlers, then interrupts them; the caller then sees `PluginNotServing` although the
   * handler may have partly run.
   *
   * A streaming `rpc` (`Rpc.make(tag, { ..., stream: true })`) takes a handler returning a stream
   * and is followed with `followHost`. The handler runs once per subscription, and again for each
   * resubscription, so each run must start from the current state. A subscription holds no lease
   * on the plugin: closing the scope ends every subscription with `PluginNotServing`, interrupts
   * the effects they run, and waits up to 30 seconds for them to end. The handler stream may use
   * only resources of the scope that serves it or of an enclosing scope, never a service held
   * in a `whenProvided` or `inject` scope, which closes first.
   *
   * Serving a tag this plugin already serves in an open scope, or a tag another plugin has taken,
   * is a defect.
   */
  readonly serve: {
    <R extends Rpc.AnyWithProps>(
      rpc: R,
      handler: (
        payload: Rpc.Payload<R>,
        call: PluginCallAttempt
      ) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>>
    ): Effect.Effect<void, never, Scope.Scope>
    <R extends Rpc.AnyWithProps>(
      rpc: R,
      handler: (payload: Rpc.Payload<R>) => Stream.Stream<Rpc.SuccessChunk<R>, Rpc.ErrorExit<R>>
    ): Effect.Effect<void, never, Scope.Scope>
  }
}

/**
 * A migration key: `<id>_<name>`, for example `1_create_turns`. `id` is a non-negative integer,
 * unique within one owner's migrations.
 */
export type MigrationKey = `${number}_${string}`

/**
 * A plugin's migrations, keyed by {@link MigrationKey}. Pending migrations run once, in id order,
 * in a single transaction: if one fails, none of that run's migrations apply. A migration whose
 * id is not above the highest id already applied never runs, so add a new migration with an id
 * above every shipped one, and never edit or renumber a shipped one.
 */
export type PluginMigrations = Readonly<
  Record<MigrationKey, Effect.Effect<void, unknown, SqlClient.SqlClient>>
>

/**
 * Failure of `ctx.database`: `filename` could not be opened, a migration key is malformed or
 * duplicated, or a migration failed. `message` states which.
 */
export class PluginDatabaseError extends Data.TaggedError('PluginDatabaseError')<{
  readonly filename: string
  readonly message: string
}> {}

/**
 * The setup effect a plugin entry exports as its default export. It receives the plugin's
 * context, runs in the plugin's own scope, and registers everything through that scope (fibers
 * with `Effect.forkScoped`, resources with `Effect.acquireRelease`), so closing the scope
 * releases all of it in reverse order.
 */
export type PluginSetup<Context extends PluginServices> = (
  ctx: Context
) => Effect.Effect<void, unknown, Scope.Scope>
