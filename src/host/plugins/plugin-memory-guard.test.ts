import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { heapUsedAfterGc, makePluginMemoryGuard } from './plugin-memory-guard'

const MB = 1024 * 1024

const guardOver = (heap: { current: number }, limit = 100 * MB) =>
  makePluginMemoryGuard({ limit, heapUsed: Effect.sync(() => heap.current) })

const growBy = (heap: { current: number }, bytes: number) =>
  Effect.sync(() => {
    heap.current += bytes
  })

describe('plugin memory guard', () => {
  it.effect('adds the heap growth of a tracked effect to the plugin total', () =>
    Effect.gen(function* () {
      const heap = { current: 10 * MB }
      const guard = guardOver(heap)

      yield* guard.track('chat', growBy(heap, 7 * MB))

      assert.strictEqual(yield* guard.used('chat'), 7 * MB)
    })
  )

  it.effect('accumulates the growth of every tracked effect for the same plugin', () =>
    Effect.gen(function* () {
      const heap = { current: 0 }
      const guard = guardOver(heap)

      yield* guard.track('chat', growBy(heap, 3 * MB))
      yield* guard.track('chat', growBy(heap, 4 * MB))

      assert.strictEqual(yield* guard.used('chat'), 7 * MB)
    })
  )

  it.effect('keeps a separate total for each plugin', () =>
    Effect.gen(function* () {
      const heap = { current: 0 }
      const guard = guardOver(heap)

      yield* guard.track('chat', growBy(heap, 3 * MB))
      yield* guard.track('theme', growBy(heap, 5 * MB))

      assert.strictEqual(yield* guard.used('chat'), 3 * MB)
      assert.strictEqual(yield* guard.used('theme'), 5 * MB)
    })
  )

  it.effect('reports 0 for a plugin that was never tracked', () =>
    Effect.gen(function* () {
      const guard = guardOver({ current: 0 })

      assert.strictEqual(yield* guard.used('chat'), 0)
    })
  )

  it.effect('lowers the total when the heap shrinks during a tracked effect', () =>
    Effect.gen(function* () {
      const heap = { current: 50 * MB }
      const guard = guardOver(heap)
      yield* guard.track('chat', growBy(heap, 10 * MB))

      yield* guard.track('chat', growBy(heap, -4 * MB))

      assert.strictEqual(yield* guard.used('chat'), 6 * MB)
    })
  )

  it.effect('never lets the total go below 0', () =>
    Effect.gen(function* () {
      const heap = { current: 50 * MB }
      const guard = guardOver(heap)
      yield* guard.track('chat', growBy(heap, 2 * MB))

      yield* guard.track('chat', growBy(heap, -30 * MB))

      assert.strictEqual(yield* guard.used('chat'), 0)
    })
  )

  it.effect('counts the growth of an effect that fails and passes the failure on', () =>
    Effect.gen(function* () {
      const heap = { current: 0 }
      const guard = guardOver(heap)

      const failure = yield* Effect.flip(
        guard.track('chat', growBy(heap, 6 * MB).pipe(Effect.andThen(Effect.fail('boom'))))
      )

      assert.strictEqual(failure, 'boom')
      assert.strictEqual(yield* guard.used('chat'), 6 * MB)
    })
  )

  it.effect('returns the value of the tracked effect', () =>
    Effect.gen(function* () {
      const guard = guardOver({ current: 0 })

      const value = yield* guard.track('chat', Effect.succeed(42))

      assert.strictEqual(value, 42)
    })
  )

  it('exposes the limit it was built with', () => {
    assert.strictEqual(guardOver({ current: 0 }, 5 * MB).limit, 5 * MB)
  })
})

describe('heapUsedAfterGc', () => {
  it.effect('reports a positive number of bytes', () =>
    Effect.gen(function* () {
      const bytes = yield* heapUsedAfterGc

      assert.isTrue(Number.isFinite(bytes) && bytes > 0)
    })
  )

  it.effect('counts memory a caller keeps reachable and drops memory it released', () =>
    Effect.gen(function* () {
      const baseline = yield* heapUsedAfterGc
      let retained: Array<{ readonly index: number }> | undefined = Array.from(
        { length: 1_000_000 },
        (_, index) => ({ index })
      )
      const whileRetained = yield* heapUsedAfterGc
      assert.strictEqual(retained.length, 1_000_000)
      retained = undefined
      const afterRelease = yield* heapUsedAfterGc

      assert.isAbove(whileRetained - baseline, 20 * MB)
      assert.isBelow(afterRelease - baseline, 10 * MB)
    })
  )
})
