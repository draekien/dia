import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import type { PathsMoved } from '@shared/plugin/paths-moved'
import { Effect, FileSystem, Layer, type Scope } from 'effect'
import { makeHostDatabaseLive } from './database'
import { PathMoves, PathMovesLive } from './path-moves'

const withPathMoves = <A, E>(body: Effect.Effect<A, E, PathMoves | Scope.Scope>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const userData = yield* fs.makeTempDirectoryScoped()
    return yield* body.pipe(
      Effect.provide(Layer.provide(PathMovesLive, makeHostDatabaseLive(userData)))
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const first = { from: '/data/plugins/worktrees', to: '/data/plugins/dia-worktrees' }
const second = { from: '/data/plugins/meta', to: '/data/plugins/dia-meta' }

const collector = () => {
  const received: Array<PathsMoved> = []
  return { received, handle: (move: PathsMoved) => Effect.sync(() => void received.push(move)) }
}

describe('PathMoves', () => {
  it.effect('gives an owner that subscribes later every move recorded before, oldest first', () =>
    withPathMoves(
      Effect.gen(function* () {
        const moves = yield* PathMoves
        yield* moves.recordMove('dia-worktrees', '1_dia_prefix', first)
        yield* moves.recordMove('dia-meta', '1_dia_prefix', second)
        const owner = collector()

        yield* moves.subscribe('workspace', owner.handle)

        assert.deepStrictEqual(owner.received, [first, second])
      })
    )
  )

  it.effect('gives a subscribed owner a move when it is recorded', () =>
    withPathMoves(
      Effect.gen(function* () {
        const moves = yield* PathMoves
        const owner = collector()
        yield* moves.subscribe('workspace', owner.handle)

        yield* moves.recordMove('dia-worktrees', '1_dia_prefix', first)

        assert.deepStrictEqual(owner.received, [first])
      })
    )
  )

  it.effect('does not give an owner a move it handled again', () =>
    withPathMoves(
      Effect.gen(function* () {
        const moves = yield* PathMoves
        yield* moves.recordMove('dia-worktrees', '1_dia_prefix', first)
        yield* Effect.scoped(moves.subscribe('workspace', collector().handle))
        const again = collector()

        yield* moves.subscribe('workspace', again.handle)

        assert.deepStrictEqual(again.received, [])
      })
    )
  )

  it.effect('gives a move whose handling failed again at the next subscription', () =>
    withPathMoves(
      Effect.gen(function* () {
        const moves = yield* PathMoves
        yield* moves.recordMove('dia-worktrees', '1_dia_prefix', first)
        yield* Effect.scoped(moves.subscribe('workspace', () => Effect.fail('disk full')))
        const retry = collector()

        yield* moves.subscribe('workspace', retry.handle)

        assert.deepStrictEqual(retry.received, [first])
      })
    )
  )

  it.effect('keeps acknowledgements per owner', () =>
    withPathMoves(
      Effect.gen(function* () {
        const moves = yield* PathMoves
        yield* moves.recordMove('dia-worktrees', '1_dia_prefix', first)
        yield* moves.subscribe('workspace', collector().handle)
        const other = collector()

        yield* moves.subscribe('dia-claude-code', other.handle)

        assert.deepStrictEqual(other.received, [first])
      })
    )
  )

  it.effect('stops giving moves to an owner whose scope closed', () =>
    withPathMoves(
      Effect.gen(function* () {
        const moves = yield* PathMoves
        const owner = collector()
        yield* Effect.scoped(moves.subscribe('workspace', owner.handle))

        yield* moves.recordMove('dia-worktrees', '1_dia_prefix', first)

        assert.deepStrictEqual(owner.received, [])
      })
    )
  )

  it.effect('reports a migration as run once it is recorded with or without a move', () =>
    withPathMoves(
      Effect.gen(function* () {
        const moves = yield* PathMoves
        yield* moves.recordRun('dia-chat', '1_dia_prefix')
        yield* moves.recordMove('dia-worktrees', '1_dia_prefix', first)

        assert.deepStrictEqual(
          [
            yield* moves.hasRun('dia-chat', '1_dia_prefix'),
            yield* moves.hasRun('dia-worktrees', '1_dia_prefix'),
            yield* moves.hasRun('dia-meta', '1_dia_prefix')
          ],
          [true, true, false]
        )
      })
    )
  )
})
