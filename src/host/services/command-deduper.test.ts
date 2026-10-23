import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { CommandDeduper, makeCommandDeduperLive } from './command-deduper'

describe('CommandDeduper', () => {
  it.effect('accepts a request id the first time and rejects a resend for the same pane', () =>
    Effect.gen(function* () {
      const deduper = yield* CommandDeduper

      const first = yield* deduper.accept('pane-1', 'req-1')
      const resend = yield* deduper.accept('pane-1', 'req-1')

      assert.deepStrictEqual([first, resend], [true, false])
    }).pipe(Effect.provide(makeCommandDeduperLive(4)))
  )

  it.effect('treats the same request id on another pane as new', () =>
    Effect.gen(function* () {
      const deduper = yield* CommandDeduper

      yield* deduper.accept('pane-1', 'req-1')
      const other = yield* deduper.accept('pane-2', 'req-1')

      assert.isTrue(other)
    }).pipe(Effect.provide(makeCommandDeduperLive(4)))
  )

  it.effect('accepts an id again once newer ids have pushed it out of the window', () =>
    Effect.gen(function* () {
      const deduper = yield* CommandDeduper

      yield* deduper.accept('pane-1', 'req-1')
      yield* deduper.accept('pane-1', 'req-2')
      yield* deduper.accept('pane-1', 'req-3')
      const evicted = yield* deduper.accept('pane-1', 'req-1')
      const stillRemembered = yield* deduper.accept('pane-1', 'req-3')

      assert.deepStrictEqual([evicted, stillRemembered], [true, false])
    }).pipe(Effect.provide(makeCommandDeduperLive(2)))
  )
})
