import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Option, Path, Result, type Scope } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { readBranches, switchBranch } from './branches'
import { makeGit } from './git'

const AUTHOR = { name: 'dia', email: 'dia@example.com' }

const gitIn = (directory: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.exitCode(ChildProcess.make('git', [...args]).pipe(ChildProcess.setCwd(directory)))
  )

const upstreamRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = yield* makeGit
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-branches-' })
  const write = (file: string, content: string) =>
    fs.writeFileString(path.join(directory, file), content)
  yield* gitIn(directory, ['init', '--quiet', '--initial-branch=main'])
  yield* write('a.txt', 'one')
  yield* git.commitAll(directory, { message: 'init', author: AUTHOR })
  return { fs, path, git, directory, write }
})

const clonedRepo = Effect.gen(function* () {
  const upstream = yield* upstreamRepo
  yield* gitIn(upstream.directory, ['branch', 'release'])
  const clone = `${upstream.directory}-clone`
  yield* gitIn(upstream.directory, ['clone', '--quiet', upstream.directory, clone])
  yield* Effect.addFinalizer(() =>
    upstream.fs.remove(clone, { recursive: true }).pipe(Effect.ignore)
  )
  return { ...upstream, clone }
})

const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('readBranches', { timeout: 30_000 }, () => {
  it.live('lists the checked-out branch, then other local branches, then remote ones', () =>
    live(
      Effect.gen(function* () {
        const { git, clone } = yield* clonedRepo
        yield* gitIn(clone, ['branch', 'zeta'])
        yield* gitIn(clone, ['branch', 'alpha'])

        const list = yield* readBranches(git, clone)

        assert.deepStrictEqual(list.branches, [
          { name: 'main', remote: null },
          { name: 'alpha', remote: null },
          { name: 'zeta', remote: null },
          { name: 'origin/main', remote: 'origin' },
          { name: 'origin/release', remote: 'origin' }
        ])
      })
    )
  )

  it.live("defaults the base to origin's HEAD branch", () =>
    live(
      Effect.gen(function* () {
        const { git, clone } = yield* clonedRepo
        yield* gitIn(clone, ['switch', '--quiet', '-c', 'topic'])

        const list = yield* readBranches(git, clone)

        assert.strictEqual(list.defaultBase, 'origin/main')
        assert.deepStrictEqual(list.head, { _tag: 'OnBranch', branch: 'topic' })
      })
    )
  )

  it.live('defaults the base to the checked-out branch when there is no origin', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* upstreamRepo

        assert.strictEqual((yield* readBranches(git, directory)).defaultBase, 'main')
      })
    )
  )

  it.live('reports a detached HEAD by its abbreviated commit', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* upstreamRepo
        const commit = Option.getOrElse(yield* git.resolveCommit(directory, 'HEAD'), () => '')
        yield* gitIn(directory, ['switch', '--quiet', '--detach'])

        const list = yield* readBranches(git, directory)

        assert.deepStrictEqual(list.head, { _tag: 'DetachedHead', commit: commit.slice(0, 7) })
        assert.isNull(list.defaultBase)
      })
    )
  )
})

describe('switchBranch', { timeout: 30_000 }, () => {
  it.live('checks out a remote-only branch as a local branch and returns the new list', () =>
    live(
      Effect.gen(function* () {
        const { git, clone } = yield* clonedRepo

        const list = yield* switchBranch(git, clone, 'release')

        assert.deepStrictEqual(list.head, { _tag: 'OnBranch', branch: 'release' })
        assert.deepStrictEqual(list.branches[0], { name: 'release', remote: null })
      })
    )
  )

  it.live('refuses while a tracked file has changes, naming the checked-out branch', () =>
    live(
      Effect.gen(function* () {
        const { git, clone, path, fs } = yield* clonedRepo
        yield* fs.writeFileString(path.join(clone, 'a.txt'), 'changed')

        const result = yield* Effect.result(switchBranch(git, clone, 'release'))

        const failure = Result.isFailure(result) ? result.failure : undefined
        assert.deepStrictEqual(
          failure?._tag === 'UncommittedChanges' ? failure.branch : failure,
          'main'
        )
        assert.deepStrictEqual(yield* git.currentBranch(clone), Option.some('main'))
      })
    )
  )

  it.live('switches when the only changes are untracked files', () =>
    live(
      Effect.gen(function* () {
        const { git, clone, path, fs } = yield* clonedRepo
        yield* fs.writeFileString(path.join(clone, 'notes.txt'), 'scratch')

        const list = yield* switchBranch(git, clone, 'release')

        assert.deepStrictEqual(list.head, { _tag: 'OnBranch', branch: 'release' })
      })
    )
  )
})
