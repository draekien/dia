import type { Runs } from '@dia/plugin'
import type { IssuesSnapshot, ObjectiveId } from '@dia-plugin/dia-issues/domain'
import type { Issues } from '@dia-plugin/dia-issues/service'
import { Effect, Option, Ref, type Scope, Semaphore, Stream, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import { AssistantDisabled, type JobTitle } from './domain'
import { type BackendReads, paragraphs, runSettings } from './run-options'
import type { Org } from './service'

/** The label the Executive assistant's run carries in its dia tool scope. */
export const ASSISTANT_LABEL = 'dia-org-assistant'

/** The org's Executive assistant run (ADR-0071, ADR-0080). */
export interface Assistant {
  /** Records that the assistant created objective `objectiveId`, so its changes produce notices. */
  readonly claim: (objectiveId: ObjectiveId) => Effect.Effect<void>
  /**
   * Sends `text`, after the notices gathered since the last request, to the assistant run,
   * starting the run when there is none or it was archived; returns the run's id. Fails while the
   * built-in Executive assistant job title is disabled.
   */
  readonly ask: (text: string) => Effect.Effect<string, AssistantDisabled>
  /** Archives the assistant run and drops pending notices; the next `ask` starts a new run. */
  readonly startOver: Effect.Effect<void>
}

/**
 * What the assistant reads and drives: the org's job titles, the work it reports on, the runs it
 * starts and messages, the backend reads its start options need, the working `directory` of its
 * run, which must exist, and `runId`, where it publishes its run's id (null when it has none).
 */
export interface AssistantDeps {
  readonly org: Pick<Org, 'jobTitles'>
  readonly work: Pick<Issues, 'snapshot' | 'watchChanges'>
  readonly runs: Pick<Runs, 'start' | 'send' | 'list' | 'retire'>
  readonly backend: BackendReads
  readonly directory: string
  readonly runId: SubscriptionRef.SubscriptionRef<string | null>
}

const noticesBetween = (
  previous: IssuesSnapshot,
  current: IssuesSnapshot,
  claimed: ReadonlySet<string>
): ReadonlyArray<string> => {
  const issueNotices = current.issues.flatMap((issue): ReadonlyArray<string> => {
    if (!claimed.has(issue.objectiveId)) return []
    const before = previous.issues.find((entry) => entry.id === issue.id)?.status
    if (before === issue.status) return []
    if (issue.status === 'triage') return [`"${issue.title}" needs triage.`]
    if (issue.status === 'in_review') return [`"${issue.title}" is in review.`]
    return []
  })
  const objectiveNotices = current.objectives.flatMap((objective): ReadonlyArray<string> => {
    if (!claimed.has(objective.id) || objective.state !== 'completed') return []
    const before = previous.objectives.find((entry) => entry.id === objective.id)?.state
    return before === 'completed' ? [] : [`Objective "${objective.title}" is completed.`]
  })
  return [...issueNotices, ...objectiveNotices]
}

/** The built-in Executive assistant job title of `jobTitles` while it is enabled. */
export const enabledAssistantOf = (jobTitles: ReadonlyArray<JobTitle>) =>
  Option.fromNullishOr(
    jobTitles.find((jobTitle) => jobTitle.builtIn === 'executive-assistant' && jobTitle.enabled)
  )

/**
 * Builds the org's Executive assistant inside the calling scope (ADR-0071, ADR-0080). Its run
 * starts on the first `ask`, in `deps.directory`, labelled {@link ASSISTANT_LABEL}, and is kept in
 * the org database across restarts. While the scope is open it gathers a notice each time an
 * issue of an objective it claimed enters `triage` or `in_review`, or such an objective
 * completes, and prefixes them to the next `ask`. Notices are not stored. Closing the scope
 * clears `deps.runId`.
 */
export const makeAssistant = Effect.fn('makeAssistant')(function* (
  deps: AssistantDeps
): Effect.fn.Return<Assistant, never, Scope.Scope | SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const pending = yield* Ref.make<ReadonlyArray<string>>([])
  const lock = yield* Semaphore.make(1)

  const storedRunId = sql<{ readonly run_id: string }>`
    SELECT run_id FROM assistant_run WHERE id = 1`.pipe(
    Effect.orDie,
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.run_id))
  )

  const claim = (objectiveId: ObjectiveId) =>
    sql`INSERT OR IGNORE INTO assistant_objectives (objective_id) VALUES (${objectiveId})`.pipe(
      Effect.orDie,
      Effect.tap(() => Effect.logDebug('Executive assistant claimed an objective', { objectiveId }))
    )

  const liveRun = Effect.gen(function* () {
    const stored = yield* storedRunId
    if (Option.isNone(stored)) return Option.none<string>()
    const runs = yield* deps.runs.list
    const kept = runs.some((run) => run.runId === stored.value && run.status !== 'archived')
    return kept ? stored : Option.none<string>()
  })

  const startRun = Effect.fnUntraced(function* (jobTitle: JobTitle, message: string) {
    const settings = yield* runSettings(
      deps.backend,
      jobTitle,
      deps.directory,
      jobTitle.bypassOptIn
    )
    const runId = yield* deps.runs.start({
      cwd: deps.directory,
      ...settings,
      text: paragraphs(jobTitle.jobDescription, message),
      labels: [ASSISTANT_LABEL]
    })
    yield* sql`INSERT OR REPLACE INTO assistant_run (id, run_id) VALUES (1, ${runId})`.pipe(
      Effect.orDie
    )
    yield* SubscriptionRef.set(deps.runId, runId)
    yield* Effect.logInfo('Executive assistant run started', { runId, model: settings.model })
    return runId
  })

  const ask = (text: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const jobTitle = enabledAssistantOf(yield* deps.org.jobTitles)
        if (Option.isNone(jobTitle)) return yield* new AssistantDisabled()
        const notices = yield* Ref.getAndSet(pending, [])
        const message = [...notices, text].join('\n')
        const existing = yield* liveRun
        if (Option.isNone(existing)) return yield* startRun(jobTitle.value, message)
        yield* deps.runs.send(existing.value, message, 'queue')
        yield* Effect.logInfo('Sent a request to the Executive assistant', {
          runId: existing.value,
          notices: notices.length
        })
        return existing.value
      })
    )

  const startOver = lock.withPermits(1)(
    Effect.gen(function* () {
      yield* Ref.set(pending, [])
      const stored = yield* storedRunId
      if (Option.isSome(stored)) yield* deps.runs.retire(stored.value, 'archived')
      yield* sql`DELETE FROM assistant_run`.pipe(Effect.orDie)
      yield* SubscriptionRef.set(deps.runId, null)
      yield* Effect.logInfo('Executive assistant starts over', {
        archived: Option.getOrNull(stored)
      })
    })
  )

  const claimed = sql<{ readonly objective_id: string }>`
    SELECT objective_id FROM assistant_objectives`.pipe(
    Effect.orDie,
    Effect.map((rows) => new Set(rows.map((row) => row.objective_id)))
  )

  yield* SubscriptionRef.set(deps.runId, Option.getOrNull(yield* liveRun))
  yield* Effect.addFinalizer(() => SubscriptionRef.set(deps.runId, null))
  const previous = yield* Ref.make(yield* deps.work.snapshot)
  const workChanges = yield* deps.work.watchChanges
  yield* workChanges.pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const current = yield* deps.work.snapshot
        const before = yield* Ref.getAndSet(previous, current)
        const notices = noticesBetween(before, current, yield* claimed)
        if (notices.length === 0) return
        yield* Ref.update(pending, (texts) => [...texts, ...notices])
        yield* Effect.logInfo('Executive assistant gathered notices', { notices: notices.length })
      })
    ),
    Effect.forkScoped
  )

  return { claim, ask, startOver } satisfies Assistant
})
