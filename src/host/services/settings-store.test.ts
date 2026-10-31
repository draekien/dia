import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Logger, Option, PlatformError } from 'effect'
import { makeSettingsStoreLive, SettingsStore } from './settings-store'

function makeTestSetup(
  initialContent: string | undefined,
  options: { readonly failRename?: boolean } = {}
): {
  readonly writes: Array<string>
  readonly stored: () => string | undefined
  readonly capturedLogs: ReadonlyArray<unknown>
  readonly testLayer: Layer.Layer<SettingsStore>
  readonly loggerLayer: Layer.Layer<never>
} {
  let stored = initialContent
  const pending = new Map<string, string>()
  const writes: string[] = []

  const fakeFs = FileSystem.makeNoop({
    exists: () => Effect.succeed(stored !== undefined),
    readFileString: () => Effect.sync(() => stored ?? '{}').pipe(Effect.tap(() => Effect.yieldNow)),
    writeFileString: (path, data) => Effect.sync(() => pending.set(path, data)),
    rename: (from, to) =>
      options.failRename
        ? Effect.fail(
            PlatformError.systemError({
              _tag: 'PermissionDenied',
              module: 'FileSystem',
              method: 'rename',
              pathOrDescriptor: to
            })
          )
        : Effect.sync(() => {
            const data = pending.get(from)
            if (data === undefined || to !== '/userData/settings.json') return
            pending.delete(from)
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

  return { writes, stored: () => stored, capturedLogs, testLayer, loggerLayer }
}

describe('SettingsStore', () => {
  it.effect('keeps the previous settings file when the write cannot be moved into place', () =>
    Effect.gen(function* () {
      const previous = JSON.stringify({ theme: 'light' })
      const { stored, capturedLogs, testLayer, loggerLayer } = makeTestSetup(previous, {
        failRename: true
      })

      yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.setTheme('dark')
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.strictEqual(stored(), previous)
      assert.isTrue(capturedLogs.some((log) => String(log).includes('Failed to persist settings')))
    })
  )

  it.effect('concurrent setters each keep their change', () =>
    Effect.gen(function* () {
      const { stored, testLayer, loggerLayer } = makeTestSetup('{}')

      yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* Effect.all([store.setTheme('dark'), store.setTranscriptWidth('wide')], {
          concurrency: 'unbounded'
        })
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(JSON.parse(stored() ?? '{}'), {
        theme: 'dark',
        transcriptWidth: 'wide'
      })
    })
  )

  it.effect('getTheme returns None and warns when the file is not valid JSON', () =>
    Effect.gen(function* () {
      const { capturedLogs, testLayer, loggerLayer } = makeTestSetup('not json')

      const result = yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        return yield* store.getTheme()
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.isTrue(Option.isNone(result))
      assert.isTrue(
        capturedLogs.some((log) => String(log).includes('Ignoring unparseable settings file'))
      )
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

  it.effect('setTheme preserves an already-stored transcript width', () =>
    Effect.gen(function* () {
      const { writes, testLayer, loggerLayer } = makeTestSetup(
        JSON.stringify({ transcriptWidth: 'wide' })
      )

      yield* Effect.gen(function* () {
        const store = yield* SettingsStore
        yield* store.setTheme('system')
      }).pipe(Effect.provide(testLayer), Effect.provide(loggerLayer))

      assert.deepStrictEqual(JSON.parse(writes[0]), { transcriptWidth: 'wide', theme: 'system' })
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
        theme: 'dark',
        pluginOverrides: { chat: '/a', theme: '/b' }
      })

      const result = yield* run(stored, (store) =>
        Effect.gen(function* () {
          yield* store.clearPluginOverride('chat')
          return [yield* store.getPluginOverrides(), yield* store.getTheme()] as const
        })
      )

      assert.deepStrictEqual(result, [{ theme: '/b' }, Option.some('dark' as const)])
    })
  )
})
