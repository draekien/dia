import { assert, describe, it } from '@effect/vitest'
import { ServiceWithdrawnError } from '@shared/plugin/plugin-registry'
import { fakeUse } from '@shared/plugin/plugin-registry.fake'
import { Effect, Option } from 'effect'
import { type MetaRepo, MetaRepoKey, withMetaRepo } from './meta-repo-seam'

const registryProviding = (value: Option.Option<unknown>) => ({
  use: fakeUse((key) => (key === MetaRepoKey.name ? value : Option.none()))
})

const nothingAdded = { systemPromptAppend: '', pluginPaths: [] }

const unusedState = Effect.die(new Error('not used in this test'))

const metaRepo = (overrides: Partial<MetaRepo>): MetaRepo => ({
  forNewSession: Effect.succeed(nothingAdded),
  state: unusedState,
  setRemote: () => unusedState,
  push: unusedState,
  ...overrides
})

describe('withMetaRepo', () => {
  it.effect('runs the call against the loaded meta repo', () =>
    Effect.gen(function* () {
      const state = {
        _tag: 'MetaRepoState' as const,
        remoteUrl: 'git@host:meta.git',
        branch: 'main'
      }
      const repo = metaRepo({ state: Effect.succeed(state) })

      const result = yield* withMetaRepo(registryProviding(Option.some(repo)), (r) => r.state)

      assert.deepStrictEqual(result, state)
    })
  )

  it.effect('reports that the meta plugin is not loaded', () =>
    Effect.gen(function* () {
      const result = yield* withMetaRepo(registryProviding(Option.none()), (r) => r.push)

      assert.deepStrictEqual(result, {
        _tag: 'MetaRepoFailed',
        message: 'The meta plugin is not loaded.'
      })
    })
  )

  it.effect(
    'reports the plugin as not loaded when it provides an older MetaRepo without push',
    () =>
      Effect.gen(function* () {
        const older = { forNewSession: Effect.succeed(nothingAdded) }

        const result = yield* withMetaRepo(registryProviding(Option.some(older)), (r) => r.push)

        assert.strictEqual(result._tag, 'MetaRepoFailed')
      })
  )

  it.effect('reports a call that the meta plugin unload cut off', () =>
    Effect.gen(function* () {
      const registry = {
        use: () =>
          Effect.fail(
            new ServiceWithdrawnError({ key: MetaRepoKey.name, plugin: 'meta', message: 'closed' })
          )
      }

      const result = yield* withMetaRepo(registry, (r) => r.push)

      assert.deepStrictEqual(result, {
        _tag: 'MetaRepoFailed',
        message: 'The meta plugin was unloaded during the call.'
      })
    })
  )

  it.effect('reports a call that dies as a failure', () =>
    Effect.gen(function* () {
      const repo = metaRepo({ push: Effect.die(new Error('boom')) })

      const result = yield* withMetaRepo(registryProviding(Option.some(repo)), (r) => r.push)

      assert.deepStrictEqual(result, {
        _tag: 'MetaRepoFailed',
        message: 'The meta repo call failed unexpectedly.'
      })
    })
  )
})
