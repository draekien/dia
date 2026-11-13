import { assert, describe, it } from '@effect/vitest'
import type { PluginCallResultJson } from '@shared/ipc/contract'
import type { HostPluginContext, PluginServices, PluginSetup } from '@shared/plugin/api'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import {
  PluginCallError,
  PluginSubscriptionEnd,
  PluginSubscriptionFailure
} from '@shared/plugin/messages'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Duration, Effect, Exit, Fiber, Option, Queue, Schema, Scope, Stream } from 'effect'
import { Rpc } from 'effect/rpc'
import { TestClock } from 'effect/testing'
import { afterEach, vi } from 'vitest'
import { callPlugin, servePluginCall, subscribePlugin } from '../../../host/plugins/plugin-messages'
import { callHost, followHost } from './plugin-messages'

interface ServingContext extends PluginServices {
  readonly serve: HostPluginContext['serve']
}

class GreetingRefused extends Schema.TaggedError<GreetingRefused>()('GreetingRefused', {
  reason: Schema.String
}) {}

const Greet = Rpc.make('Greet', {
  payload: { plugin: Schema.String, payload: Schema.String },
  success: Schema.String,
  error: GreetingRefused
})

const Ticks = Rpc.make('Ticks', {
  payload: {},
  success: Schema.Number,
  error: GreetingRefused,
  stream: true
})

const Count = Rpc.make('Count', { payload: { n: Schema.Number }, success: Schema.Number })
const CountAsText = Rpc.make('Count', { payload: { n: Schema.String }, success: Schema.Number })

const EXAMPLE = 'example'
const ctx = { name: EXAMPLE }

const OTHER = 'dia-other'

const manifestOf = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const makeRegistry = (setup: PluginSetup<ServingContext>, name = EXAMPLE) =>
  makePluginRegistry<ServingContext>({
    catalog: {
      names: () => Effect.succeed([name]),
      resolve: () => Effect.succeed(Option.some({ root: name, origin: 'default' as const }))
    },
    loader: {
      peek: () => Effect.succeed(manifestOf(name)),
      load: (_name, _root, use) =>
        use({
          manifest: manifestOf(name),
          resolveSetup: Effect.succeed(Option.some(setup)),
          importers: []
        })
    },
    extend: (services) => {
      const served = new Set<string>()
      return Effect.succeed({
        ...services,
        serve: <R extends Rpc.AnyWithProps>(
          rpc: R,
          handler: Parameters<typeof servePluginCall<R>>[3]
        ) => servePluginCall(services, served, rpc, handler)
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
            callPlugin(registry, {
              plugin,
              tag,
              payload,
              call: { id: 'call-1', resent: false }
            }).pipe(
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

  it.effect("returns the typed result of another plugin's host handler", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(
        (plugin) => plugin.serve(Count, ({ n }) => Effect.succeed(n + 1)),
        OTHER
      )
      yield* registry.load(OTHER)
      routeCallsTo(registry)

      const counted = yield* callHost(OTHER, Count, { n: 41 })

      assert.strictEqual(counted, 42)
    })
  )

  it.effect("fails with another plugin's typed error decoded by its schema", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(
        (plugin) =>
          plugin.serve(Greet, () => Effect.fail(new GreetingRefused({ reason: 'too early' }))),
        OTHER
      )
      yield* registry.load(OTHER)
      routeCallsTo(registry)

      const error = yield* Effect.flip(callHost(OTHER, Greet, { plugin: EXAMPLE, payload: 'x' }))

      assert.instanceOf(error, GreetingRefused)
      assert.strictEqual(error.reason, 'too early')
    })
  )

  it.effect("fails with PluginNotServing when the caller's own plugin is named instead", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(
        (plugin) => plugin.serve(Count, ({ n }) => Effect.succeed(n)),
        OTHER
      )
      yield* registry.load(OTHER)
      routeCallsTo(registry)

      const error = yield* Effect.flip(callHost(ctx, Count, { n: 1 }))

      assert.strictEqual(error._tag, 'PluginNotServing')
    })
  )

  it.effect('fails with PluginCallInvalid without calling the Host when the name is invalid', () =>
    Effect.gen(function* () {
      const call = vi.fn()
      vi.stubGlobal('window', { dia: { plugins: { call } } })

      const error = yield* Effect.flip(callHost('Dia-Other', Count, { n: 1 }))

      assert.strictEqual(error._tag, 'PluginCallInvalid')
      assert.strictEqual(call.mock.calls.length, 0)
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

const encodeSubscriptionEnd = Schema.encodeSync(PluginSubscriptionEnd)

const routeSubscriptionsTo = (registry: PluginRegistry) => {
  const statusListeners = new Set<(event: { readonly name: string }) => void>()
  const unsubscribed = { count: 0 }
  vi.stubGlobal('window', {
    dia: {
      plugins: {
        subscribe: (
          plugin: string,
          tag: string,
          payload: unknown,
          onValue: (value: unknown) => void,
          onEnd: (end: unknown) => void
        ) => {
          const fiber = Effect.runFork(
            subscribePlugin(registry, { plugin, tag, payload }).pipe(
              Effect.flatMap(Stream.runForEach((value) => Effect.sync(() => onValue(value)))),
              Effect.match({
                onSuccess: () => onEnd({ _tag: 'PluginSubscriptionDone' }),
                onFailure: (error) =>
                  onEnd(encodeSubscriptionEnd(PluginSubscriptionFailure.make({ error })))
              })
            )
          )
          return () => {
            unsubscribed.count += 1
            Effect.runFork(Fiber.interrupt(fiber))
          }
        },
        onStatusChanged: (listener: (event: { readonly name: string }) => void) => {
          statusListeners.add(listener)
          return () => statusListeners.delete(listener)
        }
      }
    }
  })
  return {
    unsubscribed,
    waiting: () => statusListeners.size > 0,
    emitStatusChanged: (name: string) => {
      for (const listener of statusListeners) listener({ name })
    }
  }
}

const tick = TestClock.withLive(Effect.sleep(Duration.millis(5)))

const untilTrue = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) yield* tick
  })

const followInto = (queue: Queue.Queue<Option.Option<number>>) =>
  Effect.forkChild(
    Stream.runForEach(followHost(ctx, Ticks, {}), (value) => Queue.offer(queue, value))
  )

const settle = Effect.repeat(tick, { times: 4 })

const servingOneThenNever = (plugin: ServingContext) =>
  plugin.serve(Ticks, () => Stream.concat(Stream.make(1), Stream.never))

const followUntilNotServing = (registry: PluginRegistry) =>
  Effect.gen(function* () {
    const host = routeSubscriptionsTo(registry)
    const queue = yield* Queue.unbounded<Option.Option<number>>()
    yield* followInto(queue)
    yield* Queue.take(queue)
    yield* registry.unload(EXAMPLE)
    yield* Queue.take(queue)
    yield* registry.load(EXAMPLE)
    yield* untilTrue(host.waiting)
    yield* tick
    return { host, queue }
  })

describe('followHost', () => {
  it.effect('emits Some of each decoded value the host entry streams', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) => plugin.serve(Ticks, () => Stream.make(1, 2)))
      yield* registry.load(EXAMPLE)
      routeSubscriptionsTo(registry)

      const values = yield* Stream.runCollect(followHost(ctx, Ticks, {}))

      assert.deepStrictEqual(values, [Option.some(1), Option.some(2)])
    })
  )

  it.effect("emits Some of each value another plugin's host entry streams", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(
        (plugin) => plugin.serve(Ticks, () => Stream.make(3, 4)),
        OTHER
      )
      yield* registry.load(OTHER)
      routeSubscriptionsTo(registry)

      const values = yield* Stream.runCollect(followHost(OTHER, Ticks, {}))

      assert.deepStrictEqual(values, [Option.some(3), Option.some(4)])
    })
  )

  it.effect('fails with PluginCallInvalid without subscribing when the name is invalid', () =>
    Effect.gen(function* () {
      const subscribe = vi.fn()
      vi.stubGlobal('window', { dia: { plugins: { subscribe } } })

      const error = yield* Stream.runCollect(followHost('Dia-Other', Ticks, {})).pipe(Effect.flip)

      assert.strictEqual(error._tag, 'PluginCallInvalid')
      assert.strictEqual(subscribe.mock.calls.length, 0)
    })
  )

  it.effect("fails with the handler's own typed error", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((plugin) =>
        plugin.serve(Ticks, () => Stream.fail(new GreetingRefused({ reason: 'too early' })))
      )
      yield* registry.load(EXAMPLE)
      routeSubscriptionsTo(registry)

      const error = yield* Stream.runCollect(followHost(ctx, Ticks, {})).pipe(Effect.flip)

      assert.instanceOf(error, GreetingRefused)
    })
  )

  it.effect('ends the host subscription when the stream is interrupted', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(servingOneThenNever)
      yield* registry.load(EXAMPLE)
      const host = routeSubscriptionsTo(registry)

      const first = yield* Stream.runHead(followHost(ctx, Ticks, {}))

      assert.deepStrictEqual(first, Option.some(Option.some(1)))
      assert.strictEqual(host.unsubscribed.count, 1)
    })
  )

  it.effect(
    'emits None when the host entry stops serving, and subscribes again after a status change of its plugin',
    () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry(servingOneThenNever)
        yield* registry.load(EXAMPLE)
        const host = routeSubscriptionsTo(registry)
        const queue = yield* Queue.unbounded<Option.Option<number>>()
        yield* followInto(queue)
        const seen = [yield* Queue.take(queue)]

        yield* registry.unload(EXAMPLE)
        seen.push(yield* Queue.take(queue))
        yield* registry.load(EXAMPLE)
        yield* untilTrue(host.waiting)
        yield* tick
        host.emitStatusChanged(EXAMPLE)
        seen.push(yield* Queue.take(queue))

        assert.deepStrictEqual(seen, [Option.some(1), Option.none(), Option.some(1)])
      })
  )

  it.effect('does not subscribe again after a status change of another plugin', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(servingOneThenNever)
      yield* registry.load(EXAMPLE)
      const { host, queue } = yield* followUntilNotServing(registry)

      host.emitStatusChanged('other')
      yield* settle

      assert.strictEqual(yield* Queue.size(queue), 0)
    })
  )

  it.effect('subscribes again after the retry interval when no status change arrives', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(servingOneThenNever)
      yield* registry.load(EXAMPLE)
      const { queue } = yield* followUntilNotServing(registry)

      yield* TestClock.adjust(Duration.seconds(5))
      const resumed = yield* Queue.take(queue)

      assert.deepStrictEqual(resumed, Option.some(1))
    })
  )
})
