import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Logger, Option } from 'effect'
import { makeSettingsStoreLive, SettingsStore } from './settings-store'

function makeTestSetup(initialContent: string | undefined): {
  readonly writes: Array<string>
  readonly capturedLogs: ReadonlyArray<unknown>
  readonly testLayer: Layer.Layer<SettingsStore>
  readonly loggerLayer: Layer.Layer<never>
} {
  let stored = initialContent
  const writes: string[] = []

  const fakeFs = FileSystem.makeNoop({
    exists: () => Effect.succeed(stored !== undefined),
    readFileString: () => Effect.succeed(stored ?? '{}'),
    writeFileString: (_path, data) =>
      Effect.sync(() => {
        stored = data
        writes.push(data)
      })
  })

  const capturedLogs: unknown[] = []
  const captureLogger = Logger.make(({ message }) => {
    capturedLogs.push(...(Array.isArray(message) ? message : [message]))
  })

  const fsLayer = Layer.succeed(FileSystem.FileSystem)(fakeFs)
  const testLayer = Layer.provide(makeSettingsStoreLive('/userData'), fsLayer)
  const loggerLayer = Logger.layer([captureLogger], { mergeWithExisting: true })

  return { writes, capturedLogs, testLayer, loggerLayer }
}

describe('SettingsStore', () => {
  it.effect('getLastDirectory returns None when no settings file exists', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(undefined)

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getLastDirectory()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.isTrue(Option.isNone(result))
    })
  )

  it.effect('getLastDirectory returns the stored path when the file is valid', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(JSON.stringify({ lastDirectory: '/repo' }))

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getLastDirectory()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(result, Option.some('/repo'))
    })
  )

  it.effect('getLastDirectory returns None and warns when the file is not valid JSON', () =>
    Effect.gen(function* () {
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup('not json')

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getLastDirectory()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.isTrue(Option.isNone(result))
      assert.isTrue(
        capturedLogs.some((log) => String(log).includes('Ignoring unparseable settings file'))
      )
    })
  )

  it.effect('getLastDirectory returns None and warns when JSON does not match the schema', () =>
    Effect.gen(function* () {
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup(
        JSON.stringify({ lastDirectory: 42 })
      )

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getLastDirectory()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.isTrue(Option.isNone(result))
      assert.isTrue(
        capturedLogs.some((log) => String(log).includes('Ignoring malformed settings file'))
      )
    })
  )

  it.effect('setLastDirectory persists the path, then getLastDirectory reflects it', () =>
    Effect.gen(function* () {
      const { writes, testLayer, loggerLayer } = makeTestSetup(undefined)

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.setLastDirectory('/repo-a')
        return yield* store.getLastDirectory()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(result, Option.some('/repo-a'))
      assert.deepStrictEqual(JSON.parse(writes[0]), { lastDirectory: '/repo-a' })
    })
  )

  it.effect('getTheme returns None when no settings file exists', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(undefined)

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getTheme()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.isTrue(Option.isNone(result))
    })
  )

  it.effect('getTheme returns the stored theme when the file is valid', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(JSON.stringify({ theme: 'light' }))

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getTheme()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(result, Option.some('light'))
    })
  )

  it.effect('getTheme returns None and warns when the theme is not a known value', () =>
    Effect.gen(function* () {
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup(
        JSON.stringify({ theme: 'sepia' })
      )

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getTheme()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.isTrue(Option.isNone(result))
      assert.isTrue(
        capturedLogs.some((log) => String(log).includes('Ignoring malformed settings file'))
      )
    })
  )

  it.effect('setTheme persists the choice, then getTheme reflects it', () =>
    Effect.gen(function* () {
      const { writes, testLayer, loggerLayer } = makeTestSetup(undefined)

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.setTheme('dark')
        return yield* store.getTheme()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(result, Option.some('dark'))
      assert.deepStrictEqual(JSON.parse(writes[0]), { theme: 'dark' })
    })
  )

  it.effect('setTheme preserves an already-stored lastDirectory', () =>
    Effect.gen(function* () {
      const { writes, testLayer, loggerLayer } = makeTestSetup(
        JSON.stringify({ lastDirectory: '/repo' })
      )

      yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.setTheme('system')
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(JSON.parse(writes[0]), { lastDirectory: '/repo', theme: 'system' })
    })
  )

  it.effect('getTranscriptWidth returns None when no width was stored', () =>
    Effect.gen(function* () {
      const { testLayer, loggerLayer } = makeTestSetup(JSON.stringify({ theme: 'dark' }))

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getTranscriptWidth()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.isTrue(Option.isNone(result))
    })
  )

  it.effect('setTranscriptWidth persists the width beside other settings', () =>
    Effect.gen(function* () {
      const { writes, testLayer, loggerLayer } = makeTestSetup(JSON.stringify({ theme: 'dark' }))

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.setTranscriptWidth('narrow')
        return yield* store.getTranscriptWidth()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(result, Option.some('narrow'))
      assert.deepStrictEqual(JSON.parse(writes[0]), { theme: 'dark', transcriptWidth: 'narrow' })
    })
  )
})

describe('SettingsStore plugin overrides', () => {
  const run = <A>(
    initial: string | undefined,
    use: (store: SettingsStore['Service']) => Effect.Effect<A>
  ) => {
    const { testLayer, loggerLayer } = makeTestSetup(initial)
    return Effect.gen(function* () {
      return yield* use(yield* SettingsStore)
    }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))
  }

  it.effect('returns no overrides when none were stored', () =>
    Effect.gen(function* () {
      const overrides = yield* run(undefined, (store) => store.getPluginOverrides())

      assert.deepStrictEqual(overrides, {})
    })
  )

  it.effect('replaces the stored path when an override is set again for the same plugin', () =>
    Effect.gen(function* () {
      const overrides = yield* run(JSON.stringify({ pluginOverrides: { chat: '/old' } }), (store) =>
        Effect.gen(function* () {
          yield* store.setPluginOverride('chat', '/new')
          yield* store.setPluginOverride('theme', '/other')
          return yield* store.getPluginOverrides()
        })
      )

      assert.deepStrictEqual(overrides, { chat: '/new', theme: '/other' })
    })
  )

  it.effect('removes one plugin override and keeps the others and the other settings', () =>
    Effect.gen(function* () {
      const stored = JSON.stringify({
        lastDirectory: '/repo',
        pluginOverrides: { chat: '/a', theme: '/b' }
      })

      const result = yield* run(stored, (store) =>
        Effect.gen(function* () {
          yield* store.clearPluginOverride('chat')
          return [yield* store.getPluginOverrides(), yield* store.getLastDirectory()] as const
        })
      )

      assert.deepStrictEqual(result, [{ theme: '/b' }, Option.some('/repo')])
    })
  )
})
