import { Data, type DateTime, type Effect, type Option, type Scope, type Stream } from 'effect'
import type { EventFrame } from '../ipc/rpc'

/** Service key under which the `worktrees` plugin provides the Host's `GitOps`. */
export const WORKTREES_KEY = 'worktrees'

/**
 * Failure of `ctx.provide` when another loaded plugin already provides `key`. `owner` is the
 * name of that plugin. The plugin that hit it fails to load and keeps no registrations.
 */
export class ServiceKeyTakenError extends Data.TaggedError('ServiceKeyTakenError')<{
  readonly key: string
  readonly owner: string
}> {}

/**
 * Failure of `ctx.provide` when a feature plugin provides `key`, a service key that only an
 * adapter plugin may provide. `message` names the key. The plugin that hit it fails to load and
 * keeps no registrations.
 */
export class ServiceKeyReservedError extends Data.TaggedError('ServiceKeyReservedError')<{
  readonly key: string
  readonly message: string
}> {}

/**
 * What every plugin context offers, on the host and in the renderer. `provide` publishes `value`
 * under `key` for the lifetime of the scope it runs in, and fails when another plugin provides
 * `key` or when a feature plugin provides a key reserved for adapter plugins; `inject` reads the value for `key` and is empty when no loaded plugin provides it. A
 * plugin that lists a key in its manifest `inject` is reopened whenever that key's provider
 * changes.
 */
export interface PluginServices {
  readonly name: string
  readonly provide: (
    key: string,
    value: unknown
  ) => Effect.Effect<void, ServiceKeyTakenError | ServiceKeyReservedError, Scope.Scope>
  readonly inject: (key: string) => Effect.Effect<Option.Option<unknown>>
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

/**
 * The context a plugin's `host` entry receives: {@link PluginServices} plus `events`, a fresh
 * stream of every renderer-facing event the Host publishes from now on (consume it in a fiber
 * forked into the plugin's scope; the stream ends when that scope closes); `dataDir`, the
 * absolute path of a directory only this plugin uses, which exists before setup runs and is kept
 * across reloads, overrides and restarts; and `activities`, where the plugin registers background
 * activities.
 */
export interface HostPluginContext extends PluginServices {
  readonly events: Stream.Stream<EventFrame>
  readonly dataDir: string
  readonly activities: PluginActivities
}

/**
 * The setup effect a plugin entry exports as its default export. It receives the plugin's
 * context, runs in the plugin's own scope, and registers everything through that scope (fibers
 * with `Effect.forkScoped`, resources with `Effect.acquireRelease`), so closing the scope
 * releases all of it in reverse order.
 */
export type PluginSetup<Context extends PluginServices> = (
  ctx: Context
) => Effect.Effect<void, unknown, Scope.Scope>
