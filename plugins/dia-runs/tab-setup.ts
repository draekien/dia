import {
  errorMessage,
  type GitOps,
  type IncludedFileFailure,
  PaneEvents,
  type PaneId,
  TabSetup,
  type WorktreeInfo
} from '@dia/plugin'
import { Duration, Effect, Exit, Option, Predicate, Ref, type Scope } from 'effect'

const { CopySetupStep, SessionSetupStep, WorktreeSetupStep } = TabSetup
type CopySetupStep = TabSetup.CopySetupStep
type SessionSetupStep = TabSetup.SessionSetupStep
type SetupStep = TabSetup.SetupStep
type WorktreeSetupStep = TabSetup.WorktreeSetupStep

interface Steps {
  readonly worktree: WorktreeSetupStep
  readonly copy: CopySetupStep | undefined
  readonly session: SessionSetupStep
}

const stepList = ({ worktree, copy, session }: Steps): ReadonlyArray<SetupStep> =>
  copy === undefined ? [worktree, session] : [worktree, copy, session]

const SESSION_START_FAILED = 'The Claude Code session could not be started.'

const errorText = (error: unknown): string =>
  errorMessage(Predicate.hasProperty(error, 'cause') ? error.cause : error)

const copyNotice = (copy: CopySetupStep): Option.Option<string> => {
  if (copy.matchError !== undefined) {
    return Option.some(`Could not match the .worktreeinclude files: ${copy.matchError}`)
  }
  const failed = copy.files.filter((file) => file.error !== undefined)
  if (failed.length === 0) return Option.none()
  const list = failed.map((file) => `${file.path} — ${file.error}`).join('; ')
  return Option.some(
    `Copied ${copy.files.length - failed.length} of ${copy.files.length} .worktreeinclude files. Not copied: ${list}`
  )
}

const withFailures = (
  files: ReadonlyArray<string>,
  failures: ReadonlyArray<IncludedFileFailure>
): CopySetupStep['files'] => {
  const reasons = new Map(failures.map((failure) => [failure.path, failure.reason]))
  return files.map((path) => {
    const error = reasons.get(path)
    return error === undefined ? { path } : { path, error }
  })
}

/**
 * The setup of one worktree tab after its worktree is ready: `worktree` is where the tab runs.
 * Wrap the session start in `startSession` to report it as the last setup step; it then reports a
 * copy warning, if any, as a transcript notice. Call `failSession` when the started session turns
 * out to have no conversation to resume.
 */
export interface WorktreeTabSetup {
  readonly worktree: WorktreeInfo
  readonly startSession: <A, E, R>(start: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly failSession: (error: string) => Effect.Effect<void>
}

/** What {@link setUpWorktreeTab} needs to set up one worktree tab. */
export interface WorktreeTabSetupOptions<E> {
  readonly paneId: PaneId
  readonly sourceRepo: string
  readonly reattach: boolean
  readonly gitOps: GitOps
  readonly acquire: Effect.Effect<WorktreeInfo, E, Scope.Scope>
  readonly emit: (event: PaneEvents.IpcEvent) => Effect.Effect<void>
}

/**
 * Sets up a worktree tab and reports each step to `emit` as a {@link PaneSetupProgress}: creates
 * or reattaches the worktree with `acquire` (its release stays in the caller's scope), then copies
 * the files the project's `.worktreeinclude` matches. The copy step is left out when the project
 * has no `.worktreeinclude`. Fails with `acquire`'s error, after reporting the worktree step as
 * failed; a copy failure never fails it.
 */
export const setUpWorktreeTab = Effect.fn('TabSetup.setUpWorktreeTab')(function* <E>(
  options: WorktreeTabSetupOptions<E>
) {
  const { paneId, sourceRepo, reattach, gitOps, acquire, emit } = options
  const included = yield* gitOps.findIncludedFiles(sourceRepo, paneId).pipe(Effect.result)
  const copy =
    included._tag === 'Failure'
      ? CopySetupStep.make({ state: 'pending', files: [], matchError: errorText(included.failure) })
      : Option.match(included.success, {
          onNone: () => undefined,
          onSome: (files) =>
            CopySetupStep.make({ state: 'pending', files: files.map((path) => ({ path })) })
        })
  const steps = yield* Ref.make<Steps>({
    worktree: WorktreeSetupStep.make({ reattach, state: 'running' }),
    copy,
    session: SessionSetupStep.make({ state: 'pending' })
  })
  const update = (change: (current: Steps) => Steps) =>
    Ref.updateAndGet(steps, change).pipe(
      Effect.flatMap((next) =>
        emit(PaneEvents.PaneSetupProgress.make({ paneId, steps: stepList(next) }))
      )
    )
  yield* update((current) => current)

  const [worktreeDuration, acquired] = yield* Effect.timed(Effect.exit(acquire))
  const worktreeDurationMs = Duration.toMillis(worktreeDuration)
  if (Exit.isFailure(acquired)) {
    const error = Option.match(Exit.findErrorOption(acquired), {
      onNone: () => 'The worktree could not be set up',
      onSome: errorText
    })
    yield* update((current) => ({
      ...current,
      worktree: WorktreeSetupStep.make({
        reattach,
        state: 'failed',
        durationMs: worktreeDurationMs,
        error
      })
    }))
    return yield* Effect.failCause(acquired.cause)
  }
  const worktree = acquired.value
  yield* update((current) => ({
    ...current,
    worktree: WorktreeSetupStep.make({
      reattach,
      state: 'done',
      branch: worktree.branch,
      durationMs: worktreeDurationMs
    })
  }))

  if (copy !== undefined) {
    yield* update((current) => ({ ...current, copy: { ...copy, state: 'running' } }))
    const paths = copy.files.map((file) => file.path)
    const [duration, finished] = yield* Effect.timed(
      copy.matchError === undefined
        ? gitOps.copyIncludedFiles(worktree, paths, paneId).pipe(
            Effect.map(
              (failures): CopySetupStep => ({
                ...copy,
                state: failures.length === 0 ? 'done' : 'warning',
                files: withFailures(paths, failures)
              })
            )
          )
        : Effect.succeed<CopySetupStep>({ ...copy, state: 'warning' })
    )
    yield* update((current) => ({
      ...current,
      copy: { ...finished, durationMs: Duration.toMillis(duration) }
    }))
  }

  const startSession = <A, E2, R>(start: Effect.Effect<A, E2, R>) =>
    Effect.gen(function* () {
      yield* update((current) => ({
        ...current,
        session: SessionSetupStep.make({ state: 'running' })
      }))
      const [duration, started] = yield* Effect.timed(start).pipe(
        Effect.onError(() => failSession(SESSION_START_FAILED))
      )
      const next = yield* Ref.get(steps)
      yield* update((current) => ({
        ...current,
        session: SessionSetupStep.make({ state: 'done', durationMs: Duration.toMillis(duration) })
      }))
      const notice = next.copy === undefined ? Option.none() : copyNotice(next.copy)
      if (Option.isSome(notice)) {
        yield* Effect.logWarning('Recorded the copy warning in the transcript', { paneId })
        yield* emit(PaneEvents.PaneSessionNotice.make({ paneId, text: notice.value }))
      }
      return started
    })

  const failSession = (error: string) =>
    update((current) => ({
      ...current,
      session: SessionSetupStep.make({ ...current.session, state: 'failed', error })
    }))

  const setup: WorktreeTabSetup = { worktree, startSession, failSession }
  return setup
})
