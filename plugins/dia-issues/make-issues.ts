import { type ProjectId, type SessionId, Uuid } from '@dia/plugin'
import {
  type Array as Arr,
  Clock,
  Crypto,
  Deferred,
  Effect,
  PubSub,
  Ref,
  Schema,
  type Scope,
  Stream
} from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import {
  AssigneeGroup,
  AssigneeNotFound,
  AssigneeProviderTaken,
  AssigneeRef,
  type CommentBody,
  CommentId,
  type FirstIssue,
  Issue,
  type IssueChange,
  IssueClosed,
  IssueComment,
  IssueId,
  IssueNotAssignable,
  IssueNotFound,
  IssueNotInTriage,
  IssueNotStarted,
  type IssueStatus,
  IssuesSnapshot,
  isAssignable,
  isClosed,
  isStarted,
  ListedAssignee,
  type NewObjective,
  type NewWorkIssue,
  Objective,
  type ObjectiveId,
  ObjectiveNotFound,
  ProjectNotFound,
  type ProposedIssue,
  type ProviderId,
  type Refusal,
  StartedStatus,
  sameAssignee,
  type TriageDecision
} from './domain'
import { type IssueToolWork, makeIssueTools } from './issue-tools'
import type { AssigneeProvider, ImportedWork, Issues, ProviderIssues } from './service'
import {
  commentRow,
  decodeCommentRows,
  decodeIssueRows,
  decodeObjectiveRows,
  encodeEvent,
  type IssueEvent,
  IssueEvents,
  issueRow,
  objectiveRow,
  toComment,
  toIssue,
  toObjective
} from './store'

const REQUEUEABLE_STATUSES = StartedStatus.literals.filter((status) => status !== 'in_review')

const TRIAGE_TARGET: Record<TriageDecision, IssueStatus> = { accept: 'todo', decline: 'canceled' }

const sameAssignees = Schema.toEquivalence(Schema.Array(ListedAssignee))

interface HeldProvider {
  readonly label: string
  readonly assignees: ReadonlyArray<ListedAssignee>
}

/**
 * Builds the {@link Issues} over the `issues` plugin's database, which `issuesMigrations` must
 * already have migrated. `projectExists` says whether a project is registered now. Call it once in
 * the plugin's setup.
 */
export const makeIssues = (projectExists: (projectId: ProjectId) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto

    const changes = yield* PubSub.unbounded<void>()
    const publishChange = PubSub.publish(changes, undefined)
    const providers = yield* Ref.make<ReadonlyMap<ProviderId, HeldProvider>>(new Map())

    const inTransaction = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
      sql.withTransaction(effect).pipe(Effect.catchTag('SqlError', Effect.die))
    const transaction = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
      inTransaction(effect).pipe(Effect.tap(() => publishChange))
    const orDie = <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
      effect.pipe(Effect.catchTag('SqlError', Effect.die))

    const newUuid = crypto.randomUUIDv4().pipe(Effect.orDie)
    const started = sql.in('status', StartedStatus.literals)
    const requeueable = sql.in('status', REQUEUEABLE_STATUSES)

    const append = (objectiveId: ObjectiveId, issueId: IssueId | null, event: IssueEvent) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* sql`INSERT INTO issue_events ${sql.insert({
          at,
          objective_id: objectiveId,
          issue_id: issueId,
          event: encodeEvent(event)
        })}`
      })

    const findObjective = Effect.fnUntraced(function* (objectiveId: ObjectiveId) {
      const rows = yield* sql`SELECT * FROM objectives WHERE objective_id = ${objectiveId}`
      const [row] = yield* decodeObjectiveRows(rows)
      return row === undefined ? undefined : toObjective(row)
    })

    const findIssue = Effect.fnUntraced(function* (issueId: IssueId) {
      const rows = yield* sql`SELECT * FROM issues WHERE issue_id = ${issueId}`
      const [row] = yield* decodeIssueRows(rows)
      return row === undefined ? undefined : toIssue(row)
    })

    const requireIssue = Effect.fnUntraced(function* (issueId: IssueId, objectiveId?: ObjectiveId) {
      const issue = yield* findIssue(issueId)
      if (issue === undefined || (objectiveId !== undefined && issue.objectiveId !== objectiveId)) {
        return yield* IssueNotFound.make({ issueId })
      }
      return issue
    })

    const objectiveOf = (fromIssueId: IssueId) =>
      Effect.map(requireIssue(fromIssueId), (issue) => issue.objectiveId)

    const ensureParent = Effect.fnUntraced(function* (
      objectiveId: ObjectiveId,
      parentIssueId: IssueId | null
    ) {
      if (parentIssueId !== null) yield* requireIssue(parentIssueId, objectiveId)
    })

    const ensureAssignee = Effect.fnUntraced(function* (assignee: AssigneeRef | null) {
      if (assignee === null) return
      const held = (yield* Ref.get(providers)).get(assignee.provider)
      if (held?.assignees.some((listed) => listed.id === assignee.id) !== true) {
        yield* Effect.logWarning('Refused an assignee no held provider lists', { assignee })
        return yield* AssigneeNotFound.make({ assignee })
      }
    })

    const insertIssue = Effect.fnUntraced(function* (issue: Issue) {
      yield* sql`INSERT INTO issues ${sql.insert(issueRow(issue))}`
      yield* append(issue.objectiveId, issue.id, IssueEvents.IssueCreated.make({ issue }))
    })

    const setIssueStatus = (issueId: IssueId, status: IssueStatus) =>
      sql`UPDATE issues SET status = ${status}, refusal = NULL WHERE issue_id = ${issueId}`

    const completeObjectiveIfDone = Effect.fnUntraced(function* (objectiveId: ObjectiveId) {
      const [counts] = yield* sql<{
        readonly total: number
        readonly open: number
      }>`SELECT count(*) AS total, count(*) FILTER (WHERE status NOT IN ('done', 'canceled')) AS open
        FROM issues WHERE objective_id = ${objectiveId}`
      if (counts !== undefined && counts.total > 0 && counts.open === 0) {
        yield* sql`UPDATE objectives SET state = 'completed' WHERE objective_id = ${objectiveId}`
        yield* append(objectiveId, null, IssueEvents.ObjectiveCompleted.make({}))
        yield* Effect.logInfo('Completed objective', { objectiveId })
      }
    })

    const snapshot = Effect.gen(function* () {
      const objectives = yield* decodeObjectiveRows(
        yield* sql`SELECT * FROM objectives ORDER BY created_at, rowid`
      )
      const issues = yield* decodeIssueRows(
        yield* sql`SELECT * FROM issues ORDER BY created_at, rowid`
      )
      const comments = yield* decodeCommentRows(
        yield* sql`SELECT * FROM issue_comments ORDER BY created_at, rowid`
      )
      return IssuesSnapshot.make({
        objectives: objectives.map(toObjective),
        issues: issues.map(toIssue),
        comments: comments.map(toComment)
      })
    }).pipe(orDie)

    const providerGroups = Effect.map(Ref.get(providers), (held) =>
      [...held.entries()]
        .map(([provider, { label, assignees }]) =>
          AssigneeGroup.make({ provider, label, assignees })
        )
        .sort((left, right) => left.label.localeCompare(right.label))
    )

    const createObjective = Effect.fn('Issues.createObjective')(function* (
      input: NewObjective,
      firstIssues: ReadonlyArray<FirstIssue>
    ) {
      const createdAt = yield* Clock.currentTimeMillis
      const ids = yield* Effect.forEach(firstIssues, () =>
        Effect.all({
          id: Effect.map(newUuid, IssueId.make),
          paneId: Effect.map(newUuid, Uuid.make)
        })
      )
      const registered = yield* projectExists(input.projectId)
      const objective = yield* transaction(
        Effect.gen(function* () {
          const stored = yield* findObjective(input.id)
          if (stored !== undefined) return stored
          if (!registered) {
            return yield* ProjectNotFound.make({ projectId: input.projectId })
          }
          yield* ensureAssignee(input.assignee)
          for (const first of firstIssues) yield* ensureAssignee(first.assignee)
          const created = Objective.make({ ...input, state: 'open', createdAt })
          yield* sql`INSERT INTO objectives ${sql.insert(objectiveRow(created))}`
          yield* append(created.id, null, IssueEvents.ObjectiveCreated.make({ objective: created }))
          for (const [index, first] of firstIssues.entries()) {
            const generated = ids[index]
            if (generated === undefined) continue
            yield* insertIssue(
              Issue.make({
                ...first,
                ...generated,
                objectiveId: created.id,
                parentIssueId: null,
                status: 'todo',
                sessionId: null,
                refusal: null,
                createdAt
              })
            )
          }
          return created
        })
      )
      yield* Effect.logInfo('Created objective', {
        objectiveId: objective.id,
        firstIssues: firstIssues.map((first) => first.kind)
      })
      return objective
    })

    const createIssue = Effect.fn('Issues.createIssue')(function* (input: NewWorkIssue) {
      const createdAt = yield* Clock.currentTimeMillis
      const paneId = Uuid.make(yield* newUuid)
      const issue = yield* transaction(
        Effect.gen(function* () {
          const stored = yield* findIssue(input.id)
          if (stored !== undefined) return stored
          const objective = yield* findObjective(input.objectiveId)
          if (objective === undefined) {
            return yield* ObjectiveNotFound.make({ objectiveId: input.objectiveId })
          }
          yield* ensureParent(input.objectiveId, input.parentIssueId)
          yield* ensureAssignee(input.assignee)
          const created = Issue.make({
            ...input,
            kind: 'work',
            status: 'todo',
            paneId,
            sessionId: null,
            refusal: null,
            createdAt
          })
          yield* insertIssue(created)
          if (objective.state === 'completed') {
            yield* sql`UPDATE objectives SET state = 'open' WHERE objective_id = ${objective.id}`
            yield* append(objective.id, null, IssueEvents.ObjectiveReopened.make({}))
          }
          return created
        })
      )
      yield* Effect.logInfo('Created issue', { issueId: issue.id, objectiveId: issue.objectiveId })
      return issue
    })

    const proposeIssue = Effect.fn('Issues.proposeIssue')(function* (
      fromIssueId: IssueId,
      input: ProposedIssue
    ) {
      const createdAt = yield* Clock.currentTimeMillis
      const id = IssueId.make(yield* newUuid)
      const paneId = Uuid.make(yield* newUuid)
      const issue = yield* transaction(
        Effect.gen(function* () {
          const objectiveId = yield* objectiveOf(fromIssueId)
          if ((yield* findObjective(objectiveId)) === undefined) {
            return yield* ObjectiveNotFound.make({ objectiveId })
          }
          yield* ensureParent(objectiveId, input.parentIssueId)
          const created = Issue.make({
            ...input,
            id,
            objectiveId,
            kind: 'work',
            status: 'triage',
            assignee: null,
            paneId,
            sessionId: null,
            refusal: null,
            createdAt
          })
          yield* insertIssue(created)
          return created
        })
      )
      yield* Effect.logInfo('Proposed issue', { issueId: issue.id, objectiveId: issue.objectiveId })
      return issue
    })

    const assignIssue = Effect.fn('Issues.assignIssue')(function* (
      issueId: IssueId,
      assignee: AssigneeRef | null
    ) {
      const issue = yield* transaction(
        Effect.gen(function* () {
          const current = yield* requireIssue(issueId)
          if (sameAssignee(current.assignee, assignee)) return current
          if (!isAssignable(current.status)) {
            return yield* IssueNotAssignable.make({ issueId, status: current.status })
          }
          yield* ensureAssignee(assignee)
          yield* sql`UPDATE issues SET assignee_provider = ${assignee?.provider ?? null},
            assignee_id = ${assignee?.id ?? null} WHERE issue_id = ${issueId}`
          yield* append(current.objectiveId, issueId, IssueEvents.IssueAssigned.make({ assignee }))
          return Issue.make({ ...current, assignee })
        })
      )
      yield* Effect.logInfo('Assigned issue', { issueId, assignee })
      return issue
    })

    const triageIssues = Effect.fn('Issues.triageIssues')(function* (
      issueIds: Arr.NonEmptyReadonlyArray<IssueId>,
      decision: TriageDecision
    ) {
      const target = TRIAGE_TARGET[decision]
      const issues = yield* transaction(
        Effect.gen(function* () {
          const result: Array<Issue> = []
          const objectives = new Set<ObjectiveId>()
          for (const issueId of issueIds) {
            const current = yield* requireIssue(issueId)
            if (current.status === target) {
              result.push(current)
              continue
            }
            if (current.status !== 'triage') {
              return yield* IssueNotInTriage.make({ issueId, status: current.status })
            }
            yield* setIssueStatus(issueId, target)
            yield* append(current.objectiveId, issueId, IssueEvents.IssueTriaged.make({ decision }))
            objectives.add(current.objectiveId)
            result.push(Issue.make({ ...current, status: target, refusal: null }))
          }
          if (decision === 'decline') {
            for (const objectiveId of objectives) yield* completeObjectiveIfDone(objectiveId)
          }
          return result
        })
      )
      yield* Effect.logInfo('Triaged issues', { issueIds, decision })
      return issues
    })

    const updateIssue = Effect.fn('Issues.updateIssue')(function* (
      fromIssueId: IssueId,
      issueId: IssueId,
      change: IssueChange
    ) {
      const issue = yield* transaction(
        Effect.gen(function* () {
          const objectiveId = yield* objectiveOf(fromIssueId)
          const current = yield* requireIssue(issueId, objectiveId)
          if (Object.keys(change).length === 0) return current
          if (change.status !== undefined && !isStarted(current.status)) {
            return yield* IssueNotStarted.make({ issueId, status: current.status })
          }
          if (
            (change.title !== undefined || change.description !== undefined) &&
            isClosed(current.status)
          ) {
            return yield* IssueClosed.make({ issueId, status: current.status })
          }
          yield* sql`UPDATE issues SET ${sql.update(change)} WHERE issue_id = ${issueId}`
          yield* append(objectiveId, issueId, IssueEvents.IssueUpdated.make({ change }))
          return Issue.make({ ...current, ...change })
        })
      )
      yield* Effect.logInfo('Updated issue', { issueId, fields: Object.keys(change) })
      return issue
    })

    const commentIssue = Effect.fn('Issues.commentIssue')(function* (
      fromIssueId: IssueId,
      issueId: IssueId,
      author: AssigneeRef,
      body: CommentBody
    ) {
      const createdAt = yield* Clock.currentTimeMillis
      const id = CommentId.make(yield* newUuid)
      const comment = yield* transaction(
        Effect.gen(function* () {
          const objectiveId = yield* objectiveOf(fromIssueId)
          yield* requireIssue(issueId, objectiveId)
          const created = IssueComment.make({ id, issueId, author, body, createdAt })
          yield* sql`INSERT INTO issue_comments ${sql.insert(commentRow(created))}`
          yield* append(objectiveId, issueId, IssueEvents.IssueCommented.make({ commentId: id }))
          return created
        })
      )
      yield* Effect.logInfo('Commented on issue', { issueId, commentId: comment.id, author })
      return comment
    })

    const finishIssue = Effect.fn('Issues.finishIssue')(function* (issueId: IssueId) {
      const issue = yield* transaction(
        Effect.gen(function* () {
          const current = yield* requireIssue(issueId)
          if (current.status === 'done') return current
          if (!isStarted(current.status)) {
            return yield* IssueNotStarted.make({ issueId, status: current.status })
          }
          yield* setIssueStatus(issueId, 'done')
          yield* append(current.objectiveId, issueId, IssueEvents.IssueFinished.make({}))
          yield* completeObjectiveIfDone(current.objectiveId)
          return Issue.make({ ...current, status: 'done' })
        })
      )
      yield* Effect.logInfo('Finished issue', { issueId, kind: issue.kind })
      return issue
    })

    const stopObjective = Effect.fn('Issues.stopObjective')(function* (objectiveId: ObjectiveId) {
      const canceled = yield* transaction(
        Effect.gen(function* () {
          if ((yield* findObjective(objectiveId)) === undefined) {
            return yield* ObjectiveNotFound.make({ objectiveId })
          }
          const rows = yield* sql`SELECT * FROM issues WHERE objective_id = ${objectiveId}
            AND status NOT IN ('done', 'canceled') ORDER BY created_at, rowid`
          const open = (yield* decodeIssueRows(rows)).map(toIssue)
          for (const issue of open) {
            yield* setIssueStatus(issue.id, 'canceled')
            yield* append(objectiveId, issue.id, IssueEvents.IssueCanceled.make({}))
          }
          yield* completeObjectiveIfDone(objectiveId)
          return open.map((issue) => Issue.make({ ...issue, status: 'canceled', refusal: null }))
        })
      )
      yield* Effect.logInfo('Stopped objective', { objectiveId, canceled: canceled.length })
      return canceled
    })

    const importWork = Effect.fn('Issues.importWork')(function* (work: ImportedWork) {
      const added = yield* transaction(
        Effect.gen(function* () {
          yield* sql.unsafe('PRAGMA defer_foreign_keys = ON')
          let objectives = 0
          let issues = 0
          let comments = 0
          let events = 0
          for (const objective of work.objectives) {
            const rows =
              yield* sql`INSERT OR IGNORE INTO objectives ${sql.insert(objectiveRow(objective))} RETURNING objective_id`
            objectives += rows.length
          }
          for (const issue of work.issues) {
            const rows =
              yield* sql`INSERT OR IGNORE INTO issues ${sql.insert(issueRow(issue))} RETURNING issue_id`
            issues += rows.length
          }
          for (const comment of work.comments) {
            const rows =
              yield* sql`INSERT OR IGNORE INTO issue_comments ${sql.insert(commentRow(comment))} RETURNING comment_id`
            comments += rows.length
          }
          for (const event of work.events) {
            const rows = yield* sql`INSERT OR IGNORE INTO issue_events ${sql.insert({
              at: event.at,
              objective_id: event.objectiveId,
              issue_id: event.issueId,
              event: event.event,
              imported_seq: event.seq
            })} RETURNING seq`
            events += rows.length
          }
          return { objectives, issues, comments, events }
        })
      )
      yield* Effect.logInfo('Imported work', {
        offered: {
          objectives: work.objectives.length,
          issues: work.issues.length,
          comments: work.comments.length,
          events: work.events.length
        },
        added
      })
    })

    const changeRun = (
      issueId: IssueId,
      update: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
      event: (issue: Issue) => IssueEvent
    ) =>
      inTransaction(
        Effect.gen(function* () {
          const [row] = yield* decodeIssueRows(yield* update)
          if (row === undefined) return false
          yield* append(row.objective_id, issueId, event(toIssue(row)))
          return true
        })
      ).pipe(Effect.tap((changed) => (changed ? publishChange : Effect.void)))

    const requeueAll = (provider: ProviderId) =>
      transaction(
        Effect.gen(function* () {
          const rows = yield* decodeIssueRows(
            yield* sql`UPDATE issues SET status = 'todo' WHERE ${requeueable} AND assignee_provider = ${provider} RETURNING *`
          )
          for (const row of rows) {
            yield* append(
              row.objective_id,
              row.issue_id,
              IssueEvents.IssueRequeued.make({ sessionId: row.session_id })
            )
          }
          return rows.length
        })
      ).pipe(Effect.tap((count) => Effect.logInfo('Requeued started issues', { provider, count })))

    const toolWork: IssueToolWork = { proposeIssue, updateIssue, commentIssue }

    const providerIssues = (provider: ProviderId): ProviderIssues => {
      const ofProvider = sql`assignee_provider = ${provider}`
      return {
        runState: Effect.gen(function* () {
          const issueRows = yield* decodeIssueRows(
            yield* sql`SELECT * FROM issues WHERE status = 'todo' AND ${ofProvider} ORDER BY created_at, rowid`
          )
          const objectiveRows = yield* decodeObjectiveRows(
            yield* sql`SELECT * FROM objectives WHERE objective_id IN (SELECT objective_id FROM issues WHERE status = 'todo' AND ${ofProvider})`
          )
          const startedRows = yield* decodeIssueRows(
            yield* sql`SELECT * FROM issues WHERE ${started} AND ${ofProvider} ORDER BY created_at, rowid`
          )
          const objectives = new Map(
            objectiveRows.map((row) => [row.objective_id, toObjective(row)])
          )
          const startable = issueRows.flatMap((row) => {
            const objective = objectives.get(row.objective_id)
            return objective === undefined ? [] : [{ issue: toIssue(row), objective }]
          })
          return { startable, started: startedRows.map(toIssue) }
        }).pipe(orDie),
        markStarted: (issueId, assigneeId) =>
          changeRun(
            issueId,
            sql`UPDATE issues SET status = 'understanding' WHERE issue_id = ${issueId} AND status = 'todo' AND ${ofProvider} AND assignee_id = ${assigneeId} RETURNING *`,
            () =>
              IssueEvents.IssueStarted.make({
                assignee: AssigneeRef.make({ provider, id: assigneeId })
              })
          ).pipe(
            Effect.tap((changed) => Effect.logInfo('Marked issue started', { issueId, changed }))
          ),
        markSessionStarted: (issueId: IssueId, sessionId: SessionId) =>
          changeRun(
            issueId,
            sql`UPDATE issues SET session_id = ${sessionId} WHERE issue_id = ${issueId} AND ${started} AND ${ofProvider} AND session_id IS NOT ${sessionId} RETURNING *`,
            () => IssueEvents.IssueSessionStarted.make({ sessionId })
          ).pipe(
            Effect.tap((changed) => Effect.logDebug('Stored issue session', { issueId, changed }))
          ),
        markRequeued: (issueId, keepSession) =>
          changeRun(
            issueId,
            sql`UPDATE issues SET status = 'todo', session_id = CASE WHEN ${keepSession ? 1 : 0} THEN session_id END WHERE issue_id = ${issueId} AND ${requeueable} AND ${ofProvider} RETURNING *`,
            (issue) => IssueEvents.IssueRequeued.make({ sessionId: issue.sessionId })
          ).pipe(
            Effect.tap((changed) =>
              Effect.logInfo('Requeued issue', { issueId, keepSession, changed })
            )
          ),
        requeueRunning: requeueAll(provider),
        markRefused: (issueId: IssueId, refusal: Refusal) =>
          changeRun(
            issueId,
            sql`UPDATE issues SET status = 'triage', refusal = ${refusal} WHERE issue_id = ${issueId} AND status = 'todo' AND ${ofProvider} RETURNING *`,
            () => IssueEvents.IssueRefused.make({ refusal })
          ).pipe(
            Effect.tap((changed) =>
              Effect.logInfo('Refused to start issue', { issueId, refusal, changed })
            )
          ),
        countOpenIssues: (assigneeId) =>
          sql<{
            readonly open: number
          }>`SELECT count(*) AS open FROM issues WHERE ${ofProvider} AND assignee_id = ${assigneeId} AND status NOT IN ('done', 'canceled')`.pipe(
            Effect.map((rows) => rows[0]?.open ?? 0),
            orDie
          ),
        issueTools: makeIssueTools(toolWork, (assigneeId) =>
          AssigneeRef.make({ provider, id: assigneeId })
        )
      }
    }

    const setAssignees = (provider: ProviderId, assignees: ReadonlyArray<ListedAssignee>) =>
      Ref.modify(providers, (current) => {
        const held = current.get(provider)
        if (held === undefined || sameAssignees(held.assignees, assignees)) {
          return [false, current] as const
        }
        return [true, new Map(current).set(provider, { ...held, assignees })] as const
      }).pipe(Effect.flatMap((changed) => (changed ? publishChange : Effect.void)))

    const releaseProvider = (provider: ProviderId) =>
      Effect.gen(function* () {
        yield* requeueAll(provider)
        yield* Ref.update(providers, (current) => {
          const next = new Map(current)
          next.delete(provider)
          return next
        })
        yield* publishChange
        yield* Effect.logInfo('Released assignee provider', { provider })
      })

    const registerProvider = Effect.fn('Issues.registerProvider')(function* (
      provider: AssigneeProvider
    ): Effect.fn.Return<ProviderIssues, AssigneeProviderTaken, Scope.Scope> {
      const taken = yield* Ref.modify(providers, (current) =>
        current.has(provider.id)
          ? [true, current]
          : [false, new Map(current).set(provider.id, { label: provider.label, assignees: [] })]
      )
      if (taken) return yield* AssigneeProviderTaken.make({ provider: provider.id })
      yield* Effect.addFinalizer(() => releaseProvider(provider.id))
      const first = yield* Deferred.make<void>()
      yield* provider.assignees.pipe(
        Stream.runForEach((assignees) =>
          setAssignees(provider.id, assignees).pipe(
            Effect.andThen(Deferred.succeed(first, undefined))
          )
        ),
        Effect.ensuring(Deferred.succeed(first, undefined)),
        Effect.forkScoped
      )
      yield* Deferred.await(first)
      yield* Effect.logInfo('Registered assignee provider', {
        provider: provider.id,
        assignees: (yield* Ref.get(providers)).get(provider.id)?.assignees.length ?? 0
      })
      return providerIssues(provider.id)
    })

    const watchChanges = Effect.map(PubSub.subscribe(changes), Stream.fromSubscription)

    return {
      snapshot,
      watchChanges,
      providers: providerGroups,
      createObjective,
      createIssue,
      assignIssue,
      triageIssues,
      finishIssue,
      stopObjective,
      registerProvider,
      importWork
    } satisfies Issues
  })
