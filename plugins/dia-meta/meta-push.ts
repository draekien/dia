import {
  type Git,
  type GitError,
  MetaRepoFailed,
  MetaRepoPushed,
  MetaRepoPushRefused,
  type MetaRepoPushResult,
  MetaRepoState,
  type MetaRepoStateResult
} from '@dia/plugin'
import { redactUrlCredentials } from '@dia-plugin/dia-git/git'
import { Duration, Effect, Option, Semaphore } from 'effect'
import { SCAN_LOG_OPTIONS, scanPatchLog } from './push-scan'

const REMOTE = 'origin'

/** How long a `git fetch` or `git push` may run before it is stopped, credential sign-in included. */
export const NETWORK_TIMEOUT = Duration.minutes(2)

const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? ''

const failed = (message: string) => MetaRepoFailed.make({ message: redactUrlCredentials(message) })

const GIT_UNAVAILABLE = failed('Git is not available.')

const reason = (error: GitError) => lastLine(error.stderr) || `exit code ${error.exitCode}`

const isUsableRemoteUrl = (url: string): boolean =>
  url !== '' && !url.startsWith('-') && !/\s/.test(url)

/**
 * The push half of the meta repo in `directory` (`docs/designs/meta-repo-push.md`): `state`
 * reads the `origin` remote and the current branch, `setRemote` sets `origin` to a URL, and
 * `push` scans the commits `origin` does not have (ADR-0047) and pushes the current branch's
 * commit only when the scan finds no secret. Each reads `currentGit` once when it starts and
 * returns `MetaRepoFailed` when it is `None` (no `dia-git` loaded). None of them fails, and
 * `setRemote` and `push` never run at the same time. A fetch or push that takes longer than
 * {@link NETWORK_TIMEOUT} is stopped and reported.
 */
export const makeMetaPush = Effect.fn('MetaPush.make')(function* (
  directory: string,
  currentGit: Effect.Effect<Option.Option<Git>>
) {
  const lock = yield* Semaphore.make(1)

  const withGit = <A>(
    use: (git: Git) => Effect.Effect<A>
  ): Effect.Effect<A | typeof GIT_UNAVAILABLE> =>
    Effect.flatMap(
      currentGit,
      (git): Effect.Effect<A | typeof GIT_UNAVAILABLE> =>
        Option.isSome(git) ? use(git.value) : Effect.succeed(GIT_UNAVAILABLE)
    )

  const logFailure = (step: string) => (error: GitError) =>
    Effect.logWarning('A meta repo git command failed', {
      step,
      exitCode: error.exitCode,
      stderr: error.stderr
    })

  const readState = (git: Git): Effect.Effect<MetaRepoStateResult> =>
    Effect.gen(function* () {
      const remoteUrl = yield* git.remoteUrl(directory, REMOTE)
      const branch = yield* git.currentBranch(directory)
      return MetaRepoState.make({
        remoteUrl: Option.getOrNull(Option.map(remoteUrl, redactUrlCredentials)),
        branch: Option.getOrNull(branch)
      })
    }).pipe(
      Effect.tapError(logFailure('state')),
      Effect.catch((error) =>
        Effect.succeed(failed(`Could not read the meta repo: ${reason(error)}`))
      )
    )

  const network = Effect.fnUntraced(function* (
    step: string,
    command: Effect.Effect<void, GitError>
  ) {
    const result = yield* command.pipe(Effect.result, Effect.timeoutOption(NETWORK_TIMEOUT))
    if (Option.isNone(result)) {
      yield* Effect.logWarning('A meta repo git command timed out', { step })
      return failed(
        `git ${step} did not finish within ${Duration.toMinutes(NETWORK_TIMEOUT)} minutes.`
      )
    }
    if (result.value._tag === 'Success') return undefined
    yield* logFailure(step)(result.value.failure)
    return failed(`git ${step} failed: ${reason(result.value.failure)}`)
  })

  const state: Effect.Effect<MetaRepoStateResult> = withGit(readState)

  const setRemote = (url: string): Effect.Effect<MetaRepoStateResult> =>
    lock.withPermits(1)(
      withGit((git) =>
        Effect.gen(function* () {
          const trimmed = url.trim()
          if (!isUsableRemoteUrl(trimmed)) {
            return failed('Enter a remote URL without spaces that does not start with "-".')
          }
          const set = yield* git.setRemoteUrl(directory, REMOTE, trimmed).pipe(Effect.result)
          if (set._tag === 'Failure') {
            return failed(`Could not set the remote: ${reason(set.failure)}`)
          }
          yield* Effect.logInfo('Set the meta repo remote', {
            remoteUrl: redactUrlCredentials(trimmed)
          })
          return yield* readState(git)
        })
      )
    )

  const pushWith = (git: Git): Effect.Effect<MetaRepoPushResult> =>
    Effect.gen(function* () {
      const current = yield* readState(git)
      if (current._tag === 'MetaRepoFailed') return current
      const { remoteUrl, branch } = current
      if (remoteUrl === null) return failed('Add a remote before pushing.')
      if (branch === null) return failed('The meta repo has no branch checked out.')
      const head = yield* git.resolveCommit(directory, 'HEAD')
      if (Option.isNone(head)) return failed('The meta repo has no commit to push.')
      const sha = head.value

      const fetchFailure = yield* network('fetch', git.fetch(directory, REMOTE))
      if (fetchFailure !== undefined) return fetchFailure

      const log = yield* git
        .log(directory, [...SCAN_LOG_OPTIONS, sha, '--not', `--remotes=${REMOTE}`])
        .pipe(Effect.tapError(logFailure('log')), Effect.option)
      if (Option.isNone(log)) return failed('Could not read the commits to push.')
      const scan = scanPatchLog(log.value)
      const [first, ...rest] = scan.findings
      if (first !== undefined) {
        yield* Effect.logWarning('Refused to push the meta repo: the scan found secrets', {
          findings: scan.findings
        })
        return MetaRepoPushRefused.make({ findings: [first, ...rest] })
      }

      const pushFailure = yield* network(
        'push',
        git.push(directory, REMOTE, `${sha}:refs/heads/${branch}`)
      )
      if (pushFailure !== undefined) return pushFailure
      yield* Effect.logInfo('Pushed the meta repo', {
        branch,
        commit: sha,
        commitCount: scan.commitCount
      })
      return MetaRepoPushed.make({
        branch,
        remoteUrl,
        commitCount: scan.commitCount
      })
    }).pipe(
      Effect.tapError(logFailure('push')),
      Effect.catch((error) =>
        Effect.succeed(failed(`Could not push the meta repo: ${reason(error)}`))
      )
    )

  const push: Effect.Effect<MetaRepoPushResult> = lock.withPermits(1)(withGit(pushWith))

  return { state, setRemote, push }
})
