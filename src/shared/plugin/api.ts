import { Data, type Effect, type Option, type Scope, type Stream } from 'effect'
import type { EventFrame } from '../ipc/rpc'

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
 * The context a plugin's `host` entry receives: {@link PluginServices} plus `events`, a fresh
 * stream of every renderer-facing event the Host publishes from now on. Consume it in a fiber
 * forked into the plugin's scope; the stream ends when that scope closes.
 */
export interface HostPluginContext extends PluginServices {
  readonly events: Stream.Stream<EventFrame>
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
