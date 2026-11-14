import { RESUME_TEXT, type RunInfo, type Runs, type StartRunOptions } from '@dia/plugin'
import type { Issue, IssueId, Objective, ObjectivePriority } from '@dia-plugin/dia-issues/domain'
import {
  type Issues,
  IssueToolContext,
  type ProviderIssues,
  type StartableIssue
} from '@dia-plugin/dia-issues/service'
import type { RunQueue } from '@dia-plugin/dia-run-queue/queue'
import { Effect, Option, Queue, Ref, type Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import type { HiredAgent, HireId, JobTitle } from './domain'
import type { IssueWorkspace } from './issue-workspace'
import type { Org } from './service'

/** The label every run of an org issue carries in its dia tool scope. */
export const ISSUE_RUN_LABEL = 'dia-org-issue'

/**
 * How a hire's run of an issue starts: `run`, the options it starts with, and
 * `projectDirectory`, the directory of the issue's project, whose group shows the run's tab.
 */
export interface IssueStart {
  readonly run: StartRunOptions
  readonly projectDirectory: string
}

/** How a hire's run of an issue starts, or none while it cannot start yet. */
export type StartOptionsOf = (
  issue: Issue,
  objective: Objective,
  hire: HiredAgent,
  jobTitle: JobTitle
) => Effect.Effect<Option.Option<IssueStart>>

/** The live runs of org issues. */
export interface IssueRuns {
  /** Sends `text` to issue `issueId`'s live run as a queued message; false when it has none. */
  readonly deliver: (issueId: IssueId, text: string) => Effect.Effect<boolean>
}

/** What {@link runIssues} reads and drives. */
export interface IssueRunsDeps {
  readonly org: Pick<Org, 'jobTitles' | 'hiredAgents' | 'watchJobTitleChanges' | 'watchHireChanges'>
  readonly issues: Pick<Issues, 'watchChanges'>
  readonly provider: Pick<ProviderIssues, 'runState' | 'markStarted'>
  readonly workspace: Pick<IssueWorkspace, 'retain'>
  readonly startOptions: StartOptionsOf
  readonly runs: Pick<Runs, 'list' | 'isLive' | 'send' | 'close' | 'openInTab'>
  readonly queue: Pick<RunQueue, 'enqueue'>
  /** Completes when the first pass may run: once the Host's startup has settled. */
  readonly ready: Effect.Effect<void>
}

interface IssueRunRow {
  readonly issue_id: string
  readonly hire_id: string
  readonly run_id: string
}

const PRIORITY: Record<ObjectivePriority, number> = { high: 1, normal: 0, low: -1 }

const startableFor = (startable: ReadonlyArray<StartableIssue>) =>
  new Map(startable.map((entry) => [entry.issue.id as string, entry] as const))

/**
 * Starts each `todo` issue assigned to a hire as a run through the run queue, one busy run per
 * hire, and keeps the runs in step with the issues (`docs/designs/dia-org.md`, D1–D4). An issue
 * whose earlier run for the same hire still exists reuses it; a run whose issue is no longer
 * started or startable for its hire is closed. Passes run one at a time, after `deps.ready` and
 * after each change of issues, hires or job titles. Closing the calling scope interrupts every
 * start that has not been picked from the queue.
 */
export const runIssues = Effect.fn('Org.runIssues')(function* (
  deps: IssueRunsDeps
): Effect.fn.Return<IssueRuns, never, Scope.Scope | SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const inFlight = yield* Ref.make<ReadonlySet<string>>(new Set())
  const signals = yield* Queue.sliding<void>(1)
  const signal = Queue.offer(signals, undefined).pipe(Effect.asVoid)

  const rows = sql<IssueRunRow>`SELECT issue_id, hire_id, run_id FROM issue_runs`.pipe(Effect.orDie)
  const saveRow = (issueId: IssueId, hireId: HireId, runId: string) =>
    sql`INSERT OR REPLACE INTO issue_runs ${sql.insert({
      issue_id: issueId,
      hire_id: hireId,
      run_id: runId
    })}`.pipe(Effect.orDie)
  const deleteRow = (issueId: string) =>
    sql`DELETE FROM issue_runs WHERE issue_id = ${issueId}`.pipe(Effect.orDie)
  const setInFlight = (issueId: string, held: boolean) =>
    Ref.update(inFlight, (current) => {
      const next = new Set(current)
      if (held) next.add(issueId)
      else next.delete(issueId)
      return next
    })

  const closeRun = Effect.fnUntraced(function* (row: IssueRunRow, info: RunInfo | undefined) {
    if (info?.live === true) yield* deps.runs.close(row.run_id)
    yield* deleteRow(row.issue_id)
    yield* Effect.logInfo('Closed the run of an issue that is no longer started', {
      issueId: row.issue_id,
      runId: row.run_id
    })
  })

  const showRun = (issueId: IssueId, runId: string, projectDirectory: string) =>
    deps.runs.openInTab(runId, { projectDirectory, select: false }).pipe(
      Effect.andThen(Effect.logInfo('Showed the run of an issue in a tab', { issueId, runId })),
      Effect.catchTag('RunNotFoundError', () =>
        Effect.logWarning('No run to show for an issue', { issueId, runId })
      )
    )

  const enqueueRun = Effect.fnUntraced(function* (
    entry: StartableIssue,
    hire: HiredAgent,
    jobTitle: JobTitle
  ) {
    const { issue, objective } = entry
    const options = yield* deps.startOptions(issue, objective, hire, jobTitle)
    if (Option.isNone(options)) return false
    const context = IssueToolContext.make({ issueId: issue.id, assigneeId: hire.id })
    const runId = yield* deps.queue.enqueue({
      run: { ...options.value.run, labels: [ISSUE_RUN_LABEL], context },
      priority: PRIORITY[objective.priority],
      key: { id: hire.id, limit: 1 }
    })
    yield* saveRow(issue.id, hire.id, runId)
    if (yield* deps.provider.markStarted(issue.id, hire.id)) {
      yield* Effect.logInfo('Started a run of an issue', { issueId: issue.id, runId })
      yield* showRun(issue.id, runId, options.value.projectDirectory)
      return true
    }
    yield* deps.runs.close(runId)
    yield* deleteRow(issue.id)
    yield* Effect.logInfo('Closed a run whose issue changed while it was queued', {
      issueId: issue.id,
      runId
    })
    return true
  })

  const startIssue = (entry: StartableIssue, hire: HiredAgent, jobTitle: JobTitle) =>
    Effect.gen(function* () {
      yield* setInFlight(entry.issue.id, true)
      yield* Effect.logInfo('Queued a run of an issue', {
        issueId: entry.issue.id,
        hireId: hire.id
      })
      yield* enqueueRun(entry, hire, jobTitle).pipe(
        Effect.catchCause((cause) =>
          Effect.logError('Could not start a run of an issue', cause).pipe(Effect.as(false))
        ),
        Effect.ensuring(setInFlight(entry.issue.id, false)),
        Effect.flatMap((enqueued) => (enqueued ? signal : Effect.void)),
        Effect.forkScoped
      )
    })

  const reuseRun = Effect.fnUntraced(function* (
    issue: Issue,
    hire: HiredAgent,
    row: IssueRunRow,
    info: RunInfo
  ) {
    const resumed = info.status === 'idle'
    if (resumed) yield* deps.runs.send(row.run_id, RESUME_TEXT, 'queue')
    const started = yield* deps.provider.markStarted(issue.id, hire.id)
    yield* Effect.logInfo('Reused the run of an issue', {
      issueId: issue.id,
      runId: row.run_id,
      resumed,
      started
    })
  })

  const pass = Effect.gen(function* () {
    const held = yield* Ref.get(inFlight)
    const { startable, started } = yield* deps.provider.runState
    const runInfos = new Map((yield* deps.runs.list).map((info) => [info.runId, info] as const))
    const waiting = startableFor(startable)
    const startedIds = new Set<string>(started.map((issue) => issue.id))
    const stored = new Map<string, IssueRunRow>()
    for (const row of yield* rows) {
      const info = runInfos.get(row.run_id)
      const forHire = waiting.get(row.issue_id)?.issue.assignee?.id === row.hire_id
      const gone = info === undefined || info.status === 'archived'
      const isStarted = startedIds.has(row.issue_id)
      if (gone || (!isStarted && !forHire)) {
        if (!held.has(row.issue_id)) yield* closeRun(row, info)
        continue
      }
      if (!isStarted) stored.set(row.issue_id, row)
    }
    yield* deps.workspace.retain(new Set([...waiting.keys(), ...startedIds] as Array<IssueId>))
    const hires = new Map((yield* deps.org.hiredAgents).map((hire) => [hire.id as string, hire]))
    const jobTitles = new Map((yield* deps.org.jobTitles).map((title) => [title.id, title]))
    for (const entry of startable) {
      if (held.has(entry.issue.id)) continue
      const hire = entry.issue.assignee === null ? undefined : hires.get(entry.issue.assignee.id)
      if (hire === undefined) continue
      const jobTitle = jobTitles.get(hire.jobTitleId)
      if (jobTitle === undefined) {
        yield* Effect.logWarning('Skipped the issue of a hire whose job title is not listed', {
          issueId: entry.issue.id,
          hireId: hire.id
        })
        continue
      }
      const row = stored.get(entry.issue.id)
      const info = row === undefined ? undefined : runInfos.get(row.run_id)
      if (row !== undefined && info !== undefined) {
        yield* reuseRun(entry.issue, hire, row, info)
      } else {
        yield* startIssue(entry, hire, jobTitle)
      }
    }
    yield* Effect.logDebug('Org run pass', {
      startable: startable.length,
      started: started.length,
      inFlight: held.size
    })
  })

  const deliver = Effect.fn('IssueRuns.deliver')(function* (issueId: IssueId, text: string) {
    const [row] =
      yield* sql<IssueRunRow>`SELECT issue_id, hire_id, run_id FROM issue_runs WHERE issue_id = ${issueId}`.pipe(
        Effect.orDie
      )
    const live = row !== undefined && (yield* deps.runs.isLive(row.run_id))
    if (!live) {
      yield* Effect.logInfo('No live run to message', { issueId })
      return false
    }
    yield* deps.runs.send(row.run_id, text, 'queue')
    yield* Effect.logInfo('Queued a message for the run of an issue', { issueId })
    return true
  })

  const changes = Stream.mergeAll(
    [
      yield* deps.issues.watchChanges,
      yield* deps.org.watchHireChanges,
      yield* deps.org.watchJobTitleChanges
    ],
    { concurrency: 'unbounded' }
  )
  yield* changes.pipe(
    Stream.runForEach(() => signal),
    Effect.forkScoped
  )
  yield* deps.ready.pipe(
    Effect.andThen(signal),
    Effect.andThen(
      Queue.take(signals).pipe(
        Effect.andThen(pass),
        Effect.catchCause((cause) => Effect.logError('Org run pass failed', cause)),
        Effect.forever
      )
    ),
    Effect.forkScoped
  )
  return { deliver }
})
