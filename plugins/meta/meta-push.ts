import {
  MetaRepoFailed,
  MetaRepoPushed,
  MetaRepoPushRefused,
  type MetaRepoPushResult,
  MetaRepoState,
  type MetaRepoStateResult
} from '@dia/plugin'
import { Duration, Effect, Option, Semaphore, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { SCAN_LOG_OPTIONS, scanPatchLog } from './push-scan'

const REMOTE = 'origin'

/** How long a `git fetch` or `git push` may run before it is stopped, credential sign-in included. */
export const NETWORK_TIMEOUT = Duration.minutes(2)

interface GitResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Replaces the password in every URL's user-info in `text` with `***`, so a token embedded in a
 * remote URL is never shown or logged.
 */
export const redactUrlCredentials = (text: string): string =>
  text.replace(/(\/\/[^/\s:@]*):[^/\s@]*@/g, '$1:***@')

const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? ''

const failed = (message: string) => MetaRepoFailed.make({ message: redactUrlCredentials(message) })

const isUsableRemoteUrl = (url: string): boolean =>
  url !== '' && !url.startsWith('-') && !/\s/.test(url)

/**
 * The push half of the meta repo in `directory` (`docs/designs/meta-repo-push.md`): `state`
 * reads the `origin` remote and the current branch, `setRemote` sets `origin` to a URL, and
 * `push` scans the commits `origin` does not have (ADR-0047) and pushes the current branch's
 * commit only when the scan finds no secret. None of them fails, and `setRemote` and `push` never
 * run at the same time. git runs with `GIT_TERMINAL_PROMPT=0`, and a fetch or push that takes
 * longer than {@link NETWORK_TIMEOUT} is stopped and reported. Run it once in the plugin's setup
 * with the Node platform services provided.
 */
export const makeMetaPush = Effect.fn('MetaPush.make')(function* (directory: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const lock = yield* Semaphore.make(1)

  const git = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make('git', [...args], {
            cwd: directory,
            env: { GIT_TERMINAL_PROMPT: '0' },
            extendEnv: true
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
        return { exitCode, stdout, stderr } satisfies GitResult
      })
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Could not run git in the meta repo', { args, error }).pipe(
          Effect.as<GitResult>({ exitCode: -1, stdout: '', stderr: 'git could not be run' })
        )
      )
    )

  const gitOrFail = (step: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* git(args)
      if (result.exitCode === 0) return Option.some(result.stdout)
      yield* Effect.logWarning('A meta repo git command failed', {
        step,
        exitCode: result.exitCode,
        stderr: redactUrlCredentials(result.stderr)
      })
      return Option.none<string>()
    })

  const gitText = (args: ReadonlyArray<string>) =>
    git(args).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)))

  const readRemoteUrl = gitText(['remote', 'get-url', REMOTE])
  const readBranch = gitText(['symbolic-ref', '--quiet', '--short', 'HEAD'])

  const state: Effect.Effect<MetaRepoStateResult> = Effect.gen(function* () {
    const remoteUrl = yield* readRemoteUrl
    return MetaRepoState.make({
      remoteUrl: remoteUrl === null ? null : redactUrlCredentials(remoteUrl),
      branch: yield* readBranch
    })
  })

  const network = Effect.fnUntraced(function* (step: string, args: ReadonlyArray<string>) {
    const result = yield* git(args).pipe(Effect.timeoutOption(NETWORK_TIMEOUT))
    if (Option.isNone(result)) {
      yield* Effect.logWarning('A meta repo git command timed out', { step })
      return failed(
        `git ${step} did not finish within ${Duration.toMinutes(NETWORK_TIMEOUT)} minutes.`
      )
    }
    const { exitCode, stderr } = result.value
    if (exitCode === 0) return undefined
    return failed(`git ${step} failed: ${lastLine(stderr) || `exit code ${exitCode}`}`)
  })

  const setRemote = (url: string): Effect.Effect<MetaRepoStateResult> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const trimmed = url.trim()
        if (!isUsableRemoteUrl(trimmed)) {
          return failed('Enter a remote URL without spaces that does not start with "-".')
        }
        const existing = yield* readRemoteUrl
        const result = yield* git([
          'remote',
          existing === null ? 'add' : 'set-url',
          REMOTE,
          trimmed
        ])
        if (result.exitCode !== 0) {
          return failed(`Could not set the remote: ${lastLine(result.stderr)}`)
        }
        yield* Effect.logInfo('Set the meta repo remote', {
          remoteUrl: redactUrlCredentials(trimmed)
        })
        return yield* state
      })
    )

  const push: Effect.Effect<MetaRepoPushResult> = lock.withPermits(1)(
    Effect.gen(function* () {
      const remoteUrl = yield* readRemoteUrl
      if (remoteUrl === null) return failed('Add a remote before pushing.')
      const branch = yield* readBranch
      if (branch === null) return failed('The meta repo has no branch checked out.')
      const head = yield* gitOrFail('rev-parse', ['rev-parse', '--verify', 'HEAD^{commit}'])
      if (Option.isNone(head)) return failed('The meta repo has no commit to push.')
      const sha = head.value.trim()

      const fetchFailure = yield* network('fetch', ['fetch', '--prune', REMOTE])
      if (fetchFailure !== undefined) return fetchFailure

      const log = yield* gitOrFail('log', [
        '-c',
        'core.quotePath=false',
        'log',
        ...SCAN_LOG_OPTIONS,
        sha,
        '--not',
        `--remotes=${REMOTE}`
      ])
      if (Option.isNone(log)) return failed('Could not read the commits to push.')
      const scan = scanPatchLog(log.value)
      const [first, ...rest] = scan.findings
      if (first !== undefined) {
        yield* Effect.logWarning('Refused to push the meta repo: the scan found secrets', {
          findings: scan.findings
        })
        return MetaRepoPushRefused.make({ findings: [first, ...rest] })
      }

      const pushFailure = yield* network('push', ['push', REMOTE, `${sha}:refs/heads/${branch}`])
      if (pushFailure !== undefined) return pushFailure
      yield* Effect.logInfo('Pushed the meta repo', {
        branch,
        commit: sha,
        commitCount: scan.commitCount
      })
      return MetaRepoPushed.make({
        branch,
        remoteUrl: redactUrlCredentials(remoteUrl),
        commitCount: scan.commitCount
      })
    })
  )

  return { state, setRemote, push }
})
