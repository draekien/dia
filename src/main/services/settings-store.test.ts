import { FileSystem } from '@effect/platform'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Logger, Option } from 'effect'
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

  const fsLayer = Layer.succeed(FileSystem.FileSystem, fakeFs)
  const testLayer = Layer.provide(makeSettingsStoreLive('/userData'), fsLayer)
  const loggerLayer = Logger.add(captureLogger)

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
})
