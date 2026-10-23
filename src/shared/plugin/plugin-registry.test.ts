import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Fiber, Option, type Scope } from 'effect'
import { TestClock } from 'effect/testing'
import type { PluginServices, PluginSetup } from './api'
import { PLUGIN_API_VERSION, type PluginManifest } from './manifest'
import { type LoadedPlugin, makePluginRegistry, PluginLoadError } from './plugin-registry'

const manifest = (name: string, overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  host: 'host.ts',
  ...overrides
})

const plugin = (
  manifestFields: PluginManifest,
  setup?: PluginSetup<PluginServices>
): LoadedPlugin<PluginServices> => ({
  manifest: manifestFields,
  setup: Option.fromNullishOr(setup)
})

const recording =
  (
    name: string,
    log: Array<string>,
    body: (ctx: PluginServices) => Effect.Effect<void, unknown, Scope.Scope> = () => Effect.void
  ): PluginSetup<PluginServices> =>
  (ctx) =>
    Effect.gen(function* () {
      log.push(`${name}:open`)
      yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`${name}:close`)))
      yield* body(ctx)
    })

const makeRegistry = (plugins: Record<string, LoadedPlugin<PluginServices>>) =>
  makePluginRegistry<PluginServices>({
    catalog: {
      names: () => Effect.succeed(Object.keys(plugins)),
      resolve: (name) =>
        Effect.succeed(
          Option.fromNullishOr(plugins[name]).pipe(
            Option.map(() => ({ root: name, origin: 'default' as const }))
          )
        )
    },
    loader: {
      load: (root) => {
        const found = plugins[root]
        return found === undefined
          ? Effect.fail(new PluginLoadError({ message: `missing ${root}` }))
          : Effect.succeed(found)
      }
    },
    extend: (services) => services
  })

const statusOf = (
  registry: {
    list: () => Effect.Effect<ReadonlyArray<{ name: string; status: { _tag: string } }>>
  },
  name: string
) =>
  registry.list().pipe(Effect.map((infos) => infos.find((info) => info.name === name)?.status._tag))

describe('plugin registry', () => {
  it.effect('releases a plugin registrations in reverse order when it unloads', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const registry = yield* makeRegistry({
        alpha: plugin(
          manifest('alpha'),
          recording('alpha', log, () =>
            Effect.addFinalizer(() => Effect.sync(() => void log.push('alpha:inner-close')))
          )
        )
      })

      const loaded = yield* registry.load('alpha')
      const unloaded = yield* registry.unload('alpha')

      assert.deepStrictEqual(loaded.status, { _tag: 'Loaded' })
      assert.deepStrictEqual(unloaded.status, { _tag: 'Unloaded' })
      assert.deepStrictEqual(log, ['alpha:open', 'alpha:inner-close', 'alpha:close'])
    }).pipe(Effect.scoped)
  )

  it.effect(
    'closes the old scope before opening the new one when a loaded plugin loads again',
    () =>
      Effect.gen(function* () {
        const log: Array<string> = []
        const registry = yield* makeRegistry({
          alpha: plugin(manifest('alpha'), recording('alpha', log))
        })

        yield* registry.load('alpha')
        yield* registry.load('alpha')

        assert.deepStrictEqual(log, ['alpha:open', 'alpha:close', 'alpha:open'])
      }).pipe(Effect.scoped)
  )

  it.effect('refuses a plugin built for another API version and leaves other plugins loaded', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const registry = yield* makeRegistry({
        good: plugin(manifest('good'), recording('good', log)),
        old: plugin(manifest('old', { api: '0' }), recording('old', log))
      })
      yield* registry.load('good')

      const refused = yield* registry.load('old')

      assert.deepStrictEqual(refused.status, {
        _tag: 'Failed',
        message: `Plugin API version "0" does not match the installed version "${PLUGIN_API_VERSION}"`
      })
      assert.strictEqual(yield* statusOf(registry, 'good'), 'Loaded')
      assert.deepStrictEqual(log, ['good:open'])
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a manifest whose name differs from its plugin name', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({ alpha: plugin(manifest('beta')) })

      const refused = yield* registry.load('alpha')

      assert.deepStrictEqual(refused.status, {
        _tag: 'Failed',
        message: 'Manifest name "beta" does not match the plugin directory "alpha"'
      })
    }).pipe(Effect.scoped)
  )

  it.effect('releases what a plugin registered before its setup failed and reports Failed', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const registry = yield* makeRegistry({
        broken: plugin(
          manifest('broken'),
          recording('broken', log, () => Effect.fail('boom'))
        )
      })

      const result = yield* registry.load('broken')

      assert.deepStrictEqual(result.status, { _tag: 'Failed', message: 'boom' })
      assert.deepStrictEqual(log, ['broken:open', 'broken:close'])
    }).pipe(Effect.scoped)
  )

  it.effect('reports Failed when a plugin cannot be loaded and again for an unknown name', () =>
    Effect.gen(function* () {
      const registry = yield* makePluginRegistry<PluginServices>({
        catalog: {
          names: () => Effect.succeed(['alpha']),
          resolve: (name) =>
            Effect.succeed(
              name === 'alpha'
                ? Option.some({ root: 'x', origin: 'override' as const })
                : Option.none()
            )
        },
        loader: {
          load: () => Effect.fail(new PluginLoadError({ message: 'unreadable plugin.json' }))
        },
        extend: (services) => services
      })

      const unreadable = yield* registry.load('alpha')
      const unknown = yield* registry.load('nope')

      assert.deepStrictEqual(unreadable.status, {
        _tag: 'Failed',
        message: 'unreadable plugin.json'
      })
      assert.strictEqual(unreadable.origin, 'override')
      assert.deepStrictEqual(unknown.status, { _tag: 'Failed', message: 'No plugin named "nope"' })
    }).pipe(Effect.scoped)
  )

  it.effect('holds a plugin Waiting until a plugin provides the service it injects', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const registry = yield* makeRegistry({
        consumer: plugin(manifest('consumer', { inject: ['db'] }), recording('consumer', log)),
        provider: plugin(
          manifest('provider'),
          recording('provider', log, (ctx) => ctx.provide('db', 'connection'))
        )
      })

      const waiting = yield* registry.load('consumer')
      yield* registry.load('provider')

      assert.deepStrictEqual(waiting.status, { _tag: 'Waiting', missing: ['db'] })
      assert.strictEqual(yield* statusOf(registry, 'consumer'), 'Loaded')
      assert.deepStrictEqual(log, ['provider:open', 'consumer:open'])
    }).pipe(Effect.scoped)
  )

  it.effect(
    'closes dependants before a provider reloads and reopens them after it provides again',
    () =>
      Effect.gen(function* () {
        const log: Array<string> = []
        let generation = 0
        const seen: Array<unknown> = []
        const registry = yield* makeRegistry({
          provider: plugin(manifest('provider'), (ctx) =>
            Effect.gen(function* () {
              generation += 1
              log.push(`provider:open:${generation}`)
              yield* Effect.addFinalizer(() => Effect.sync(() => void log.push('provider:close')))
              yield* ctx.provide('db', `connection-${generation}`)
            })
          ),
          consumer: plugin(manifest('consumer', { inject: ['db'] }), (ctx) =>
            Effect.gen(function* () {
              seen.push(Option.getOrUndefined(yield* ctx.inject('db')))
              log.push('consumer:open')
              yield* Effect.addFinalizer(() => Effect.sync(() => void log.push('consumer:close')))
            })
          )
        })
        yield* registry.load('provider')
        yield* registry.load('consumer')

        yield* registry.load('provider')

        assert.deepStrictEqual(log, [
          'provider:open:1',
          'consumer:open',
          'consumer:close',
          'provider:close',
          'provider:open:2',
          'consumer:open'
        ])
        assert.deepStrictEqual(seen, ['connection-1', 'connection-2'])
      }).pipe(Effect.scoped)
  )

  it.effect('sends dependants back to Waiting when their provider unloads', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        provider: plugin(manifest('provider'), (ctx) => ctx.provide('db', 1)),
        consumer: plugin(manifest('consumer', { inject: ['db'] }), recording('consumer', []))
      })
      yield* registry.load('provider')
      yield* registry.load('consumer')

      yield* registry.unload('provider')

      const infos = yield* registry.list()
      assert.deepStrictEqual(
        infos.map((info) => [info.name, info.status._tag]),
        [
          ['consumer', 'Waiting'],
          ['provider', 'Unloaded']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('fails a plugin that provides a service key another plugin already provides', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        first: plugin(manifest('first'), (ctx) => ctx.provide('db', 1)),
        second: plugin(manifest('second'), (ctx) => ctx.provide('db', 2))
      })
      yield* registry.load('first')

      const second = yield* registry.load('second')

      assert.strictEqual(second.status._tag, 'Failed')
      assert.strictEqual(yield* statusOf(registry, 'first'), 'Loaded')
    }).pipe(Effect.scoped)
  )

  it.effect('runs concurrent loads one after another', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const slow =
        (name: string): PluginSetup<PluginServices> =>
        () =>
          Effect.gen(function* () {
            log.push(`${name}:start`)
            yield* Effect.sleep(Duration.seconds(1))
            log.push(`${name}:end`)
          })
      const registry = yield* makeRegistry({
        alpha: plugin(manifest('alpha'), slow('alpha')),
        beta: plugin(manifest('beta'), slow('beta'))
      })

      const loads = yield* Effect.all([registry.load('alpha'), registry.load('beta')], {
        concurrency: 'unbounded'
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(2))
      yield* Fiber.join(loads)

      assert.deepStrictEqual(log, ['alpha:start', 'alpha:end', 'beta:start', 'beta:end'])
    }).pipe(Effect.scoped)
  )

  it.effect('leaves a fiber outside every plugin scope running through repeated reloads', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        observer: plugin(manifest('observer'), recording('observer', []))
      })
      const turn = yield* Effect.sleep(Duration.seconds(30)).pipe(
        Effect.as('finished'),
        Effect.forkChild
      )

      for (let reload = 0; reload < 20; reload++) {
        yield* registry.load('observer')
        yield* TestClock.adjust(Duration.seconds(1))
      }
      yield* registry.unload('observer')
      yield* TestClock.adjust(Duration.seconds(10))

      assert.strictEqual(yield* Fiber.join(turn), 'finished')
    }).pipe(Effect.scoped)
  )
})
