import { assert, describe, it } from '@effect/vitest'
import { Allow } from '@shared/domain/attention'
import type { PluginServices, PluginSetup } from '@shared/plugin/api'
import { PLUGIN_API_VERSION } from '@shared/plugin/manifest'
import { type LoadedPlugin, makePluginRegistry } from '@shared/plugin/plugin-registry'
import { Deferred, Effect, Option } from 'effect'
import { makePendingUserInput } from '../../../plugins/permissions/pending-user-input'
import {
  PENDING_USER_INPUT_KEY,
  type PendingUserInput,
  resolvePendingUserInput
} from './pending-user-input-resolver'

const registryProviding = (provided: Record<string, unknown>) => ({
  inject: (key: string) => Effect.succeed(Option.fromNullishOr(provided[key]))
})

describe('resolvePendingUserInput', () => {
  it.effect('uses the registry the permissions plugin provides', () =>
    Effect.gen(function* () {
      const stub = { tag: 'pending' } as unknown as PendingUserInput

      const resolved = yield* resolvePendingUserInput(
        registryProviding({ [PENDING_USER_INPUT_KEY]: () => stub })
      )

      assert.deepStrictEqual(resolved, Option.some(stub))
    })
  )

  it.effect('creates a fresh registry on every call so sessions share no state', () =>
    Effect.gen(function* () {
      const registry = registryProviding({ [PENDING_USER_INPUT_KEY]: makePendingUserInput })

      const first = Option.getOrThrow(yield* resolvePendingUserInput(registry))
      const second = Option.getOrThrow(yield* resolvePendingUserInput(registry))

      assert.notStrictEqual(first, second)
    })
  )

  const unavailableCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['no plugin provides the key', {}],
    ['the provided value is not a function', { [PENDING_USER_INPUT_KEY]: 'nope' }],
    [
      'the factory throws',
      {
        [PENDING_USER_INPUT_KEY]: () => {
          throw new Error('boom')
        }
      }
    ]
  ]

  for (const [name, provided] of unavailableCases) {
    it.effect(`is none when ${name}`, () =>
      Effect.gen(function* () {
        const resolved = yield* resolvePendingUserInput(registryProviding(provided))

        assert.isTrue(Option.isNone(resolved))
      })
    )
  }
})

const reloadableRegistry = Effect.gen(function* () {
  const plugin = (setup: PluginSetup<PluginServices>): LoadedPlugin<PluginServices> => ({
    manifest: { name: 'permissions', api: PLUGIN_API_VERSION, host: 'host.ts' },
    resolveSetup: Effect.succeed(Option.some(setup))
  })
  const setup: PluginSetup<PluginServices> = (ctx) =>
    ctx.provide(PENDING_USER_INPUT_KEY, makePendingUserInput)
  return yield* makePluginRegistry<PluginServices>({
    catalog: {
      names: () => Effect.succeed(['permissions']),
      resolve: () =>
        Effect.succeed(Option.some({ root: 'permissions', origin: 'default' as const }))
    },
    loader: {
      peek: () => Effect.succeed(plugin(setup).manifest),
      load: (_root, use) => use(plugin(setup))
    },
    extend: (services) => services
  })
})

describe('a permissions plugin reload while a request is pending', () => {
  it.effect(
    'lets the running session resolve the request and gives the next session new state',
    () =>
      Effect.gen(function* () {
        const registry = yield* reloadableRegistry
        yield* registry.load('permissions')
        const running = Option.getOrThrow(yield* resolvePendingUserInput(registry))
        const deferred = yield* running.register('req-1')

        yield* registry.load('permissions')
        const matched = yield* running.resolve('req-1', Allow.make({}))
        const resolution = yield* Deferred.await(deferred)
        const next = Option.getOrThrow(yield* resolvePendingUserInput(registry))

        assert.isTrue(matched)
        assert.deepStrictEqual(resolution, { _tag: 'Allow' })
        assert.isFalse(yield* next.isPending('req-1'))
      }).pipe(Effect.scoped)
  )
})
