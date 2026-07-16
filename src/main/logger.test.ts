import { FileSystem } from '@effect/platform'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Layer, TestClock } from 'effect'
import { pruneOldLogEntries } from './logger'

const NOW = Date.parse('2026-07-16T00:00:00.000Z')
const RETENTION_DAYS = 7
const RETENTION = Duration.days(RETENTION_DAYS)
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000

function entry(isoTimestamp: string, message: string): string {
  return JSON.stringify({ timestamp: isoTimestamp, message })
}

function makeFsLayer(initialContent: string | undefined): {
  readonly writes: Array<string>
  readonly fsLayer: Layer.Layer<FileSystem.FileSystem>
} {
  let stored = initialContent
  const writes: string[] = []

  const fakeFs = FileSystem.makeNoop({
    exists: () => Effect.succeed(stored !== undefined),
    readFileString: () => Effect.succeed(stored ?? ''),
    writeFileString: (_path, data) =>
      Effect.sync(() => {
        stored = data
        writes.push(data)
      })
  })

  return { writes, fsLayer: Layer.succeed(FileSystem.FileSystem, fakeFs) }
}

describe('pruneOldLogEntries', () => {
  it.effect('does nothing when the log file does not exist', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      const { writes, fsLayer } = makeFsLayer(undefined)

      yield* pruneOldLogEntries('dia.log', RETENTION).pipe(Effect.provide(fsLayer))

      assert.deepStrictEqual(writes, [])
    })
  )

  it.effect('keeps entries within the retention window and drops older ones', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      const withinWindow = entry(new Date(NOW - 1 * MILLIS_PER_DAY).toISOString(), 'recent')
      const outsideWindow = entry(new Date(NOW - 8 * MILLIS_PER_DAY).toISOString(), 'stale')
      const { writes, fsLayer } = makeFsLayer(`${outsideWindow}\n${withinWindow}\n`)

      yield* pruneOldLogEntries('dia.log', RETENTION).pipe(Effect.provide(fsLayer))

      assert.strictEqual(writes[0], `${withinWindow}\n`)
    })
  )

  it.effect('keeps an entry exactly at the retention boundary', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      const atBoundary = entry(
        new Date(NOW - RETENTION_DAYS * MILLIS_PER_DAY).toISOString(),
        'boundary'
      )
      const { writes, fsLayer } = makeFsLayer(`${atBoundary}\n`)

      yield* pruneOldLogEntries('dia.log', RETENTION).pipe(Effect.provide(fsLayer))

      assert.strictEqual(writes[0], `${atBoundary}\n`)
    })
  )

  it.effect('drops an entry one millisecond past the retention boundary', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      const pastBoundary = entry(
        new Date(NOW - RETENTION_DAYS * MILLIS_PER_DAY - 1).toISOString(),
        'past-boundary'
      )
      const { writes, fsLayer } = makeFsLayer(`${pastBoundary}\n`)

      yield* pruneOldLogEntries('dia.log', RETENTION).pipe(Effect.provide(fsLayer))

      assert.strictEqual(writes[0], '')
    })
  )

  it.effect('drops malformed lines it cannot date', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      const valid = entry(new Date(NOW).toISOString(), 'recent')
      const { writes, fsLayer } = makeFsLayer(
        `not json\n${JSON.stringify({ message: 'no timestamp field' })}\n${valid}\n`
      )

      yield* pruneOldLogEntries('dia.log', RETENTION).pipe(Effect.provide(fsLayer))

      assert.strictEqual(writes[0], `${valid}\n`)
    })
  )

  it.effect('writes an empty string when every entry is pruned', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW)
      const outsideWindow = entry(new Date(NOW - 30 * MILLIS_PER_DAY).toISOString(), 'stale')
      const { writes, fsLayer } = makeFsLayer(`${outsideWindow}\n`)

      yield* pruneOldLogEntries('dia.log', RETENTION).pipe(Effect.provide(fsLayer))

      assert.strictEqual(writes[0], '')
    })
  )
})
