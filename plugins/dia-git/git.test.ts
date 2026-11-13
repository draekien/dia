import { GitError } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Option, Path, Result, type Scope } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { makeGit, redactUrlCredentials } from './git'

const TOKEN = ['ghp', 'Zq8Xw2Lm4Np6Rt0Vb3Hk7Jd9Sf1Gc5TyAbCd'].join('_')

const AUTHOR = { name: 'dia', email: 'dia@example.com' }

const stage = (directory: string) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.exitCode(ChildProcess.make('git', ['add', '-A']).pipe(ChildProcess.setCwd(directory)))
  )

const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = yield* makeGit
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-git-' })
  yield* Effect.addFinalizer(() => git.stopFsmonitor(directory))
  const write = (file: string, content: string) =>
    fs.writeFileString(path.join(directory, file), content)
  return { fs, path, git, directory, write }
})

const repo = Effect.gen(function* () {
  const context = yield* scratch
  yield* context.git.init(context.directory)
  return context
})

const committedRepo = Effect.gen(function* () {
  const context = yield* repo
  yield* context.write('a.txt', 'one\n')
  yield* context.git.commitAll(context.directory, { message: 'init', author: AUTHOR })
  return context
})

const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('makeGit', { timeout: 30_000 }, () => {
  it.live('resolves no commit in a repository without one, and the commit once made', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, write } = yield* repo
        const before = yield* git.resolveCommit(directory, 'HEAD')
        yield* write('a.txt', 'one\n')
        yield* git.commitAll(directory, { message: 'init', author: AUTHOR })

        const after = yield* git.resolveCommit(directory, 'HEAD')

        assert.isTrue(Option.isNone(before))
        assert.match(
          Option.getOrElse(after, () => ''),
          /^[0-9a-f]{40}$/
        )
      })
    )
  )

  it.live('tells an existing local branch from a missing one', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* committedRepo
        const branch = Option.getOrElse(yield* git.currentBranch(directory), () => '')

        assert.deepStrictEqual(
          [yield* git.branchExists(directory, branch), yield* git.branchExists(directory, 'nope')],
          [true, false]
        )
      })
    )
  )

  it.live('reads no current branch on a detached HEAD', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* committedRepo
        const head = Option.getOrElse(yield* git.resolveCommit(directory, 'HEAD'), () => '')
        yield* git.addWorktree(directory, `${directory}-detached`, head, { createBranch: false })
        yield* Effect.addFinalizer(() =>
          git
            .removeWorktree(directory, `${directory}-detached`, { force: true })
            .pipe(Effect.ignore)
        )

        assert.isTrue(Option.isNone(yield* git.currentBranch(`${directory}-detached`)))
      })
    )
  )

  it.live('reads no remote URL until one is set, then the URL it was replaced with', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* repo
        const before = yield* git.remoteUrl(directory, 'origin')
        yield* git.setRemoteUrl(directory, 'origin', 'https://example.com/first.git')
        yield* git.setRemoteUrl(directory, 'origin', 'https://example.com/second.git')

        assert.deepStrictEqual(
          [before, yield* git.remoteUrl(directory, 'origin')],
          [Option.none(), Option.some('https://example.com/second.git')]
        )
      })
    )
  )

  it.live('lists tracked and untracked files but not ignored ones', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, write } = yield* committedRepo
        yield* write('.gitignore', 'secret.env\n')
        yield* write('secret.env', 'x')
        yield* write('new.txt', 'x')

        const files = yield* git.listFiles(directory)

        assert.deepStrictEqual([...files].sort(), ['.gitignore', 'a.txt', 'new.txt'])
      })
    )
  )

  it.live('fails to list the files of a directory outside any repository', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* scratch

        const result = yield* Effect.result(git.listFiles(directory))

        assert.isTrue(Result.isFailure(result) && result.failure instanceof GitError)
      })
    )
  )

  it.live('matches only the untracked, ignored files a patterns file names', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, path, write } = yield* committedRepo
        yield* write('.gitignore', '.env\nbuild.log\n')
        yield* write('.env', 'x')
        yield* write('build.log', 'x')
        yield* write('notes.txt', 'x')
        const patterns = path.join(directory, '.worktreeinclude')
        yield* write('.worktreeinclude', '.env\nnotes.txt\n')

        const files = yield* git.ignoredMatching(directory, patterns)

        assert.deepStrictEqual(files, ['.env'])
      })
    )
  )

  it.live('matches nothing when no ignored file matches the patterns', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, path, write } = yield* committedRepo
        yield* write('notes.txt', 'x')
        yield* write('.worktreeinclude', 'notes.txt\n')

        const files = yield* git.ignoredMatching(
          directory,
          path.join(directory, '.worktreeinclude')
        )

        assert.deepStrictEqual(files, [])
      })
    )
  )

  it.live('reports a modified, a deleted and an untracked file one entry each', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, write, fs, path } = yield* committedRepo
        yield* write('b.txt', 'two')
        yield* git.commitAll(directory, { message: 'b', author: AUTHOR })
        yield* write('a.txt', 'changed')
        yield* fs.remove(path.join(directory, 'b.txt'))
        yield* write('c.txt', 'new')

        const entries = yield* git.status(directory)

        assert.deepStrictEqual(
          [...entries].sort((x, y) => x.path.localeCompare(y.path)),
          [
            { code: ' M', path: 'a.txt' },
            { code: ' D', path: 'b.txt' },
            { code: '??', path: 'c.txt' }
          ]
        )
      })
    )
  )

  it.live('reports a staged rename as one entry under its new path', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, fs, path } = yield* committedRepo
        yield* fs.rename(path.join(directory, 'a.txt'), path.join(directory, 'renamed.txt'))
        yield* stage(directory)

        const entries = yield* git.status(directory)

        assert.deepStrictEqual(entries, [{ code: 'R ', path: 'renamed.txt' }])
      })
    )
  )

  it.live('keeps credentials of a remote URL out of a GitError', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* scratch

        const result = yield* Effect.result(
          git.setRemoteUrl(directory, 'origin', `https://me:${TOKEN}@example.com/meta.git`)
        )

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.notInclude(JSON.stringify(result.failure.args), TOKEN)
          assert.notInclude(result.failure.message, TOKEN)
        }
      })
    )
  )

  it.live('stops no fsmonitor daemon outside a repository without failing', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* scratch

        yield* git.stopFsmonitor(directory)
      })
    )
  )

  it.live('snapshots modified and untracked files without changing the index or HEAD', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, write } = yield* committedRepo
        yield* write('a.txt', 'one\ntwo\n')
        yield* write('new.txt', 'x\ny\n')
        const statusBefore = yield* git.status(directory)
        const headBefore = yield* git.resolveCommit(directory, 'HEAD')

        yield* git.snapshot(directory, ['refs/dia/test/after'], 'after')

        assert.deepStrictEqual(yield* git.changedFiles(directory, 'HEAD', 'refs/dia/test/after'), [
          { path: 'a.txt', added: 1, deleted: 0, binary: false },
          { path: 'new.txt', added: 2, deleted: 0, binary: false }
        ])
        assert.deepStrictEqual(yield* git.status(directory), statusBefore)
        assert.deepStrictEqual(yield* git.resolveCommit(directory, 'HEAD'), headBefore)
      })
    )
  )

  it.live('leaves ignored files out of a snapshot', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, write } = yield* committedRepo
        yield* write('.gitignore', 'secret.env\n')
        yield* write('secret.env', 'x\n')

        yield* git.snapshot(directory, ['refs/dia/test/after'], 'after')

        const files = yield* git.changedFiles(directory, 'HEAD', 'refs/dia/test/after')
        assert.deepStrictEqual(
          files.map((file) => file.path),
          ['.gitignore']
        )
      })
    )
  )

  it.live('snapshots a repository that has no commit yet', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, write } = yield* repo
        yield* write('a.txt', 'one\n')
        yield* git.snapshot(directory, ['refs/dia/test/before'], 'before')
        yield* write('a.txt', 'two\n')
        yield* git.snapshot(directory, ['refs/dia/test/after'], 'after')

        assert.deepStrictEqual(
          yield* git.changedFiles(directory, 'refs/dia/test/before', 'refs/dia/test/after'),
          [{ path: 'a.txt', added: 1, deleted: 1, binary: false }]
        )
      })
    )
  )

  it.live('reports a changed binary file with no line counts', () =>
    live(
      Effect.gen(function* () {
        const { git, directory, fs, path } = yield* committedRepo
        yield* fs.writeFile(path.join(directory, 'image.bin'), new Uint8Array([0, 1, 2, 0]))

        yield* git.snapshot(directory, ['refs/dia/test/after'], 'after')

        assert.deepStrictEqual(yield* git.changedFiles(directory, 'HEAD', 'refs/dia/test/after'), [
          { path: 'image.bin', added: 0, deleted: 0, binary: true }
        ])
      })
    )
  )

  it.live('points every given ref at the snapshot and lists only the refs under a prefix', () =>
    live(
      Effect.gen(function* () {
        const { git, directory } = yield* committedRepo
        yield* git.snapshot(directory, ['refs/dia/test/1/end', 'refs/dia/test/2/start'], 'Fix it')
        yield* git.snapshot(directory, ['refs/dia/other/1/start'], 'Elsewhere')

        const refs = yield* git.refs(directory, 'refs/dia/test/')

        assert.deepStrictEqual(refs, [
          { name: 'refs/dia/test/1/end', subject: 'Fix it' },
          { name: 'refs/dia/test/2/start', subject: 'Fix it' }
        ])
        assert.deepStrictEqual(
          yield* git.resolveCommit(directory, 'refs/dia/test/1/end'),
          yield* git.resolveCommit(directory, 'refs/dia/test/2/start')
        )
      })
    )
  )
})

describe('redactUrlCredentials', () => {
  it('replaces the password in every URL of a message and keeps the user name', () => {
    assert.strictEqual(
      redactUrlCredentials(
        "fatal: unable to access 'https://me:tok3n@host/a.git/': and ssh://git@host/b.git"
      ),
      "fatal: unable to access 'https://me:***@host/a.git/': and ssh://git@host/b.git"
    )
  })

  it('replaces a token used as the user name of an https URL', () => {
    assert.strictEqual(
      redactUrlCredentials(`remote: https://${TOKEN}@github.com/me/meta.git`),
      'remote: https://***@github.com/me/meta.git'
    )
  })
})
