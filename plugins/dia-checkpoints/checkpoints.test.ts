import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Path, Result, type Scope } from 'effect'
import { TurnFinished, TurnOpen } from './calls'
import { makeCheckpoints } from './checkpoints'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

const AUTHOR = { name: 'dia', email: 'dia@example.com' }

const committedRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = yield* makeGit
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-checkpoints-' })
  yield* Effect.addFinalizer(() => git.stopFsmonitor(directory))
  const write = (file: string, content: string) =>
    fs.writeFileString(path.join(directory, file), content)
  yield* git.init(directory)
  yield* write('a.txt', 'one\n')
  yield* git.commitAll(directory, { message: 'init', author: AUTHOR })
  return { git, directory, write, checkpoints: makeCheckpoints(git) }
})

const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('makeCheckpoints', { timeout: 30_000 }, () => {
  it.live('lists the files a turn changed, leaving the index, HEAD and status as they were', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, write, checkpoints } = yield* committedRepo
        const headBefore = yield* git.resolveCommit(directory, 'HEAD')
        yield* checkpoints.beginTurn(RUN, directory, 'Edit a')
        yield* write('a.txt', 'one\ntwo\n')
        yield* write('new.txt', 'x\n')
        const statusBefore = yield* git.status(directory)

        yield* checkpoints.endTurn(RUN, directory)

        assert.deepStrictEqual(yield* checkpoints.turns(RUN, directory), [
          TurnFinished.make({
            turn: 1,
            prompt: 'Edit a',
            files: [
              { path: 'a.txt', added: 1, deleted: 0, binary: false },
              { path: 'new.txt', added: 1, deleted: 0, binary: false }
            ]
          })
        ])
        assert.deepStrictEqual(yield* git.status(directory), statusBefore)
        assert.deepStrictEqual(yield* git.resolveCommit(directory, 'HEAD'), headBefore)
      })
    )
  )

  it.live('shows a turn with no end as open', () =>
    live(
      Effect.gen(function* () {
        const { directory, write, checkpoints } = yield* committedRepo
        yield* checkpoints.beginTurn(RUN, directory, 'Edit a')
        yield* write('a.txt', 'two\n')

        assert.deepStrictEqual(yield* checkpoints.turns(RUN, directory), [
          TurnOpen.make({ turn: 1, prompt: 'Edit a' })
        ])
      })
    )
  )

  it.live('ends an open turn where the next one starts', () =>
    live(
      Effect.gen(function* () {
        const { directory, write, checkpoints } = yield* committedRepo
        yield* checkpoints.beginTurn(RUN, directory, 'First')
        yield* write('a.txt', 'two\n')
        yield* checkpoints.beginTurn(RUN, directory, 'Second')
        yield* write('b.txt', 'b\n')

        assert.deepStrictEqual(yield* checkpoints.turns(RUN, directory), [
          TurnFinished.make({
            turn: 1,
            prompt: 'First',
            files: [{ path: 'a.txt', added: 1, deleted: 1, binary: false }]
          }),
          TurnOpen.make({ turn: 2, prompt: 'Second' })
        ])
      })
    )
  )

  it.live('replaces a turn end with a later one', () =>
    live(
      Effect.gen(function* () {
        const { directory, write, checkpoints } = yield* committedRepo
        yield* checkpoints.beginTurn(RUN, directory, 'Edit')
        yield* write('a.txt', 'two\n')
        yield* checkpoints.endTurn(RUN, directory)
        yield* write('b.txt', 'b\n')
        yield* checkpoints.endTurn(RUN, directory)

        const [turn] = yield* checkpoints.turns(RUN, directory)
        assert.deepStrictEqual(
          turn?._tag === 'TurnFinished' ? turn.files.map((file) => file.path) : [],
          ['a.txt', 'b.txt']
        )
      })
    )
  )

  it.live('records no turn end for a run that has no turn', () =>
    live(
      Effect.gen(function* () {
        const { directory, checkpoints } = yield* committedRepo

        yield* checkpoints.endTurn(RUN, directory)

        assert.deepStrictEqual(yield* checkpoints.turns(RUN, directory), [])
      })
    )
  )

  it.live('keeps the turns of each run apart', () =>
    live(
      Effect.gen(function* () {
        const { directory, checkpoints } = yield* committedRepo
        yield* checkpoints.beginTurn(RUN, directory, 'Mine')
        yield* checkpoints.beginTurn('bbbbbbbb-0000-4000-8000-000000000002', directory, 'Theirs')

        assert.deepStrictEqual(yield* checkpoints.turns(RUN, directory), [
          TurnOpen.make({ turn: 1, prompt: 'Mine' })
        ])
      })
    )
  )

  it.live('gives the patch of one file of a finished turn', () =>
    live(
      Effect.gen(function* () {
        const { directory, write, checkpoints } = yield* committedRepo
        yield* checkpoints.beginTurn(RUN, directory, 'Edit')
        yield* write('a.txt', 'two\n')
        yield* write('b.txt', 'b\n')
        yield* checkpoints.endTurn(RUN, directory)

        const patch = yield* checkpoints.fileDiff(RUN, directory, 1, 'a.txt')

        assert.include(patch, '-one\n+two\n')
        assert.notInclude(patch, 'b.txt')
      })
    )
  )

  it.live('refuses the patch of a turn that has not ended', () =>
    live(
      Effect.gen(function* () {
        const { directory, checkpoints } = yield* committedRepo
        yield* checkpoints.beginTurn(RUN, directory, 'Edit')

        const result = yield* Effect.result(checkpoints.fileDiff(RUN, directory, 1, 'a.txt'))

        assert.isTrue(Result.isFailure(result) && result.failure._tag === 'ChangesUnavailable')
      })
    )
  )
})
