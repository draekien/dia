import { type Git, GitError, type GitStatusEntry } from '@dia/plugin'
import { Effect, Option, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

/**
 * Replaces the password in every URL's user-info in `text`, and the whole user-info of an
 * `http(s)` URL that has no password, with `***`, so a token embedded in a remote URL is never
 * shown or logged.
 */
export const redactUrlCredentials = (text: string): string =>
  text
    .replace(/(\/\/[^/\s:@]*):[^/\s@]*@/g, '$1:***@')
    .replace(/(https?:\/\/)[^/\s:@]+@/gi, '$1***@')

const PORCELAIN_WORKTREE_PREFIX = 'worktree '

interface Output {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const splitNul = (output: string): ReadonlyArray<string> =>
  output.split('\0').filter((item) => item !== '')

/**
 * Builds a {@link Git} that runs the `git` CLI through the platform `ChildProcessSpawner`, with
 * `GIT_TERMINAL_PROMPT=0` added to the inherited environment. Run it with the Node platform
 * services provided: `dia-git` does so to provide `GitKey`, and code that runs before `dia-git`
 * loads (a data migration's `before` step, a path-move handler) builds its own.
 */
export const makeGit = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const run = (
    cwd: string,
    args: ReadonlyArray<string>,
    stdin?: Stream.Stream<Uint8Array>
  ): Effect.Effect<Output> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make('git', [...args], {
            cwd,
            env: { GIT_TERMINAL_PROMPT: '0' },
            extendEnv: true,
            ...(stdin === undefined ? {} : { stdin })
          })
        )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode
          ],
          { concurrency: 'unbounded' }
        )
        return { exitCode: Number(exitCode), stdout, stderr } satisfies Output
      })
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed<Output>({ exitCode: -1, stdout: '', stderr: String(error) })
      ),
      Effect.tap((output) =>
        Effect.logDebug('Ran git', { cwd, command: args[0], exitCode: output.exitCode })
      )
    )

  const failure = (cwd: string, args: ReadonlyArray<string>, output: Output) =>
    new GitError({
      cwd,
      args: args.map(redactUrlCredentials),
      exitCode: output.exitCode,
      stderr: redactUrlCredentials(output.stderr)
    })

  const runOk = Effect.fnUntraced(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    stdin?: Stream.Stream<Uint8Array>
  ) {
    const output = yield* run(cwd, args, stdin)
    if (output.exitCode !== 0) return yield* failure(cwd, args, output)
    return output.stdout
  })

  const runOptional = Effect.fnUntraced(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    noneCode: number
  ) {
    const output = yield* run(cwd, args)
    if (output.exitCode === noneCode) return Option.none<string>()
    if (output.exitCode !== 0) return yield* failure(cwd, args, output)
    return Option.some(output.stdout.trim())
  })

  const resolveCommit = (cwd: string, rev: string) =>
    runOptional(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], 1)

  const status = (cwd: string) =>
    runOk(cwd, ['status', '--porcelain=v1', '-z']).pipe(
      Effect.map((output) => {
        const fields = splitNul(output)
        const entries: Array<GitStatusEntry> = []
        for (let index = 0; index < fields.length; index++) {
          const field = fields[index] ?? ''
          const code = field.slice(0, 2)
          entries.push({ code, path: field.slice(3) })
          if (code.includes('R') || code.includes('C')) index++
        }
        return entries
      })
    )

  const ignoredMatching = Effect.fnUntraced(function* (repo: string, patternsFile: string) {
    const candidates = yield* runOk(repo, [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      `--exclude-from=${patternsFile}`
    ])
    if (candidates === '') return []
    const checkArgs = ['check-ignore', '-z', '--stdin']
    const output = yield* run(repo, checkArgs, Stream.encodeText(Stream.make(candidates)))
    if (output.exitCode === 1) return []
    if (output.exitCode !== 0) return yield* failure(repo, checkArgs, output)
    return splitNul(output.stdout)
  })

  const setRemoteUrl = Effect.fnUntraced(function* (cwd: string, remote: string, url: string) {
    const existing = yield* runOptional(cwd, ['remote', 'get-url', remote], 2)
    yield* runOk(cwd, ['remote', Option.isNone(existing) ? 'add' : 'set-url', remote, url])
  })

  const git: Git = {
    init: (cwd) => runOk(cwd, ['init']).pipe(Effect.asVoid),
    commitAll: Effect.fnUntraced(function* (cwd, { message, author }) {
      yield* runOk(cwd, ['add', '-A'])
      yield* runOk(cwd, [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--no-verify',
        '-m',
        message
      ])
    }),
    resolveCommit,
    branchExists: (repo, branch) =>
      runOptional(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], 1).pipe(
        Effect.map(Option.isSome)
      ),
    currentBranch: (cwd) => runOptional(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 1),
    status,
    diff: (cwd, options) =>
      runOk(cwd, [
        '-c',
        'core.quotePath=false',
        'diff',
        ...(options?.revisions ?? []),
        '--',
        ...(options?.paths ?? [])
      ]),
    log: (cwd, options) => runOk(cwd, ['-c', 'core.quotePath=false', 'log', ...options]),
    listFiles: (cwd) =>
      runOk(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).pipe(
        Effect.map(splitNul)
      ),
    ignoredMatching,
    remoteUrl: (cwd, remote) => runOptional(cwd, ['remote', 'get-url', remote], 2),
    setRemoteUrl,
    fetch: (cwd, remote) => runOk(cwd, ['fetch', '--prune', remote]).pipe(Effect.asVoid),
    push: (cwd, remote, refspec) => runOk(cwd, ['push', remote, refspec]).pipe(Effect.asVoid),
    addWorktree: (repo, path, branch, { createBranch }) =>
      runOk(
        repo,
        createBranch ? ['worktree', 'add', path, '-b', branch] : ['worktree', 'add', path, branch]
      ).pipe(Effect.asVoid),
    removeWorktree: (repo, path, { force }) =>
      runOk(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]).pipe(Effect.asVoid),
    pruneWorktrees: (repo) => runOk(repo, ['worktree', 'prune']).pipe(Effect.asVoid),
    listWorktrees: (repo) =>
      runOk(repo, ['worktree', 'list', '--porcelain']).pipe(
        Effect.map((output) =>
          output
            .split(/\r?\n/)
            .filter((line) => line.startsWith(PORCELAIN_WORKTREE_PREFIX))
            .map((line) => line.slice(PORCELAIN_WORKTREE_PREFIX.length))
        )
      ),
    repairWorktrees: (repo, paths) =>
      runOk(repo, ['worktree', 'repair', ...paths]).pipe(Effect.asVoid),
    stopFsmonitor: (cwd) => run(cwd, ['fsmonitor--daemon', 'stop']).pipe(Effect.asVoid)
  }
  return git
})
