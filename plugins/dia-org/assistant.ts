import { AgentName, PaneChat, type RunRequest, type Runs } from '@dia/plugin'
import { type RunChoices, runSettings } from '@dia-plugin/dia-agent-definitions/run-settings'
import type { IssuesSnapshot, ObjectiveId } from '@dia-plugin/dia-issues/domain'
import type { Issues } from '@dia-plugin/dia-issues/service'
import { Effect, Option, Ref, type Scope, Semaphore, Stream, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import { AssistantDisabled, type JobTitle, NoAgentAdapter } from './domain'
import type { Org } from './service'

/** The label the Executive assistant's run carries in its dia tool scope. */
export const ASSISTANT_LABEL = 'dia-org-assistant'

/** The name of the Executive assistant's tab, which the sidebar's Assistant entry selects. */
export const ASSISTANT_TAB_NAME = AgentName.make('Assistant')

/** The org's Executive assistant run (ADR-0071, ADR-0080). */
export interface Assistant {
  /** Records that the assistant created objective `objectiveId`, so its changes produce notices. */
  readonly claim: (objectiveId: ObjectiveId) => Effect.Effect<void>
  /**
   * Sends `text`, after the notices gathered since the last request, to the assistant run,
   * starting the run when there is none or it was archived; returns the run's id. Fails while the
   * built-in Executive assistant job title is disabled, and with `NoAgentAdapter` when a run has
   * to start and no model can be chosen.
   */
  readonly ask: (text: string) => Effect.Effect<string, AssistantDisabled | NoAgentAdapter>
  /**
   * Returns the assistant run's id, starting a run that waits for its first message when there is
   * none or it was archived. Fails while the built-in Executive assistant job title is disabled, and
   * with `NoAgentAdapter` when the run has to start and no model can be chosen.
   */
  readonly open: Effect.Effect<string, AssistantDisabled | NoAgentAdapter>
  /** Archives the assistant run and drops pending notices; the next `ask` starts a new run. */
  readonly startOver: Effect.Effect<void>
}

/**
 * What the assistant reads and drives: the org's job titles, the work it reports on, the runs it
 * starts and messages, the choices its start options are made from, the working `directory` of its
 * run, which must exist and which only the assistant's tab uses, and `runId`, where it publishes
 * its run's id (null when it has none).
 */
export interface AssistantDeps {
  readonly org: Pick<Org, 'jobTitles'>
  readonly work: Pick<Issues, 'snapshot' | 'watchChanges'>
  readonly runs: Pick<
    Runs,
    'start' | 'send' | 'list' | 'retire' | 'openInTab' | 'isLive' | 'busy' | 'requests'
  >
  readonly choices: RunChoices
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

interface RunActivity {
  readonly busy: ReadonlyArray<string>
  readonly requests: ReadonlyArray<RunRequest>
}

/**
 * Builds the org's Executive assistant inside the calling scope (ADR-0071, ADR-0080, ADR-0082).
 * Its run starts on the first `ask` or `open`, in `deps.directory`, labelled
 * {@link ASSISTANT_LABEL}, with its job description in the system prompt, and is kept in
 * the org database across restarts; its tab, named {@link ASSISTANT_TAB_NAME}, belongs to the org
 * along with its directory's project. While the scope is open it gathers a notice each time an
 * issue of an objective it claimed enters `triage` or `in_review`, or such an objective
 * completes. It sends the gathered notices to its run as one message, marked
 * `PaneChat.NOTICE_MARKER`, as soon as the run is live, has no turn or background task and no
 * open request; until then the next `ask` takes them. Notices are not stored. Closing the scope
 * clears `deps.runId`.
 */
export const makeAssistant = Effect.fn('makeAssistant')(function* (
  deps: AssistantDeps
): Effect.fn.Return<Assistant, never, Scope.Scope | SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const pending = yield* Ref.make<ReadonlyArray<string>>([])
  const lock = yield* Semaphore.make(1)
  const activity = yield* Ref.make(Option.none<RunActivity>())

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

  const showTab = (runId: string) =>
    deps.runs
      .openInTab(runId, {
        projectDirectory: deps.directory,
        select: false,
        owner: { plugin: 'dia-org', ownsProject: true },
        name: ASSISTANT_TAB_NAME
      })
      .pipe(
        Effect.andThen(Effect.logDebug('Showed the Executive assistant run in a tab', { runId })),
        Effect.catchTag('RunNotFoundError', () =>
          Effect.logWarning('No Executive assistant run to show', { runId })
        )
      )

  const isIdle = Effect.fnUntraced(function* (runId: string) {
    const current = yield* Ref.get(activity)
    if (Option.isNone(current)) return false
    const { busy, requests } = current.value
    if (busy.includes(runId) || requests.some((request) => request.runId === runId)) return false
    return yield* deps.runs.isLive(runId)
  })

  const sendPendingNotices = lock.withPermits(1)(
    Effect.gen(function* () {
      const notices = yield* Ref.get(pending)
      const runId = yield* SubscriptionRef.get(deps.runId)
      if (notices.length === 0 || runId === null || !(yield* isIdle(runId))) return
      yield* deps.runs.send(runId, `${PaneChat.NOTICE_MARKER}${notices.join('\n')}`, 'queue')
      yield* Ref.update(pending, (texts) => texts.slice(notices.length))
      yield* Effect.logInfo('Sent notices to the idle Executive assistant', {
        runId,
        notices: notices.length
      })
    })
  )

  const deliverNotices = Effect.flatMap(Ref.get(pending), (notices) =>
    notices.length === 0 ? Effect.void : sendPendingNotices
  )

  const startRun = Effect.fnUntraced(function* (jobTitle: JobTitle, message: string | undefined) {
    const chosen = yield* runSettings(deps.choices, jobTitle, deps.directory, jobTitle.bypassOptIn)
    if (Option.isNone(chosen)) return yield* new NoAgentAdapter()
    const settings = chosen.value
    const runId = yield* deps.runs.start({
      cwd: deps.directory,
      ...settings,
      ...(message === undefined ? {} : { text: message }),
      systemPromptAppend: jobTitle.jobDescription,
      permissions: jobTitle.permissions,
      labels: [ASSISTANT_LABEL]
    })
    yield* sql`INSERT OR REPLACE INTO assistant_run (id, run_id) VALUES (1, ${runId})`.pipe(
      Effect.orDie
    )
    yield* SubscriptionRef.set(deps.runId, runId)
    yield* showTab(runId)
    yield* Effect.logInfo('Executive assistant run started', {
      runId,
      model: settings.model,
      sent: message !== undefined
    })
    return runId
  })

  const ask = (text: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const jobTitle = enabledAssistantOf(yield* deps.org.jobTitles)
        if (Option.isNone(jobTitle)) return yield* new AssistantDisabled()
        const notices = yield* Ref.get(pending)
        const message = [...notices, text].join('\n')
        const delivered = Ref.update(pending, (texts) => texts.slice(notices.length))
        const existing = yield* liveRun
        if (Option.isNone(existing)) {
          return yield* startRun(jobTitle.value, message).pipe(Effect.tap(() => delivered))
        }
        yield* deps.runs.send(existing.value, message, 'queue')
        yield* delivered
        yield* Effect.logInfo('Sent a request to the Executive assistant', {
          runId: existing.value,
          notices: notices.length
        })
        return existing.value
      })
    )

  const open = lock.withPermits(1)(
    Effect.gen(function* () {
      const jobTitle = enabledAssistantOf(yield* deps.org.jobTitles)
      if (Option.isNone(jobTitle)) return yield* new AssistantDisabled()
      const existing = yield* liveRun
      if (Option.isSome(existing)) return existing.value
      return yield* startRun(jobTitle.value, undefined)
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

  const kept = yield* liveRun
  yield* SubscriptionRef.set(deps.runId, Option.getOrNull(kept))
  if (Option.isSome(kept)) yield* showTab(kept.value)
  yield* Effect.addFinalizer(() => SubscriptionRef.set(deps.runId, null))
  yield* Stream.zipLatest(deps.runs.busy, deps.runs.requests).pipe(
    Stream.runForEach(([busy, requests]) =>
      Ref.set(activity, Option.some({ busy, requests })).pipe(Effect.andThen(deliverNotices))
    ),
    Effect.forkScoped
  )
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
        yield* deliverNotices
      })
    ),
    Effect.forkScoped
  )

  return { claim, ask, open, startOver } satisfies Assistant
})
