import { assert, describe, it } from '@effect/vitest'
import type { HostPluginContext, PluginServices, PluginSetup } from '@shared/plugin/api'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import {
  makePluginRegistry,
  type PluginRegistry,
  SERVICE_USE_TIME_LIMIT
} from '@shared/plugin/plugin-registry'
import { Deferred, Duration, Effect, Fiber, Option, Schema, Stream } from 'effect'
import { Rpc } from 'effect/rpc'
import { TestClock } from 'effect/testing'
import { callPlugin, servePluginCall, subscribePlugin } from './plugin-messages'

interface ServingContext extends PluginServices {
  readonly serve: HostPluginContext['serve']
}

class TicksRefused extends Schema.TaggedError<TicksRefused>()('TicksRefused', {
  reason: Schema.String
}) {}

const Ticks = Rpc.make('Ticks', {
  payload: { payload: Schema.Number },
  success: Schema.Number,
  error: TicksRefused,
  stream: true
})
const Greet = Rpc.make('Greet', { payload: {}, success: Schema.String })

const EXAMPLE = 'example'

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
        serve: <R extends Rpc.AnyWithProps>(
          rpc: R,
          handler: Parameters<typeof servePluginCall<R>>[3]
        ) => servePluginCall(services, served, rpc, handler)
      })
    }
  })

const settle = Effect.repeat(Effect.yieldNow, { times: 20 })

const signalWhenClosing = (closing: Deferred.Deferred<void>) =>
  Effect.addFinalizer(() => Deferred.succeed(closing, undefined))

const subscribeTo = (registry: PluginRegistry, payload: unknown = { payload: 0 }) =>
  subscribePlugin(registry, { plugin: EXAMPLE, tag: 'Ticks', payload })

const collectExit = (registry: PluginRegistry, payload?: unknown) =>
  subscribeTo(registry, payload).pipe(
    Effect.flatMap(Stream.runCollect),
    Effect.exit,
    Effect.forkChild
  )

const serveTicks =
  (handler: (payload: { readonly payload: number }) => Stream.Stream<number, TicksRefused>) =>
  (ctx: ServingContext) =>
    ctx.serve(Ticks, handler)

describe('subscribePlugin', () => {
  it.effect('delivers each value the handler stream emits, encoded, then completes', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(serveTicks(() => Stream.make(1, 2)))
      yield* registry.load(EXAMPLE)

      const values = yield* subscribeTo(registry).pipe(Effect.flatMap(Stream.runCollect))

      assert.deepStrictEqual(values, [1, 2])
    }).pipe(Effect.scoped)
  )

  it.effect('hands the handler the payload field of the call unchanged', () =>
    Effect.gen(function* () {
      const received: Array<number> = []
      const registry = yield* makeRegistry(
        serveTicks(({ payload }) => {
          received.push(payload)
          return Stream.empty
        })
      )
      yield* registry.load(EXAMPLE)

      yield* subscribeTo(registry, { payload: 7 }).pipe(Effect.flatMap(Stream.runDrain))

      assert.deepStrictEqual(received, [7])
    }).pipe(Effect.scoped)
  )

  it.effect("fails the stream with the handler's encoded typed error", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(
        serveTicks(() => Stream.fail(new TicksRefused({ reason: 'too early' })))
      )
      yield* registry.load(EXAMPLE)

      const error = yield* subscribeTo(registry).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.flip
      )

      assert.strictEqual(error._tag, 'PluginCallFailed')
    }).pipe(Effect.scoped)
  )

  it.effect(
    'ends a running subscription with PluginNotServing when the plugin unloads, without waiting 30 s',
    () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry(
          serveTicks(() => Stream.concat(Stream.make(1), Stream.never))
        )
        yield* registry.load(EXAMPLE)
        const subscriber = yield* collectExit(registry)
        yield* Effect.yieldNow

        yield* registry.unload(EXAMPLE)
        const exit = yield* Fiber.join(subscriber)

        assert.strictEqual(exit._tag, 'Failure')
        assert.include(JSON.stringify(exit), 'PluginNotServing')
      }).pipe(Effect.scoped)
  )

  it.effect('fails with PluginNotServing when the plugin is already unloaded', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(serveTicks(() => Stream.make(1)))
      yield* registry.load(EXAMPLE)
      yield* registry.unload(EXAMPLE)

      const error = yield* Effect.flip(subscribeTo(registry))

      assert.strictEqual(error._tag, 'PluginNotServing')
    }).pipe(Effect.scoped)
  )

  it.effect('fails with PluginNotServing when subscribing while the plugin is closing', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const closing = yield* Deferred.make<void>()
      const registry = yield* makeRegistry((ctx) =>
        Effect.gen(function* () {
          yield* ctx.serve(Ticks, () =>
            Stream.fromEffect(Effect.uninterruptible(Deferred.await(gate).pipe(Effect.as(1))))
          )
          yield* signalWhenClosing(closing)
        })
      )
      yield* registry.load(EXAMPLE)
      const stuck = yield* collectExit(registry)
      yield* Effect.yieldNow
      const unloading = yield* Effect.forkChild(registry.unload(EXAMPLE))
      yield* Deferred.await(closing)

      const error = yield* Effect.flip(subscribeTo(registry))
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(unloading)
      yield* Fiber.join(stuck)

      assert.strictEqual(error._tag, 'PluginNotServing')
    }).pipe(Effect.scoped)
  )

  it.effect('delivers values to a new subscriber after the plugin reloads', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(serveTicks(() => Stream.make(5)))
      yield* registry.load(EXAMPLE)
      yield* registry.unload(EXAMPLE)
      yield* registry.load(EXAMPLE)

      const values = yield* subscribeTo(registry).pipe(Effect.flatMap(Stream.runCollect))

      assert.deepStrictEqual(values, [5])
    }).pipe(Effect.scoped)
  )

  it.effect('interrupts an effect a subscription is running when the plugin closes', () =>
    Effect.gen(function* () {
      const interrupted = { value: false }
      const started = yield* Deferred.make<void>()
      const registry = yield* makeRegistry(
        serveTicks(() =>
          Stream.fromEffect(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted.value = true
                })
              )
            )
          )
        )
      )
      yield* registry.load(EXAMPLE)
      const subscriber = yield* collectExit(registry)
      yield* Deferred.await(started)

      yield* registry.unload(EXAMPLE)
      yield* Fiber.join(subscriber)

      assert.isTrue(interrupted.value)
    }).pipe(Effect.scoped)
  )

  it.effect('does not finish closing until a subscription blocked in an effect has ended', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const closing = yield* Deferred.make<void>()
      const registry = yield* makeRegistry((ctx) =>
        Effect.gen(function* () {
          yield* ctx.serve(Ticks, () =>
            Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.uninterruptible(Deferred.await(gate))),
                Effect.as(1)
              )
            )
          )
          yield* signalWhenClosing(closing)
        })
      )
      yield* registry.load(EXAMPLE)
      const subscriber = yield* collectExit(registry)
      yield* Deferred.await(started)
      const unloading = yield* Effect.forkChild(registry.unload(EXAMPLE))
      yield* Deferred.await(closing)
      yield* settle

      const finishedEarly = unloading.pollUnsafe() !== undefined
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(unloading)
      yield* Fiber.join(subscriber)

      assert.isFalse(finishedEarly)
    }).pipe(Effect.scoped)
  )

  it.effect(
    'refuses to start a stream built before the plugin closed, and never runs its handler',
    () =>
      Effect.gen(function* () {
        let handlerRuns = 0
        const registry = yield* makeRegistry(
          serveTicks(() => {
            handlerRuns += 1
            return Stream.make(1)
          })
        )
        yield* registry.load(EXAMPLE)
        const stream = yield* subscribeTo(registry)
        yield* registry.unload(EXAMPLE)

        const error = yield* Stream.runCollect(stream).pipe(Effect.flip)

        assert.strictEqual(error._tag, 'PluginNotServing')
        assert.strictEqual(handlerRuns, 0)
      }).pipe(Effect.scoped)
  )

  it.effect(
    'stalls closing for at most SERVICE_USE_TIME_LIMIT when a subscription cannot be interrupted',
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const closing = yield* Deferred.make<void>()
        const registry = yield* makeRegistry((ctx) =>
          Effect.gen(function* () {
            yield* ctx.serve(Ticks, () =>
              Stream.fromEffect(
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.uninterruptible(Deferred.await(gate))),
                  Effect.as(1)
                )
              )
            )
            yield* signalWhenClosing(closing)
          })
        )
        yield* registry.load(EXAMPLE)
        const subscriber = yield* collectExit(registry)
        yield* Deferred.await(started)
        const unloading = yield* Effect.forkChild(registry.unload(EXAMPLE))
        yield* Deferred.await(closing)
        yield* settle

        yield* TestClock.adjust(Duration.millis(Duration.toMillis(SERVICE_USE_TIME_LIMIT) - 1))
        yield* settle
        const finishedBeforeLimit = unloading.pollUnsafe() !== undefined
        yield* TestClock.adjust(Duration.millis(1))
        yield* Fiber.join(unloading)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(subscriber)

        assert.isFalse(finishedBeforeLimit)
      }).pipe(Effect.scoped)
  )

  it.effect('fails with PluginCallInvalid when the tag is a request/response call', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry((ctx) => ctx.serve(Greet, () => Effect.succeed('hi')))
      yield* registry.load(EXAMPLE)

      const error = yield* Effect.flip(
        subscribePlugin(registry, { plugin: EXAMPLE, tag: 'Greet', payload: {} })
      )

      assert.strictEqual(error._tag, 'PluginCallInvalid')
    }).pipe(Effect.scoped)
  )
})

const Record = Rpc.make('Record', {
  payload: { id: Schema.String, resent: Schema.Boolean, call: Schema.String },
  success: Schema.Number
})

const recordCalls = (received: Array<unknown>) => (ctx: ServingContext) =>
  ctx.serve(Record, (payload, call) => {
    received.push({ payload: { ...payload }, call })
    return Effect.succeed(received.length)
  })

describe('callPlugin', () => {
  it.effect('hands the handler the call id and whether this attempt is a resend', () =>
    Effect.gen(function* () {
      const received: Array<{ readonly call: unknown }> = []
      const registry = yield* makeRegistry(recordCalls(received))
      yield* registry.load(EXAMPLE)
      const payload = { id: 'p', resent: false, call: 'c' }

      yield* callPlugin(registry, {
        plugin: EXAMPLE,
        tag: 'Record',
        payload,
        call: { id: 'call-7', resent: false }
      })
      yield* callPlugin(registry, {
        plugin: EXAMPLE,
        tag: 'Record',
        payload,
        call: { id: 'call-7', resent: true }
      })

      assert.deepStrictEqual(
        received.map((entry) => entry.call),
        [
          { id: 'call-7', resent: false },
          { id: 'call-7', resent: true }
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('hands the handler payload fields named id, resent and call unchanged', () =>
    Effect.gen(function* () {
      const received: Array<{ readonly payload: unknown }> = []
      const registry = yield* makeRegistry(recordCalls(received))
      yield* registry.load(EXAMPLE)

      yield* callPlugin(registry, {
        plugin: EXAMPLE,
        tag: 'Record',
        payload: { id: 'inner', resent: true, call: 'inner-call' },
        call: { id: 'call-1', resent: false }
      })

      assert.deepStrictEqual(received[0]?.payload, {
        id: 'inner',
        resent: true,
        call: 'inner-call'
      })
    }).pipe(Effect.scoped)
  )
})

describe('callPlugin on a streaming tag', () => {
  it.effect('fails with PluginCallInvalid', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(serveTicks(() => Stream.make(1)))
      yield* registry.load(EXAMPLE)

      const error = yield* Effect.flip(
        callPlugin(registry, {
          plugin: EXAMPLE,
          tag: 'Ticks',
          payload: { payload: 0 },
          call: { id: 'call-1', resent: false }
        })
      )

      assert.strictEqual(error._tag, 'PluginCallInvalid')
    }).pipe(Effect.scoped)
  )
})
