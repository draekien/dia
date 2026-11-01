import { assert, describe, it } from '@effect/vitest'
import { META_REPO_KEY } from '@shared/plugin/api'
import { Effect, Option } from 'effect'
import { type MetaRepo, resolveSessionAdditions, withMetaRepo } from './meta-repo-seam'

const registryProviding = (value: Option.Option<unknown>) => ({
  inject: (key: string) => Effect.succeed(key === META_REPO_KEY ? value : Option.none())
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

describe('resolveSessionAdditions', () => {
  it.effect('returns what the meta repo adds to a session starting now', () =>
    Effect.gen(function* () {
      let reads = 0
      const repo = metaRepo({
        forNewSession: Effect.sync(() => {
          reads += 1
          return { systemPromptAppend: `read ${reads}`, pluginPaths: ['/meta/plugin'] }
        })
      })
      const registry = registryProviding(Option.some(repo))

      yield* resolveSessionAdditions(registry)
      const second = yield* resolveSessionAdditions(registry)

      assert.deepStrictEqual(second, {
        systemPromptAppend: 'read 2',
        pluginPaths: ['/meta/plugin']
      })
    })
  )

  it.effect('adds nothing when the meta plugin is not loaded', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* resolveSessionAdditions(registryProviding(Option.none())),
        nothingAdded
      )
    })
  )

  it.effect('adds nothing when the forNewSession effect dies', () =>
    Effect.gen(function* () {
      const repo = metaRepo({ forNewSession: Effect.die(new Error('boom')) })
      assert.deepStrictEqual(
        yield* resolveSessionAdditions(registryProviding(Option.some(repo))),
        nothingAdded
      )
    })
  )

  it.effect('adds to a session from an older meta plugin that has no push members', () =>
    Effect.gen(function* () {
      const older = {
        forNewSession: Effect.succeed({ systemPromptAppend: 'older', pluginPaths: [] })
      }

      assert.deepStrictEqual(
        yield* resolveSessionAdditions(registryProviding(Option.some(older))),
        {
          systemPromptAppend: 'older',
          pluginPaths: []
        }
      )
    })
  )

  it.effect('adds nothing when the provided value has no forNewSession effect', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* resolveSessionAdditions(registryProviding(Option.some({ forNewSession: 'x' }))),
        nothingAdded
      )
    })
  )
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
