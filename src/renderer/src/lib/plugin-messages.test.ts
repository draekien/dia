import { assert, describe, it } from '@effect/vitest'
import type { PluginCallResultJson } from '@shared/ipc/contract'
import type { PluginServices, PluginSetup } from '@shared/plugin/api'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { PluginCallError } from '@shared/plugin/messages'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Exit, Option, Schema, Scope } from 'effect'
import { Rpc } from 'effect/rpc'
import { afterEach, vi } from 'vitest'
import { callPlugin, servePluginCall } from '../../../host/plugins/plugin-messages'
import { callHost } from './plugin-messages'

interface ServingContext extends PluginServices {
  readonly serve: <R extends Rpc.AnyWithProps>(
    rpc: R,
    handler: (payload: Rpc.Payload<R>) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>>
  ) => Effect.Effect<void, never, Scope.Scope>
}

class GreetingRefused extends Schema.TaggedError<GreetingRefused>()('GreetingRefused', {
  reason: Schema.String
}) {}

const Greet = Rpc.make('Greet', {
  payload: { plugin: Schema.String, payload: Schema.String },
  success: Schema.String,
  error: GreetingRefused
})

const Count = Rpc.make('Count', { payload: { n: Schema.Number }, success: Schema.Number })
const CountAsText = Rpc.make('Count', { payload: { n: Schema.String }, success: Schema.Number })

const EXAMPLE = 'example'
const ctx = { name: EXAMPLE }

const manifest: PluginManifest = {
  name: EXAMPLE,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
}

const makeRegistry = (setup: PluginSetup<ServingContext>) =>
  makePluginRegistry<ServingContext>({
    catalog: {
      names: () => Effect.succeed([EXAMPLE]),
      resolve: () => Effect.succeed(Option.some({ root: EXAMPLE, origin: 'default' as const }))
    },
    loader: {
      peek: () => Effect.succeed(manifest),
      load: (_name, _root, use) =>
        use({ manifest, resolveSetup: Effect.succeed(Option.some(setup)), importers: [] })
    },
    extend: (services) => {
      const served = new Set<string>()
      return Effect.succeed({
        ...services,
        serve: (rpc, handler) => servePluginCall(services, served, rpc, handler)
      })
    }
  })

const encodeCallError = Schema.encodeSync(PluginCallError)

const routeCallsTo = (registry: PluginRegistry) =>
  vi.stubGlobal('window', {
    dia: {
      plugins: {
        call: (plugin: string, tag: string, payload: unknown) =>
          Effect.runPromise(
            callPlugin(registry, { plugin, tag, payload }).pipe(
              Effect.match({
                onSuccess: (value): PluginCallResultJson => ({ _tag: 'Success', value }),
                onFailure: (error): PluginCallResultJson => ({
                  _tag: 'Failure',
                  error: encodeCallError(error)
                })
              })
            )
          )
      }
    }
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callHost', () => {
  it.effect("returns the result of the plugin's own host handler", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) =>
        plugin.serve(Greet, ({ payload }) => Effect.succeed(`hello ${payload}`))
      )
      yield* registry.load(EXAMPLE)
      routeCallsTo(registry)

      const greeting = yield* callHost(ctx, Greet, { plugin: 'ignored', payload: 'otter' })

      assert.strictEqual(greeting, 'hello otter')
    })
  )

  it.effect('hands the handler payload fields named plugin and payload unchanged', () =>
    Effect.gen(function* () {
      const received: Array<unknown> = []
      const registry = yield* makeRegistry((plugin) =>
        plugin.serve(Greet, (payload) => {
          received.push({ ...payload })
          return Effect.succeed('ok')
        })
      )
      yield* registry.load(EXAMPLE)
      routeCallsTo(registry)

      yield* callHost(ctx, Greet, { plugin: 'not-the-caller', payload: 'inner' })

      assert.deepStrictEqual(received, [{ plugin: 'not-the-caller', payload: 'inner' }])
    })
  )

  it.effect("fails with the handler's own typed error", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) =>
        plugin.serve(Greet, () => Effect.fail(new GreetingRefused({ reason: 'too early' })))
      )
      yield* registry.load(EXAMPLE)
      routeCallsTo(registry)

      const error = yield* Effect.flip(callHost(ctx, Greet, { plugin: 'x', payload: 'y' }))

      assert.instanceOf(error, GreetingRefused)
      assert.strictEqual(error.reason, 'too early')
    })
  )

  it.effect('fails with PluginNotServing after the host entry unloads', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) =>
        plugin.serve(Greet, () => Effect.succeed('hi'))
      )
      yield* registry.load(EXAMPLE)
      yield* registry.unload(EXAMPLE)
      routeCallsTo(registry)

      const error = yield* Effect.flip(callHost(ctx, Greet, { plugin: 'x', payload: 'y' }))

      assert.strictEqual(error._tag, 'PluginNotServing')
    })
  )

  it.effect('fails with PluginNotServing for a tag the host entry does not serve', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) =>
        plugin.serve(Greet, () => Effect.succeed('hi'))
      )
      yield* registry.load(EXAMPLE)
      routeCallsTo(registry)

      const error = yield* Effect.flip(callHost(ctx, Count, { n: 1 }))

      assert.strictEqual(error._tag, 'PluginNotServing')
    })
  )

  it.effect("fails with PluginCallInvalid when the entries disagree on the call's payload", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) =>
        plugin.serve(CountAsText, ({ n }) => Effect.succeed(n.length))
      )
      yield* registry.load(EXAMPLE)
      routeCallsTo(registry)

      const error = yield* Effect.flip(callHost(ctx, Count, { n: 1 }))

      assert.strictEqual(error._tag, 'PluginCallInvalid')
    })
  )
})

describe('servePluginCall', () => {
  it.effect('withdraws the handler when the scope that served it closes', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const registry = yield* makeRegistry((plugin) =>
        plugin.serve(Greet, () => Effect.succeed('hi')).pipe(Scope.provide(scope))
      )
      yield* registry.load(EXAMPLE)
      yield* Scope.close(scope, Exit.void)
      routeCallsTo(registry)

      const error = yield* Effect.flip(callHost(ctx, Greet, { plugin: 'x', payload: 'y' }))

      assert.strictEqual(error._tag, 'PluginNotServing')
    })
  )

  it.effect('serves a tag again once the scope that first served it has closed', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) =>
        Effect.gen(function* () {
          const first = yield* Scope.make()
          yield* plugin.serve(Greet, () => Effect.succeed('first')).pipe(Scope.provide(first))
          yield* Scope.close(first, Exit.void)
          yield* plugin.serve(Greet, () => Effect.succeed('second'))
        })
      )
      yield* registry.load(EXAMPLE)
      routeCallsTo(registry)

      const greeting = yield* callHost(ctx, Greet, { plugin: 'x', payload: 'y' })

      assert.strictEqual(greeting, 'second')
    })
  )

  it.effect('refuses to load a plugin that serves one tag twice', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) =>
        Effect.gen(function* () {
          yield* plugin.serve(Greet, () => Effect.succeed('first'))
          yield* plugin.serve(Greet, () => Effect.succeed('second'))
        })
      )

      const info = yield* registry.load(EXAMPLE)

      assert.strictEqual(info.status._tag, 'Failed')
    })
  )
})
