import type { AccountInfo, SDKStartupFailureReason } from '@anthropic-ai/claude-agent-sdk'
import {
  type AdapterStatus,
  HealthError,
  HealthNotChecked,
  HealthNotInstalled,
  HealthNotSignedIn,
  HealthReady,
  HealthUnknown
} from '@dia/plugin'
import {
  Config,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Option,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import type { ClaudeInstall } from './claude-install'
import { messageOf, withIdleQuery } from './idle-query'

/** Longest `claude --version` may take before the check counts it as failed. */
export const VERSION_TIMEOUT = Duration.seconds(10)

/** Longest the account read may take before health is reported as unknown. */
export const ACCOUNT_PROBE_TIMEOUT = Duration.seconds(60)

/** The health message after a session refused to start because Claude Code is too old. */
export const UPDATE_CLAUDE_CODE = 'Update Claude Code'

/** The health message when the stored install path cannot be run. */
export const OVERRIDE_UNRUNNABLE = 'The configured install path cannot be run'

/** {@link probeInstall} could not read the account; `message` says why. */
export class InstallProbeFailed extends Data.TaggedError('InstallProbeFailed')<{
  readonly message: string
}> {}

/**
 * The account the Claude Code install at `path` reports, read in `cwd` by a query that starts no
 * turn. Fails after {@link ACCOUNT_PROBE_TIMEOUT} or when the install cannot answer.
 */
export const probeInstall = (
  path: string,
  cwd: string
): Effect.Effect<AccountInfo, InstallProbeFailed> =>
  withIdleQuery(path, cwd, (idle) =>
    Effect.tryPromise({
      try: () => idle.initializationResult(),
      catch: (cause) => new InstallProbeFailed({ message: messageOf(cause) })
    }).pipe(
      Effect.map((result) => result.account),
      Effect.timeout(ACCOUNT_PROBE_TIMEOUT),
      Effect.catchTag('TimeoutError', () =>
        Effect.fail(
          new InstallProbeFailed({
            message: `Claude Code did not report its account within ${Duration.format(ACCOUNT_PROBE_TIMEOUT)}`
          })
        )
      )
    )
  )

/** The version number in `claude --version` output, such as `2.1.3` in `2.1.3 (Claude Code)`. */
export const parseVersion = (output: string): Option.Option<string> =>
  Option.fromNullishOr(/\d+\.\d+\.\d+[^\s)]*/.exec(output)?.[0])

/**
 * Whether `account` shows no usable sign-in: Anthropic's own API with no subscription, no API
 * key and no other token. A third-party provider (Bedrock, Vertex, a gateway) authenticates
 * outside Claude Code and counts as signed in.
 */
export const isSignedOut = (account: AccountInfo, apiKey: string | undefined): boolean =>
  (account.apiProvider === undefined || account.apiProvider === 'firstParty') &&
  account.tokenSource === 'none' &&
  account.subscriptionType === undefined &&
  account.apiKeySource === undefined &&
  (apiKey === undefined || apiKey === '')

type VersionRead =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string; readonly version?: string }

const versionFailed = (message: string, version: Option.Option<string>): VersionRead =>
  Option.match(version, {
    onNone: () => ({ ok: false, message }),
    onSome: (parsed) => ({ ok: false, message, version: parsed })
  })

/** Health states a check can leave that, on becoming ready, mean the model list may be stale. */
const RECOVERS_MODELS = new Set([
  'HealthNotInstalled',
  'HealthError',
  'HealthUnknown',
  'HealthNotSignedIn'
])

/**
 * The health of the adapter's Claude Code install. Build it with {@link makeClaudeHealth}.
 */
export interface ClaudeHealth {
  /** Streams the current {@link AdapterStatus}, then every change. */
  readonly status: () => Stream.Stream<AdapterStatus>
  /**
   * Checks the install and completes when the check ends. A call during a running check waits
   * for that check instead of starting another.
   */
  readonly check: Effect.Effect<void>
  /**
   * Records why a session's query refused to start. `cli_version_too_old` sets health to
   * `HealthError` {@link UPDATE_CLAUDE_CODE}; other reasons leave health unchanged.
   */
  readonly reportStartupFailure: (reason: SDKStartupFailureReason) => Effect.Effect<void>
}

/**
 * Builds the {@link ClaudeHealth} of `install`, starting in `HealthNotChecked`; it runs no check
 * itself. Checks start their probe query in `cwd`. When a check moves health to `HealthReady`
 * from a failed state, it runs `refreshModels` in the calling scope so a model list that failed
 * meanwhile is read again. `probe` defaults to {@link probeInstall}. Requires
 * `ChildProcessSpawner` for `claude --version`.
 */
export const makeClaudeHealth = Effect.fnUntraced(function* (
  install: ClaudeInstall,
  cwd: string,
  refreshModels: () => Effect.Effect<void>,
  probe: (
    path: string,
    cwd: string
  ) => Effect.Effect<AccountInfo, InstallProbeFailed> = probeInstall
): Effect.fn.Return<ClaudeHealth, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scope = yield* Effect.scope
  const status = yield* SubscriptionRef.make<AdapterStatus>({
    health: HealthNotChecked.make({}),
    checking: false,
    installPathOverride: Option.getOrNull(yield* install.override)
  })
  const running = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none())

  const readVersion = (path: string): Effect.Effect<VersionRead> =>
    Effect.scoped(
      Effect.gen(function* () {
        const command = path.toLowerCase().endsWith('.js')
          ? ChildProcess.make('node', [path, '--version'])
          : ChildProcess.make(path, ['--version'])
        const handle = yield* spawner.spawn(command)
        const [output, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
          { concurrency: 2 }
        )
        return { output: output.trim(), exitCode }
      })
    ).pipe(
      Effect.timeout(VERSION_TIMEOUT),
      Effect.map(({ output, exitCode }): VersionRead => {
        const version = parseVersion(output)
        if (exitCode !== 0) {
          return versionFailed(`claude --version exited with code ${exitCode}: ${output}`, version)
        }
        return Option.match(version, {
          onNone: () => versionFailed(`claude --version printed no version: ${output}`, version),
          onSome: (parsed) => ({ ok: true, version: parsed })
        })
      }),
      Effect.catchTag('TimeoutError', () =>
        Effect.succeed(
          versionFailed(
            `claude --version did not finish within ${Duration.format(VERSION_TIMEOUT)}`,
            Option.none()
          )
        )
      ),
      Effect.catch((error) => Effect.succeed(versionFailed(error.message, Option.none())))
    )

  const inspect = Effect.gen(function* () {
    const resolved = yield* install.resolve
    const override = yield* install.override
    const checkedAt = yield* DateTime.now
    if (Option.isNone(resolved)) {
      return Option.match(override, {
        onNone: () => HealthNotInstalled.make({ checkedAt }),
        onSome: (installPath) =>
          HealthError.make({ message: OVERRIDE_UNRUNNABLE, installPath, checkedAt })
      })
    }
    const installPath = resolved.value
    const version = yield* readVersion(installPath)
    if (!version.ok) {
      return HealthError.make({
        message: version.message,
        ...(version.version !== undefined ? { version: version.version } : {}),
        installPath,
        checkedAt
      })
    }
    const account = yield* Effect.result(probe(installPath, cwd))
    if (account._tag === 'Failure') {
      return HealthUnknown.make({
        message: account.failure.message,
        version: version.version,
        installPath,
        checkedAt
      })
    }
    const apiKey = yield* Config.String('ANTHROPIC_API_KEY').pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>())
    )
    if (isSignedOut(account.success, Option.getOrUndefined(apiKey))) {
      return HealthNotSignedIn.make({ version: version.version, installPath, checkedAt })
    }
    return HealthReady.make({
      version: version.version,
      installPath,
      checkedAt,
      ...(account.success.email !== undefined ? { email: account.success.email } : {}),
      ...(account.success.subscriptionType !== undefined
        ? { subscriptionType: account.success.subscriptionType }
        : {})
    })
  })

  const runCheck = Effect.gen(function* () {
    yield* SubscriptionRef.update(status, (current) => ({ ...current, checking: true }))
    const health = yield* inspect
    const installPathOverride = Option.getOrNull(yield* install.override)
    const previous = yield* SubscriptionRef.modify(status, (current) => [
      current.health,
      { health, checking: false, installPathOverride }
    ])
    yield* Effect.logInfo('Checked the Claude Code install', {
      from: previous._tag,
      to: health._tag
    })
    if (health._tag === 'HealthReady' && RECOVERS_MODELS.has(previous._tag)) {
      yield* Effect.logInfo('Claude Code became ready; re-reading the model list')
      yield* Effect.forkIn(refreshModels(), scope)
    }
  })

  const check = Effect.gen(function* () {
    const mine = yield* Deferred.make<void>()
    const current = yield* Ref.modify(running, (held) =>
      Option.isSome(held) ? [held.value, held] : [mine, Option.some(mine)]
    )
    if (current !== mine) return yield* Deferred.await(current)
    yield* runCheck.pipe(
      Effect.ensuring(
        Ref.set(running, Option.none()).pipe(Effect.andThen(Deferred.succeed(mine, undefined)))
      )
    )
  })

  const reportStartupFailure = (reason: SDKStartupFailureReason) =>
    Effect.gen(function* () {
      yield* Effect.logWarning('A Claude Code session refused to start', { reason })
      if (reason !== 'cli_version_too_old') return
      const checkedAt = yield* DateTime.now
      const installPath = Option.getOrUndefined(yield* install.resolve)
      yield* SubscriptionRef.update(status, (current) => ({
        ...current,
        health: HealthError.make({
          message: UPDATE_CLAUDE_CODE,
          ...(installPath !== undefined ? { installPath } : {}),
          checkedAt
        })
      }))
    })

  return { status: () => SubscriptionRef.changes(status), check, reportStartupFailure }
})
