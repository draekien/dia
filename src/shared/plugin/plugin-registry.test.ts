import { assert, describe, it } from '@effect/vitest'
import { Deferred, Duration, Effect, Fiber, Option, type Scope } from 'effect'
import { TestClock } from 'effect/testing'
import type { PluginServices, PluginSetup } from './api'
import {
  type AdapterManifest,
  type FeatureManifest,
  PLUGIN_API_VERSION,
  type PluginInfo,
  type PluginManifest
} from './manifest'
import {
  type LoadedPlugin,
  makePluginRegistry,
  PluginLoadError,
  type PluginLoader,
  type PluginMemoryGuard,
  PluginRestartRequiredError
} from './plugin-registry'

const manifest = (name: string, overrides: Partial<FeatureManifest> = {}): FeatureManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts',
  ...overrides
})

const adapterManifest = (name: string): AdapterManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'adapter',
  host: 'host.ts'
})

const BACKEND_KEY = 'backend'

const requiresBackend = {
  keys: [BACKEND_KEY],
  problems: (provided: (key: string) => Option.Option<unknown>) =>
    Option.isSome(provided(BACKEND_KEY)) ? [] : [`setup did not provide "${BACKEND_KEY}"`]
}

const plugin = (
  manifestFields: PluginManifest,
  setup?: PluginSetup<PluginServices>
): LoadedPlugin<PluginServices> => ({
  manifest: manifestFields,
  resolveSetup: Effect.succeed(Option.fromNullishOr(setup))
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

const makeRegistry = (
  plugins: Record<string, LoadedPlugin<PluginServices>>,
  options: {
    readonly memory?: PluginMemoryGuard
    readonly loader?: PluginLoader<PluginServices>
    readonly onChange?: (changed: ReadonlyArray<PluginInfo>) => Effect.Effect<void>
  } = {}
) =>
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
    loader: options.loader ?? {
      peek: (root) => {
        const found = plugins[root]
        return found === undefined
          ? Effect.fail(new PluginLoadError({ message: `missing ${root}` }))
          : Effect.succeed(found.manifest)
      },
      load: (root, use) => {
        const found = plugins[root]
        return found === undefined
          ? Effect.fail(new PluginLoadError({ message: `missing ${root}` }))
          : use(found)
      }
    },
    extend: (services) => services,
    adapterContract: requiresBackend,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.onChange === undefined ? {} : { onChange: options.onChange })
  })

const recordChanges = (until: string) =>
  Effect.gen(function* () {
    const seen: Array<string> = []
    const reached = yield* Deferred.make<void>()
    const onChange = (changed: ReadonlyArray<PluginInfo>) =>
      Effect.gen(function* () {
        for (const info of changed) {
          const entry = `${info.name}:${info.status._tag}`
          seen.push(entry)
          if (entry === until) yield* Deferred.succeed(reached, undefined)
        }
      })
    return { seen, onChange, reached }
  })

const peekNotUsed: PluginLoader<PluginServices>['peek'] = () =>
  Effect.fail(new PluginLoadError({ message: 'peek is not used by this test' }))

const memoryGuard = (
  limit: number,
  totals: Record<string, number>,
  tracked: Array<string> = []
): PluginMemoryGuard => ({
  limit,
  used: (plugin) => Effect.succeed(totals[plugin] ?? 0),
  track: (plugin, effect) =>
    Effect.sync(() => void tracked.push(plugin)).pipe(Effect.andThen(effect))
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
          peek: peekNotUsed,
          load: () => Effect.fail(new PluginLoadError({ message: 'unreadable plugin.json' }))
        },
        extend: (services) => services,
        adapterContract: requiresBackend
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

  it.effect('lets the caller of the registry read a service a loaded plugin provides', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        provider: plugin(manifest('provider'), (ctx) => ctx.provide('db', 'connection'))
      })
      assert.deepStrictEqual(yield* registry.inject('db'), Option.none())

      yield* registry.load('provider')
      assert.deepStrictEqual(yield* registry.inject('db'), Option.some('connection'))

      yield* registry.unload('provider')
      assert.deepStrictEqual(yield* registry.inject('db'), Option.none())
    }).pipe(Effect.scoped)
  )

  it.effect('returns the replacement value after the provider reloads', () =>
    Effect.gen(function* () {
      let generation = 0
      const registry = yield* makeRegistry({
        provider: plugin(manifest('provider'), (ctx) => {
          generation += 1
          return ctx.provide('db', `connection-${generation}`)
        })
      })
      yield* registry.load('provider')
      yield* registry.load('provider')

      assert.deepStrictEqual(yield* registry.inject('db'), Option.some('connection-2'))
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
  it.effect('does not import the entry of a plugin built for another API version', () =>
    Effect.gen(function* () {
      let imports = 0
      const registry = yield* makeRegistry({
        old: {
          manifest: manifest('old', { api: '0' }),
          resolveSetup: Effect.sync(() => {
            imports += 1
            return Option.none()
          })
        }
      })

      yield* registry.load('old')

      assert.strictEqual(imports, 0)
    }).pipe(Effect.scoped)
  )

  it.effect('reports Failed with the import error when the entry cannot be imported', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        broken: {
          manifest: manifest('broken'),
          resolveSetup: Effect.fail(new PluginLoadError({ message: 'Cannot import "host.ts"' }))
        }
      })

      const result = yield* registry.load('broken')

      assert.deepStrictEqual(result.status, { _tag: 'Failed', message: 'Cannot import "host.ts"' })
    }).pipe(Effect.scoped)
  )

  it.effect('reports Failed when a setup function throws before returning an effect', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        thrower: plugin(manifest('thrower'), () => {
          throw new Error('sync boom')
        })
      })

      const result = yield* registry.load('thrower')

      assert.deepStrictEqual(result.status, { _tag: 'Failed', message: 'sync boom' })
    }).pipe(Effect.scoped)
  )

  describe('reloading with a failing new version', () => {
    it.effect('keeps the running version open and reports the validation failure', () =>
      Effect.gen(function* () {
        const log: Array<string> = []
        const plugins = { alpha: plugin(manifest('alpha'), recording('alpha', log)) }
        const registry = yield* makeRegistry(plugins)
        yield* registry.load('alpha')
        plugins.alpha = plugin(manifest('alpha', { api: '0' }), recording('alpha-v2', log))

        const reloaded = yield* registry.load('alpha')

        assert.deepStrictEqual(reloaded.status, {
          _tag: 'Loaded',
          reloadError: `Plugin API version "0" does not match the installed version "${PLUGIN_API_VERSION}"`
        })
        assert.deepStrictEqual(log, ['alpha:open'])
      }).pipe(Effect.scoped)
    )

    it.effect('keeps the running version open when the new entry cannot be imported', () =>
      Effect.gen(function* () {
        const log: Array<string> = []
        const plugins = { alpha: plugin(manifest('alpha'), recording('alpha', log)) }
        const registry = yield* makeRegistry(plugins)
        yield* registry.load('alpha')
        plugins.alpha = {
          manifest: manifest('alpha'),
          resolveSetup: Effect.fail(new PluginLoadError({ message: 'Cannot import "host.ts"' }))
        }

        const reloaded = yield* registry.load('alpha')

        assert.deepStrictEqual(reloaded.status, {
          _tag: 'Loaded',
          reloadError: 'Cannot import "host.ts"'
        })
        assert.deepStrictEqual(log, ['alpha:open'])
      }).pipe(Effect.scoped)
    )

    it.effect(
      'reopens the previous setup when the new setup fails after the old scope closed',
      () =>
        Effect.gen(function* () {
          const log: Array<string> = []
          const plugins = { alpha: plugin(manifest('alpha'), recording('alpha', log)) }
          const registry = yield* makeRegistry(plugins)
          yield* registry.load('alpha')
          plugins.alpha = plugin(
            manifest('alpha'),
            recording('alpha-v2', log, () => Effect.fail('boom'))
          )

          const reloaded = yield* registry.load('alpha')

          assert.deepStrictEqual(reloaded.status, { _tag: 'Loaded', reloadError: 'boom' })
          assert.deepStrictEqual(log, [
            'alpha:open',
            'alpha:close',
            'alpha-v2:open',
            'alpha-v2:close',
            'alpha:open'
          ])
        }).pipe(Effect.scoped)
    )

    it.effect('clears the reload error once a later reload succeeds', () =>
      Effect.gen(function* () {
        const log: Array<string> = []
        const plugins = { alpha: plugin(manifest('alpha'), recording('alpha', log)) }
        const registry = yield* makeRegistry(plugins)
        yield* registry.load('alpha')
        plugins.alpha = plugin(manifest('alpha', { api: '0' }))
        yield* registry.load('alpha')
        plugins.alpha = plugin(manifest('alpha'), recording('alpha-v3', log))

        const reloaded = yield* registry.load('alpha')

        assert.deepStrictEqual(reloaded.status, { _tag: 'Loaded' })
      }).pipe(Effect.scoped)
    )

    it.effect('reports Failed when the first version of a plugin fails to open', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry({
          alpha: plugin(
            manifest('alpha'),
            recording('alpha', [], () => Effect.fail('boom'))
          )
        })

        const result = yield* registry.load('alpha')

        assert.deepStrictEqual(result.status, { _tag: 'Failed', message: 'boom' })
      }).pipe(Effect.scoped)
    )

    it.effect('reopens dependants after the previous provider setup comes back', () =>
      Effect.gen(function* () {
        const log: Array<string> = []
        const plugins = {
          provider: plugin(
            manifest('provider'),
            recording('provider', log, (ctx) => ctx.provide('db', 1))
          ),
          consumer: plugin(manifest('consumer', { inject: ['db'] }), recording('consumer', log))
        }
        const registry = yield* makeRegistry(plugins)
        yield* registry.load('provider')
        yield* registry.load('consumer')
        plugins.provider = plugin(
          manifest('provider'),
          recording('provider-v2', log, () => Effect.fail('boom'))
        )

        yield* registry.load('provider')

        assert.strictEqual(yield* statusOf(registry, 'provider'), 'Loaded')
        assert.strictEqual(yield* statusOf(registry, 'consumer'), 'Loaded')
        assert.deepStrictEqual(log.slice(-3), [
          'provider-v2:close',
          'provider:open',
          'consumer:open'
        ])
      }).pipe(Effect.scoped)
    )

    it.effect('tells the loader the load failed so it restores its own state', () =>
      Effect.gen(function* () {
        const outcomes: Array<string> = []
        const plugins = { alpha: plugin(manifest('alpha'), recording('alpha', [])) }
        const loader: PluginLoader<PluginServices> = {
          peek: peekNotUsed,
          load: (root, use) =>
            use(plugins.alpha).pipe(
              Effect.tapCause(() => Effect.sync(() => void outcomes.push(`${root}:rolled-back`))),
              Effect.tap(() => Effect.sync(() => void outcomes.push(`${root}:committed`)))
            )
        }
        const registry = yield* makeRegistry(plugins, { loader })

        yield* registry.load('alpha')
        plugins.alpha = plugin(manifest('alpha', { api: '0' }))
        yield* registry.load('alpha')

        assert.deepStrictEqual(outcomes, ['alpha:committed', 'alpha:rolled-back'])
      }).pipe(Effect.scoped)
    )
  })

  describe('restart required', () => {
    it.effect('reports a changed dependency and keeps the running version open', () =>
      Effect.gen(function* () {
        const log: Array<string> = []
        const plugins = { alpha: plugin(manifest('alpha'), recording('alpha', log)) }
        let changedDependency = false
        const loader: PluginLoader<PluginServices> = {
          peek: peekNotUsed,
          load: (_root, use) =>
            changedDependency
              ? Effect.fail(
                  new PluginRestartRequiredError({
                    reason: 'dependency',
                    message: 'shared.ts changed'
                  })
                )
              : use(plugins.alpha)
        }
        const registry = yield* makeRegistry(plugins, { loader })
        yield* registry.load('alpha')
        changedDependency = true

        const reloaded = yield* registry.load('alpha')

        assert.deepStrictEqual(reloaded.status, {
          _tag: 'RestartRequired',
          reason: 'dependency',
          message: 'shared.ts changed'
        })
        assert.deepStrictEqual(log, ['alpha:open'])
      }).pipe(Effect.scoped)
    )

    it.effect('refuses a load at the memory limit without calling the loader', () =>
      Effect.gen(function* () {
        let loaderCalls = 0
        const plugins = { alpha: plugin(manifest('alpha'), recording('alpha', [])) }
        const loader: PluginLoader<PluginServices> = {
          peek: peekNotUsed,
          load: (_root, use) => {
            loaderCalls += 1
            return use(plugins.alpha)
          }
        }
        const registry = yield* makeRegistry(plugins, {
          loader,
          memory: memoryGuard(100, { alpha: 100 })
        })

        const result = yield* registry.load('alpha')

        assert.strictEqual(result.status._tag, 'RestartRequired')
        assert.strictEqual(
          result.status._tag === 'RestartRequired' ? result.status.reason : undefined,
          'memory'
        )
        assert.strictEqual(loaderCalls, 0)
      }).pipe(Effect.scoped)
    )

    it.effect('still loads a plugin one byte under the memory limit', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry(
          { alpha: plugin(manifest('alpha'), recording('alpha', [])) },
          { memory: memoryGuard(100, { alpha: 99 }) }
        )

        const result = yield* registry.load('alpha')

        assert.strictEqual(result.status._tag, 'Loaded')
      }).pipe(Effect.scoped)
    )

    it.effect('unloads a plugin that is at the memory limit', () =>
      Effect.gen(function* () {
        const log: Array<string> = []
        const totals: Record<string, number> = { alpha: 0 }
        const registry = yield* makeRegistry(
          { alpha: plugin(manifest('alpha'), recording('alpha', log)) },
          { memory: memoryGuard(100, totals) }
        )
        yield* registry.load('alpha')
        totals.alpha = 100
        yield* registry.load('alpha')

        const unloaded = yield* registry.unload('alpha')

        assert.strictEqual(unloaded.status._tag, 'Unloaded')
        assert.deepStrictEqual(log, ['alpha:open', 'alpha:close'])
      }).pipe(Effect.scoped)
    )

    it.effect('tracks the memory of each load and unload under the plugin name', () =>
      Effect.gen(function* () {
        const tracked: Array<string> = []
        const registry = yield* makeRegistry(
          { alpha: plugin(manifest('alpha')), beta: plugin(manifest('beta')) },
          { memory: memoryGuard(100, {}, tracked) }
        )

        yield* registry.load('alpha')
        yield* registry.load('beta')
        yield* registry.unload('alpha')

        assert.deepStrictEqual(tracked, ['alpha', 'beta', 'alpha'])
      }).pipe(Effect.scoped)
    )

    it.effect('reports each plugin memory total in its info', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry(
          { alpha: plugin(manifest('alpha')), beta: plugin(manifest('beta')) },
          { memory: memoryGuard(100, { alpha: 40, beta: 7 }) }
        )
        yield* registry.load('alpha')
        yield* registry.load('beta')

        const infos = yield* registry.list()

        assert.deepStrictEqual(
          infos.map((info) => [info.name, info.memoryBytes]),
          [
            ['alpha', 40],
            ['beta', 7]
          ]
        )
      }).pipe(Effect.scoped)
    )
  })

  describe('startup', () => {
    it.effect('resolves once the eager plugins settle while a lazy plugin is still loading', () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const changes = yield* recordChanges('slow:Loaded')
        const registry = yield* makeRegistry(
          {
            core: plugin(manifest('core', { load: 'eager' }), recording('core', [])),
            slow: plugin(manifest('slow'), () => Deferred.await(gate))
          },
          { onChange: changes.onChange }
        )

        yield* registry.start()

        assert.strictEqual(yield* statusOf(registry, 'core'), 'Loaded')
        assert.strictEqual(yield* statusOf(registry, 'slow'), 'Loading')
        yield* Deferred.succeed(gate, undefined)
        yield* Deferred.await(changes.reached)
        assert.strictEqual(yield* statusOf(registry, 'slow'), 'Loaded')
      }).pipe(Effect.scoped)
    )

    it.effect('reports every plugin as Loading first, then each as it settles, eager first', () =>
      Effect.gen(function* () {
        const changes = yield* recordChanges('alpha:Loaded')
        const registry = yield* makeRegistry(
          {
            alpha: plugin(manifest('alpha'), recording('alpha', [])),
            core: plugin(manifest('core', { load: 'eager' }), recording('core', []))
          },
          { onChange: changes.onChange }
        )

        yield* registry.start()
        yield* Deferred.await(changes.reached)

        assert.deepStrictEqual(changes.seen, [
          'alpha:Loading',
          'core:Loading',
          'core:Loaded',
          'alpha:Loaded'
        ])
      }).pipe(Effect.scoped)
    )

    it.effect('does not stop the other eager plugins when one eager plugin fails', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry({
          'a-core': plugin(
            manifest('a-core', { load: 'eager' }),
            recording('a-core', [], () => Effect.fail('boom'))
          ),
          'b-core': plugin(manifest('b-core', { load: 'eager' }), recording('b-core', []))
        })

        yield* registry.start()

        assert.strictEqual(yield* statusOf(registry, 'a-core'), 'Failed')
        assert.strictEqual(yield* statusOf(registry, 'b-core'), 'Loaded')
      }).pipe(Effect.scoped)
    )

    it.effect(
      'loads a plugin lazily when its manifest cannot be read, and reports the failure',
      () =>
        Effect.gen(function* () {
          const changes = yield* recordChanges('broken:Failed')
          const registry = yield* makeRegistry(
            { broken: plugin(manifest('broken')) },
            {
              onChange: changes.onChange,
              loader: {
                peek: () => Effect.fail(new PluginLoadError({ message: 'unreadable plugin.json' })),
                load: () => Effect.fail(new PluginLoadError({ message: 'unreadable plugin.json' }))
              }
            }
          )

          yield* registry.start()
          yield* Deferred.await(changes.reached)

          assert.strictEqual(yield* statusOf(registry, 'broken'), 'Failed')
        }).pipe(Effect.scoped)
    )

    it.effect('skips a queued plugin that was unloaded before its turn', () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const log: Array<string> = []
        const changes = yield* recordChanges('c-last:Loaded')
        const registry = yield* makeRegistry(
          {
            'a-slow': plugin(manifest('a-slow'), () => Deferred.await(gate)),
            'b-late': plugin(manifest('b-late'), recording('b-late', log)),
            'c-last': plugin(manifest('c-last'))
          },
          { onChange: changes.onChange }
        )
        yield* registry.start()
        const unloading = yield* Effect.forkChild(registry.unload('b-late'))
        yield* Effect.yieldNow

        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(unloading)
        yield* Deferred.await(changes.reached)

        assert.strictEqual(yield* statusOf(registry, 'b-late'), 'Unloaded')
        assert.deepStrictEqual(log, [])
      }).pipe(Effect.scoped)
    )

    it.effect(
      'reports Loading then Loaded for a plugin loaded on request, and nothing for a reload',
      () =>
        Effect.gen(function* () {
          const changes = yield* recordChanges('alpha:Loaded')
          const registry = yield* makeRegistry(
            { alpha: plugin(manifest('alpha'), recording('alpha', [])) },
            { onChange: changes.onChange }
          )

          yield* registry.load('alpha')
          const afterFirstLoad = [...changes.seen]
          yield* registry.load('alpha')

          assert.deepStrictEqual(afterFirstLoad, ['alpha:Loading', 'alpha:Loaded'])
          assert.deepStrictEqual(changes.seen, afterFirstLoad)
        }).pipe(Effect.scoped)
    )
  })

  it.effect('reports the root a plugin loaded from', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({ alpha: plugin(manifest('alpha')) })

      const loaded = yield* registry.load('alpha')

      assert.strictEqual(loaded.root, 'alpha')
    }).pipe(Effect.scoped)
  )

  const providesBackend =
    (name: string, log: Array<string>): PluginSetup<PluginServices> =>
    (ctx) =>
      recording(name, log, () => ctx.provide(BACKEND_KEY, name))(ctx)

  it.effect('keeps a loaded adapter open when it is asked to unload', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const registry = yield* makeRegistry({
        agent: plugin(adapterManifest('agent'), providesBackend('agent', log)),
        alpha: plugin(manifest('alpha'), recording('alpha', log))
      })
      yield* registry.load('agent')
      yield* registry.load('alpha')

      const refused = yield* registry.unload('agent')
      const allowed = yield* registry.unload('alpha')

      assert.deepStrictEqual(refused.status, { _tag: 'Loaded' })
      assert.deepStrictEqual(allowed.status, { _tag: 'Unloaded' })
      assert.deepStrictEqual(log, ['agent:open', 'alpha:open', 'alpha:close'])
      assert.deepStrictEqual(yield* registry.inject(BACKEND_KEY), Option.some('agent'))
    }).pipe(Effect.scoped)
  )

  it.effect('refuses to unload an adapter that has not loaded yet', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        agent: plugin(adapterManifest('agent'), providesBackend('agent', []))
      })

      const refused = yield* registry.unload('agent')

      assert.strictEqual(refused.category, 'adapter')
      assert.deepStrictEqual(refused.status, { _tag: 'Unloaded' })
    }).pipe(Effect.scoped)
  )

  it.effect('does not run the setup of a running adapter again when it is loaded again', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const registry = yield* makeRegistry({
        agent: plugin(adapterManifest('agent'), providesBackend('agent', log))
      })
      yield* registry.load('agent')

      const reloaded = yield* registry.load('agent')

      assert.deepStrictEqual(reloaded.status, { _tag: 'Loaded' })
      assert.deepStrictEqual(log, ['agent:open'])
    }).pipe(Effect.scoped)
  )

  it.effect('loads an adapter whose previous load failed', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const plugins = {
        agent: plugin(adapterManifest('agent'), () => Effect.fail('boom'))
      }
      const registry = yield* makeRegistry(plugins)
      const failed = yield* registry.load('agent')
      plugins.agent = plugin(adapterManifest('agent'), providesBackend('agent', log))

      const retried = yield* registry.load('agent')

      assert.strictEqual(failed.status._tag, 'Failed')
      assert.strictEqual(failed.category, 'adapter')
      assert.deepStrictEqual(retried.status, { _tag: 'Loaded' })
      assert.deepStrictEqual(log, ['agent:open'])
    }).pipe(Effect.scoped)
  )

  it.effect('fails an adapter whose setup does not meet the adapter contract and closes it', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const registry = yield* makeRegistry({
        agent: plugin(
          adapterManifest('agent'),
          recording('agent', log, (ctx) => ctx.provide('other', 1))
        )
      })

      const result = yield* registry.load('agent')

      assert.deepStrictEqual(result.status, {
        _tag: 'Failed',
        message: `Plugin "agent" does not meet the adapter contract:\n- setup did not provide "${BACKEND_KEY}"`
      })
      assert.deepStrictEqual(log, ['agent:open', 'agent:close'])
      assert.deepStrictEqual(yield* registry.inject('other'), Option.none())
    }).pipe(Effect.scoped)
  )

  it.effect('fails a feature plugin that provides a key reserved for adapters', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const registry = yield* makeRegistry({
        impostor: plugin(
          manifest('impostor'),
          recording('impostor', log, (ctx) =>
            Effect.gen(function* () {
              yield* ctx.provide('other', 1)
              yield* ctx.provide(BACKEND_KEY, 'fake')
            })
          )
        )
      })

      const result = yield* registry.load('impostor')

      assert.deepStrictEqual(result.status, {
        _tag: 'Failed',
        message: `"${BACKEND_KEY}" can be provided only by an adapter plugin`
      })
      assert.deepStrictEqual(log, ['impostor:open', 'impostor:close'])
      assert.deepStrictEqual(yield* registry.inject(BACKEND_KEY), Option.none())
      assert.deepStrictEqual(yield* registry.inject('other'), Option.none())
    }).pipe(Effect.scoped)
  )

  it.effect('does not apply the adapter contract to a feature plugin', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        alpha: plugin(manifest('alpha'), recording('alpha', []))
      })

      const result = yield* registry.load('alpha')

      assert.deepStrictEqual(result.status, { _tag: 'Loaded' })
    }).pipe(Effect.scoped)
  )

  it.effect('lists the keys a running plugin provides, sorted, and none after it unloads', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        alpha: plugin(manifest('alpha'), (ctx) =>
          Effect.gen(function* () {
            yield* ctx.provide('zeta', 1)
            yield* ctx.provide('beta', 2)
          })
        )
      })
      const providesOfAlpha = registry
        .list()
        .pipe(Effect.map((infos) => infos.find((info) => info.name === 'alpha')?.provides))

      yield* registry.load('alpha')
      const whileLoaded = yield* providesOfAlpha
      const unloaded = yield* registry.unload('alpha')

      assert.deepStrictEqual(whileLoaded, ['beta', 'zeta'])
      assert.deepStrictEqual(unloaded.provides, [])
      assert.deepStrictEqual(yield* providesOfAlpha, [])
    }).pipe(Effect.scoped)
  )

  it.effect('lists the category of a plugin that has not loaded', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        agent: plugin(adapterManifest('agent')),
        alpha: plugin(manifest('alpha'))
      })

      const infos = yield* registry.list()

      assert.deepStrictEqual(
        infos.map((info) => [info.name, info.category]),
        [
          ['agent', 'adapter'],
          ['alpha', 'feature']
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('loads an adapter before start resolves', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        agent: plugin(adapterManifest('agent'), providesBackend('agent', []))
      })

      yield* registry.start()

      assert.strictEqual(yield* statusOf(registry, 'agent'), 'Loaded')
    }).pipe(Effect.scoped)
  )
})
