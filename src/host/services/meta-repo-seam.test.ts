import { assert, describe, it } from '@effect/vitest'
import { META_REPO_KEY } from '@shared/plugin/api'
import { Effect, Option } from 'effect'
import { type MetaRepo, resolveSessionAdditions } from './meta-repo-seam'

const registryProviding = (value: Option.Option<unknown>) => ({
  inject: (key: string) => Effect.succeed(key === META_REPO_KEY ? value : Option.none())
})

const nothingAdded = { systemPromptAppend: '', pluginPaths: [] }

describe('resolveSessionAdditions', () => {
  it.effect('returns what the meta repo adds to a session starting now', () =>
    Effect.gen(function* () {
      let reads = 0
      const repo: MetaRepo = {
        forNewSession: Effect.sync(() => {
          reads += 1
          return { systemPromptAppend: `read ${reads}`, pluginPaths: ['/meta/plugin'] }
        })
      }
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
      const repo: MetaRepo = { forNewSession: Effect.die(new Error('boom')) }
      assert.deepStrictEqual(
        yield* resolveSessionAdditions(registryProviding(Option.some(repo))),
        nothingAdded
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
