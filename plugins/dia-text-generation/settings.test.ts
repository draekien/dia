import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, FileSystem, Stream } from 'effect'
import type { TextGenerationSettings } from './calls'
import { makeTitleSettings } from './settings'
import { captureLogs } from './text-generation.fake'

const inTempDir = <A, E>(
  body: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | import('effect').Path.Path>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({
      directory: '.',
      prefix: 'dia-text-generation-settings-'
    })
    return yield* body(dir)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const CHOSEN: TextGenerationSettings = { adapter: 'other-adapter', model: 'big', effort: 'max' }

describe('TitleSettings', () => {
  it.effect('reads dia-claude-code, haiku and low when nothing is saved', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const settings = yield* makeTitleSettings(dir)

        assert.deepStrictEqual(yield* settings.current, {
          adapter: 'dia-claude-code',
          model: 'haiku',
          effort: 'low'
        })
      })
    )
  )

  it.effect('logs a missing file at info and not as a warning', () => {
    const { logs, layer } = captureLogs()
    return inTempDir((dir) =>
      Effect.gen(function* () {
        yield* makeTitleSettings(dir)

        assert.isTrue(logs.some((log) => log.level === 'Info'))
        assert.isFalse(logs.some((log) => log.level === 'Warn'))
      })
    ).pipe(Effect.provide(layer))
  })

  it.effect('reads the defaults and logs a warning when the file does not decode', () => {
    const { logs, layer } = captureLogs()
    return inTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${dir}/settings.json`, '{"adapter":"x"}')

        const settings = yield* makeTitleSettings(dir)

        assert.deepStrictEqual(yield* settings.current, {
          adapter: 'dia-claude-code',
          model: 'haiku',
          effort: 'low'
        })
        assert.isTrue(logs.some((log) => log.level === 'Warn'))
      })
    ).pipe(Effect.provide(layer))
  })

  it.effect('reads saved settings in a fresh TitleSettings on the same directory', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const first = yield* makeTitleSettings(dir)
        yield* first.set(CHOSEN)

        const restarted = yield* makeTitleSettings(dir)

        assert.deepStrictEqual(yield* restarted.current, CHOSEN)
      })
    )
  )

  it.effect('follows the current settings, then each change', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const settings = yield* makeTitleSettings(dir)

        const followed = yield* settings.follow.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* Effect.yieldNow
        yield* settings.set(CHOSEN)
        const seen = yield* Fiber.join(followed)

        assert.deepStrictEqual(
          Array.from(seen, (entry) => entry.adapter),
          ['dia-claude-code', 'other-adapter']
        )
      })
    )
  )

  it.effect('logs the saved change at info', () => {
    const { logs, layer } = captureLogs()
    return inTempDir((dir) =>
      Effect.gen(function* () {
        const settings = yield* makeTitleSettings(dir)
        logs.length = 0

        yield* settings.set(CHOSEN)

        assert.isTrue(
          logs.some((log) => log.level === 'Info' && log.text.includes('other-adapter'))
        )
      })
    ).pipe(Effect.provide(layer))
  })

  it.effect('keeps the previous settings and logs an error when the directory is missing', () => {
    const { logs, layer } = captureLogs()
    return inTempDir((dir) =>
      Effect.gen(function* () {
        const settings = yield* makeTitleSettings(`${dir}/missing`)

        yield* settings.set(CHOSEN)

        assert.strictEqual((yield* settings.current).adapter, 'dia-claude-code')
        assert.isTrue(logs.some((log) => log.level === 'Error'))
      })
    ).pipe(Effect.provide(layer))
  })
})
