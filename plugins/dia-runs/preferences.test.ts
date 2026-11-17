import { ModelPreferences } from '@dia/plugin'
import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Option, Schema, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { makeFeeds, PREFERENCES_KEY } from './feeds'
import { handOverSettings } from './handover'
import { runsMigrations } from './migrations'
import { makeRunRows, type RunRows } from './run-rows'

const unloaded = () => Effect.succeed({ _tag: 'Loading' as const })

const withRows = <A, E>(
  body: (rows: RunRows, dir: string) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-runs-preferences-' })
    const sql = yield* openDatabase(`${dir}/data.db`, runsMigrations)
    const rows = yield* makeRunRows.pipe(Effect.provideService(SqlClient.SqlClient, sql))
    return yield* body(rows, dir)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const rawStored = (rows: RunRows) => rows.getSetting(PREFERENCES_KEY, Schema.Unknown)

const LEGACY_SETTINGS = {
  usageLimitResume: 'automatic',
  adapters: {
    'dia-claude-code': {
      models: { opus: 'favourite', haiku: 'hidden' },
      defaults: { model: 'opus', thinkingLevel: 'high' }
    }
  }
}

const MIGRATED: ModelPreferences.ModelPreferences = {
  adapters: { 'dia-claude-code': { models: { opus: 'favourite', haiku: 'hidden' } } },
  defaults: { selection: { backend: 'dia-claude-code', model: 'opus' }, thinkingLevel: 'high' }
}

describe('model preferences in dia-runs', () => {
  it.effect('reads preferences stored in the legacy shape as the new shape', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        yield* rows.setSetting(PREFERENCES_KEY, ModelPreferences.LegacyModelPreferences, MIGRATED)

        const feeds = yield* makeFeeds({ models: unloaded, rows })

        assert.deepStrictEqual((yield* feeds.preferences.current).preferences, MIGRATED)
      })
    )
  )

  it.effect('stores defaults with a selection and reads them back after a restart', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const feeds = yield* makeFeeds({ models: unloaded, rows })
        const defaults = {
          selection: { backend: 'other-adapter', model: 'alpha' },
          permissionMode: 'default' as const
        }

        yield* feeds.preferences.setDefaults(defaults)
        const restarted = yield* makeFeeds({ models: unloaded, rows })

        assert.deepStrictEqual(
          (yield* restarted.preferences.current).preferences.defaults,
          defaults
        )
        assert.deepStrictEqual(Option.getOrThrow(yield* rawStored(rows)), {
          adapters: {},
          defaults
        })
      })
    )
  )

  it.effect('writes a model preference into the preferences of the adapter it names', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const feeds = yield* makeFeeds({ models: unloaded, rows })

        yield* feeds.preferences.set('other-adapter', 'alpha', Option.some('favourite'))

        assert.deepStrictEqual((yield* feeds.preferences.current).preferences.adapters, {
          'other-adapter': { models: { alpha: 'favourite' } }
        })
      })
    )
  )

  it.effect('refuses to hide a model of an adapter whose list has not loaded', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const feeds = yield* makeFeeds({ models: unloaded, rows })

        const refused = yield* Effect.flip(
          feeds.preferences.set('other-adapter', 'alpha', Option.some('hidden'))
        )

        assert.strictEqual(refused._tag, 'LastVisibleModel')
      })
    )
  )

  it.effect('converts the legacy preferences of settings.json when handing over settings', () =>
    withRows((rows, dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${dir}/settings.json`, JSON.stringify(LEGACY_SETTINGS))

        yield* handOverSettings(rows, `${dir}/settings.json`)
        const feeds = yield* makeFeeds({ models: unloaded, rows })

        assert.deepStrictEqual((yield* feeds.preferences.current).preferences, MIGRATED)
        assert.deepStrictEqual(Option.getOrThrow(yield* rawStored(rows)), MIGRATED)
      })
    )
  )
})
