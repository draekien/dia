import type { MetaRepoPushResult } from '@dia/plugin'
import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Option, Path, type Scope } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { makeMetaPush } from './meta-push'
import { ensureMetaRepo } from './meta-repo'

const SECRET = ['ghp', 'Zq8Xw2Lm4Np6Rt0Vb3Hk7Jd9Sf1Gc5TyAbCd'].join('_')

const git = (directory: string, ...args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(ChildProcess.make('git', [...args]).pipe(ChildProcess.setCwd(directory)))
  ).pipe(Effect.map((output) => output.trim()))

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-meta-push-' })
  const directory = path.join(root, 'repo')
  const remote = path.join(root, 'remote.git')
  yield* ensureMetaRepo(directory, yield* makeGit)
  yield* fs.makeDirectory(remote)
  yield* git(remote, 'init', '--bare')
  const commitFile = (file: string, content: string, message: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(path.join(directory, file), content)
      yield* git(directory, 'add', file)
      yield* git(
        directory,
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--no-verify',
        '-m',
        message
      )
      return yield* git(directory, 'rev-parse', 'HEAD')
    })
  const remoteHead = (branch: string) =>
    git(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).pipe(
      Effect.orElseSucceed(() => '')
    )
  const branch = yield* git(directory, 'symbolic-ref', '--short', 'HEAD')
  const metaPush = yield* makeMetaPush(directory, Effect.succeed(Option.some(yield* makeGit)))
  return { directory, remote, branch, commitFile, remoteHead, metaPush }
})

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('makeMetaPush', { timeout: 30_000 }, () => {
  it.effect('pushes the current branch to the remote when the commits have no secret', () =>
    run(
      Effect.gen(function* () {
        const { remote, branch, commitFile, remoteHead, metaPush } = yield* fixture
        yield* metaPush.setRemote(remote)
        const head = yield* commitFile('instructions.md', 'Prefer rg over grep.\n', 'docs: tip')

        const result = yield* metaPush.push

        assert.deepStrictEqual(result, {
          _tag: 'MetaRepoPushed',
          branch,
          remoteUrl: remote,
          commitCount: 2
        })
        assert.strictEqual(yield* remoteHead(branch), head)
      })
    )
  )

  it.effect('refuses a push whose new commit adds a secret and leaves the remote unchanged', () =>
    run(
      Effect.gen(function* () {
        const { remote, branch, commitFile, remoteHead, metaPush } = yield* fixture
        yield* metaPush.setRemote(remote)
        yield* metaPush.push
        const pushed = yield* remoteHead(branch)
        const leaking = yield* commitFile('instructions.md', `Use ${SECRET}\n`, 'docs: leak')

        const first = yield* metaPush.push
        const second = yield* metaPush.push

        const expected: MetaRepoPushResult = {
          _tag: 'MetaRepoPushRefused',
          findings: [
            {
              rule: 'github-token',
              description: 'GitHub token',
              commit: leaking,
              file: 'instructions.md',
              line: 1
            }
          ]
        }
        assert.deepStrictEqual(first, expected)
        assert.deepStrictEqual(second, expected)
        assert.strictEqual(yield* remoteHead(branch), pushed)
      })
    )
  )

  it.effect('still refuses after a later commit removes the secret from the working tree', () =>
    run(
      Effect.gen(function* () {
        const { remote, branch, commitFile, remoteHead, metaPush } = yield* fixture
        yield* metaPush.setRemote(remote)
        yield* metaPush.push
        const pushed = yield* remoteHead(branch)
        yield* commitFile('instructions.md', `Use ${SECRET}\n`, 'docs: leak')
        yield* commitFile('instructions.md', 'Use the key from the vault.\n', 'docs: unleak')

        const result = yield* metaPush.push

        assert.strictEqual(result._tag, 'MetaRepoPushRefused')
        assert.strictEqual(yield* remoteHead(branch), pushed)
      })
    )
  )

  it.effect('scans a file that .gitattributes marks as not diffable', () =>
    run(
      Effect.gen(function* () {
        const { remote, branch, commitFile, remoteHead, metaPush } = yield* fixture
        yield* metaPush.setRemote(remote)
        yield* commitFile('.gitattributes', '* -diff\n', 'chore: hide diffs')
        yield* commitFile('instructions.md', `Use ${SECRET}\n`, 'docs: leak')

        const result = yield* metaPush.push

        assert.strictEqual(result._tag, 'MetaRepoPushRefused')
        assert.strictEqual(yield* remoteHead(branch), '')
      })
    )
  )

  it.effect('does not scan a commit the remote already has', () =>
    run(
      Effect.gen(function* () {
        const { directory, remote, branch, commitFile, remoteHead, metaPush } = yield* fixture
        yield* metaPush.setRemote(remote)
        yield* commitFile('old.md', `${SECRET}\n`, 'docs: pushed with plain git')
        yield* git(directory, 'push', 'origin', `HEAD:refs/heads/${branch}`)
        const head = yield* commitFile('instructions.md', 'Keep answers short.\n', 'docs: tip')

        const result = yield* metaPush.push

        assert.deepStrictEqual(result, {
          _tag: 'MetaRepoPushed',
          branch,
          remoteUrl: remote,
          commitCount: 1
        })
        assert.strictEqual(yield* remoteHead(branch), head)
      })
    )
  )

  it.effect('refuses to push before a remote is set', () =>
    run(
      Effect.gen(function* () {
        const { metaPush } = yield* fixture

        assert.deepStrictEqual(yield* metaPush.push, {
          _tag: 'MetaRepoFailed',
          message: 'Add a remote before pushing.'
        })
      })
    )
  )

  it.effect('reports state, remote and push as failed while no dia-git is loaded', () =>
    run(
      Effect.gen(function* () {
        const { directory, remote } = yield* fixture
        const withoutGit = yield* makeMetaPush(directory, Effect.succeed(Option.none()))
        const unavailable = { _tag: 'MetaRepoFailed', message: 'Git is not available.' }

        assert.deepStrictEqual(
          [yield* withoutGit.state, yield* withoutGit.setRemote(remote), yield* withoutGit.push],
          [unavailable, unavailable, unavailable]
        )
      })
    )
  )

  it.effect('reports a push to an unreachable remote as a failure naming the step', () =>
    run(
      Effect.gen(function* () {
        const { remote, metaPush } = yield* fixture
        yield* metaPush.setRemote(`${remote}-missing`)

        const result = yield* metaPush.push

        assert.strictEqual(result._tag, 'MetaRepoFailed')
        assert.isTrue(
          result._tag === 'MetaRepoFailed' && result.message.startsWith('git fetch failed')
        )
      })
    )
  )

  it.effect('sets, then replaces, the remote and reports the state', () =>
    run(
      Effect.gen(function* () {
        const { remote, branch, metaPush } = yield* fixture

        yield* metaPush.setRemote('https://example.com/first.git')
        const result = yield* metaPush.setRemote(` ${remote} `)

        assert.deepStrictEqual(result, { _tag: 'MetaRepoState', remoteUrl: remote, branch })
      })
    )
  )

  it.effect('refuses a remote URL that git could read as an option', () =>
    run(
      Effect.gen(function* () {
        const { branch, metaPush } = yield* fixture

        const result = yield* metaPush.setRemote('--upload-pack=calc.exe')

        assert.strictEqual(result._tag, 'MetaRepoFailed')
        assert.deepStrictEqual(yield* metaPush.state, {
          _tag: 'MetaRepoState',
          remoteUrl: null,
          branch
        })
      })
    )
  )

  it.effect('shows a remote URL with its password replaced', () =>
    run(
      Effect.gen(function* () {
        const { metaPush } = yield* fixture

        const result = yield* metaPush.setRemote('https://me:hunter2token@example.com/meta.git')

        assert.strictEqual(
          result._tag === 'MetaRepoState' ? result.remoteUrl : undefined,
          'https://me:***@example.com/meta.git'
        )
      })
    )
  )
})
