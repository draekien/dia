import { type ProjectId, SessionId, Uuid } from '@dia/plugin'
import {
  type Array as Arr,
  Clock,
  Crypto,
  Effect,
  PubSub,
  Schema,
  type Scope,
  Stream
} from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import {
  type CommentBody,
  CommentId,
  HireId,
  HireNotFound,
  ISSUE_DESCRIPTION_MAX_LENGTH,
  Issue,
  IssueChange,
  IssueClosed,
  IssueComment,
  type IssueId,
  IssueNotAssignable,
  IssueNotFound,
  IssueNotInTriage,
  IssueNotStarted,
  type IssueStatus,
  isAssignable,
  isClosed,
  isStarted,
  MissingReference,
  type NewIssue,
  type NewObjective,
  Objective,
  type ObjectiveId,
  ObjectiveNotFound,
  ProjectNotFound,
  type ProposedIssue,
  StartedStatus,
  TriageDecision,
  WORK_TITLE_MAX_LENGTH,
  WorkSnapshot,
  WorkTitle
} from './domain'

const ObjectiveCreated = Schema.TaggedStruct('ObjectiveCreated', { objective: Objective })
const ObjectiveReopened = Schema.TaggedStruct('ObjectiveReopened', {})
const ObjectiveCompleted = Schema.TaggedStruct('ObjectiveCompleted', {})
const IssueCreated = Schema.TaggedStruct('IssueCreated', { issue: Issue })
const IssueAssigned = Schema.TaggedStruct('IssueAssigned', { assignee: Issue.fields.assignee })
const IssueStarted = Schema.TaggedStruct('IssueStarted', { assignee: HireId })
const IssueSessionStarted = Schema.TaggedStruct('IssueSessionStarted', { sessionId: SessionId })
const IssueRequeued = Schema.TaggedStruct('IssueRequeued', { sessionId: Issue.fields.sessionId })
const IssueUpdated = Schema.TaggedStruct('IssueUpdated', { change: IssueChange })
const IssueTriaged = Schema.TaggedStruct('IssueTriaged', { decision: TriageDecision })
const IssueCommented = Schema.TaggedStruct('IssueCommented', { commentId: CommentId })
const IssueFinished = Schema.TaggedStruct('IssueFinished', {})
const IssueCanceled = Schema.TaggedStruct('IssueCanceled', {})
const IssueRefused = Schema.TaggedStruct('IssueRefused', {
  missing: Schema.Array(MissingReference)
})

const OrgEvent = Schema.Union([
  ObjectiveCreated,
  ObjectiveReopened,
  ObjectiveCompleted,
  IssueCreated,
  IssueAssigned,
  IssueStarted,
  IssueSessionStarted,
  IssueRequeued,
  IssueUpdated,
  IssueTriaged,
  IssueCommented,
  IssueFinished,
  IssueCanceled,
  IssueRefused
])
type OrgEvent = typeof OrgEvent.Type

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrgEvent))

const ObjectiveRow = Schema.Struct({
  objective_id: Objective.fields.id,
  project_id: Objective.fields.projectId,
  title: Objective.fields.title,
  description: Objective.fields.description,
  priority: Objective.fields.priority,
  assignee: Objective.fields.assignee,
  state: Objective.fields.state,
  created_at: Objective.fields.createdAt
})

const IssueRow = Schema.Struct({
  issue_id: Issue.fields.id,
  objective_id: Issue.fields.objectiveId,
  parent_issue_id: Issue.fields.parentIssueId,
  kind: Issue.fields.kind,
  title: Issue.fields.title,
  description: Issue.fields.description,
  status: Issue.fields.status,
  assignee: Issue.fields.assignee,
  pane_id: Issue.fields.paneId,
  session_id: Issue.fields.sessionId,
  missing: Schema.fromJsonString(Issue.fields.missing),
  created_at: Issue.fields.createdAt
})

const CommentRow = Schema.Struct({
  comment_id: IssueComment.fields.id,
  issue_id: IssueComment.fields.issueId,
  author: IssueComment.fields.author,
  body: IssueComment.fields.body,
  created_at: IssueComment.fields.createdAt
})

const toObjective = (row: typeof ObjectiveRow.Type): Objective => ({
  id: row.objective_id,
  projectId: row.project_id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  assignee: row.assignee,
  state: row.state,
  createdAt: row.created_at
})

const toIssue = (row: typeof IssueRow.Type): Issue => ({
  id: row.issue_id,
  objectiveId: row.objective_id,
  parentIssueId: row.parent_issue_id,
  kind: row.kind,
  title: row.title,
  description: row.description,
  status: row.status,
  assignee: row.assignee,
  paneId: row.pane_id,
  sessionId: row.session_id,
  missing: row.missing,
  createdAt: row.created_at
})

const toComment = (row: typeof CommentRow.Type): IssueComment => ({
  id: row.comment_id,
  issueId: row.issue_id,
  author: row.author,
  body: row.body,
  createdAt: row.created_at
})

const encodeObjectiveRow = Schema.encodeSync(ObjectiveRow)
const encodeIssueRow = Schema.encodeSync(IssueRow)
const encodeCommentRow = Schema.encodeSync(CommentRow)
const encodeMissing = Schema.encodeSync(IssueRow.fields.missing)

const toObjectiveRow = (objective: Objective) =>
  encodeObjectiveRow({
    objective_id: objective.id,
    project_id: objective.projectId,
    title: objective.title,
    description: objective.description,
    priority: objective.priority,
    assignee: objective.assignee,
    state: objective.state,
    created_at: objective.createdAt
  })

const toIssueRow = (issue: Issue) =>
  encodeIssueRow({
    issue_id: issue.id,
    objective_id: issue.objectiveId,
    parent_issue_id: issue.parentIssueId,
    kind: issue.kind,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    assignee: issue.assignee,
    pane_id: issue.paneId,
    session_id: issue.sessionId,
    missing: issue.missing,
    created_at: issue.createdAt
  })

const toCommentRow = (comment: IssueComment) =>
  encodeCommentRow({
    comment_id: comment.id,
    issue_id: comment.issueId,
    author: comment.author,
    body: comment.body,
    created_at: comment.createdAt
  })

const decodeObjectiveRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(ObjectiveRow))(rows).pipe(Effect.orDie)
const decodeIssueRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(IssueRow))(rows).pipe(Effect.orDie)
const decodeCommentRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(CommentRow))(rows).pipe(Effect.orDie)

const prefixedTitle = (prefix: string, title: WorkTitle): WorkTitle =>
  WorkTitle.make(`${prefix}: ${title}`.slice(0, WORK_TITLE_MAX_LENGTH).trimEnd())

const REQUEUEABLE_STATUSES = StartedStatus.literals.filter((status) => status !== 'in_review')

const TRIAGE_TARGET: Record<TriageDecision, IssueStatus> = { accept: 'todo', decline: 'canceled' }

/**
 * The objectives, issues and comments (ADR-0033, ADR-0064, ADR-0069), as the `org` plugin's calls
 * and a hired agent's issue tools read and change them. Each change is one transaction that
 * writes its events and the changed rows, and is safe to repeat. A database failure, or a failure
 * to generate an id, is a defect.
 *
 * `createObjective` creates an open objective assigned to its route's assignee, and its first
 * issue in `todo`: for a `PlanRoute`, the `planning` issue `Plan: <title>`; for a `DirectRoute`, one
 * `work` issue with the objective's title and description (its first
 * {@link ISSUE_DESCRIPTION_MAX_LENGTH} characters; the objective keeps all of it). A repeated `id` returns the stored
 * objective and creates nothing. `stopObjective` cancels every issue of an objective that is not
 * `done` or `canceled` and returns them; the caller releases their sessions. `createIssue` creates a `work` issue in `todo`, or returns the stored one when
 * `id` exists; it reopens a completed objective. `proposeIssue` creates an unassigned `work` issue
 * in `triage`. `assignIssue` sets a `triage` or `todo` issue's assignee, or clears it when null;
 * giving an issue its current assignee returns it unchanged in any status. `triageIssues` moves
 * each `triage` issue to `todo` (accept) or `canceled` (decline), leaves one already there
 * unchanged, and fails the whole call, changing nothing, on any other status. `updateIssue`
 * applies the change's present fields: `status` needs a started issue (checked first), `title` and
 * `description` an issue that is not closed. `commentIssue` stores a comment on an issue in any
 * status. `finishIssue` moves a started issue to `done`, and gives a `work` issue an unassigned
 * `retro` sub-issue in `todo`; on a `done` issue it returns the issue unchanged. `updateIssue` and
 * `commentIssue` fail with `IssueNotFound` when the issue is not in `objectiveId`. An objective
 * completes once it has issues and every one is `done` or `canceled`. `watchChanges` subscribes
 * when run; the stream it returns emits once after each change committed since the subscription.
 */
export interface Work {
  readonly snapshot: Effect.Effect<WorkSnapshot>
  readonly watchChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  readonly createObjective: (
    input: NewObjective
  ) => Effect.Effect<Objective, ProjectNotFound | HireNotFound>
  readonly createIssue: (
    input: NewIssue
  ) => Effect.Effect<Issue, ObjectiveNotFound | IssueNotFound | HireNotFound>
  readonly proposeIssue: (
    objectiveId: ObjectiveId,
    input: ProposedIssue
  ) => Effect.Effect<Issue, ObjectiveNotFound | IssueNotFound>
  readonly assignIssue: (
    issueId: IssueId,
    hireId: HireId | null
  ) => Effect.Effect<Issue, IssueNotFound | IssueNotAssignable | HireNotFound>
  readonly triageIssues: (
    issueIds: Arr.NonEmptyReadonlyArray<IssueId>,
    decision: TriageDecision
  ) => Effect.Effect<ReadonlyArray<Issue>, IssueNotFound | IssueNotInTriage>
  readonly updateIssue: (
    objectiveId: ObjectiveId,
    issueId: IssueId,
    change: IssueChange
  ) => Effect.Effect<Issue, IssueNotFound | IssueNotStarted | IssueClosed>
  readonly commentIssue: (
    objectiveId: ObjectiveId,
    issueId: IssueId,
    author: HireId,
    body: CommentBody
  ) => Effect.Effect<IssueComment, IssueNotFound>
  readonly finishIssue: (issueId: IssueId) => Effect.Effect<Issue, IssueNotFound | IssueNotStarted>
  readonly stopObjective: (
    objectiveId: ObjectiveId
  ) => Effect.Effect<ReadonlyArray<Issue>, ObjectiveNotFound>
}

/** A `todo` issue with an assignee, and its objective: one candidate for the scheduler. */
export interface StartableIssue {
  readonly issue: Issue
  readonly objective: Objective
}

/**
 * The issue changes only the dispatcher makes, as it starts and loses sessions. Each changes an
 * issue only in the status it expects and reports whether it did. `startCandidates` reads the
 * `todo` issues that have an assignee, and the hired agents with a started issue. `markStarted`
 * moves a `todo` issue assigned to `hireId` to `understanding`. `markSessionStarted` stores the
 * session a started issue resumes next. `markRequeued` moves a started issue other than
 * `in_review` back to `todo`, keeping its session, or clearing it when `keepSession` is false.
 * `requeueRunning` moves every started issue other than `in_review` back to `todo` and returns how
 * many it moved; an `in_review` issue is never requeued. `markRefused` moves a `todo` issue to
 * `triage` with the `missing` names its job title holds, so it waits for the user.
 */
export interface IssueRuns {
  readonly startCandidates: Effect.Effect<{
    readonly startable: ReadonlyArray<StartableIssue>
    readonly busyHires: ReadonlySet<HireId>
  }>
  readonly markStarted: (issueId: IssueId, hireId: HireId) => Effect.Effect<boolean>
  readonly markSessionStarted: (issueId: IssueId, sessionId: SessionId) => Effect.Effect<boolean>
  readonly markRequeued: (issueId: IssueId, keepSession: boolean) => Effect.Effect<boolean>
  readonly requeueRunning: Effect.Effect<number>
  readonly markRefused: (
    issueId: IssueId,
    missing: ReadonlyArray<MissingReference>
  ) => Effect.Effect<boolean>
}

/**
 * Builds the {@link Work}, the dispatcher's {@link IssueRuns}, and `openIssuesOf` (the number of
 * issues assigned to a hired agent that are neither `done` nor `canceled`, which `makeOrg` takes)
 * over the `org` plugin's database, which `orgMigrations` must already have migrated.
 * `projectExists` says whether a project is registered now. Call it once in the plugin's setup.
 */
export const makeWork = (projectExists: (projectId: ProjectId) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto

    const changes = yield* PubSub.unbounded<void>()
    const publishChange = PubSub.publish(changes, undefined)

    const inTransaction = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
      sql.withTransaction(effect).pipe(Effect.catchTag('SqlError', Effect.die))
    const transaction = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
      inTransaction(effect).pipe(Effect.tap(() => publishChange))
    const orDie = <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
      effect.pipe(Effect.catchTag('SqlError', Effect.die))

    const newUuid = crypto.randomUUIDv4().pipe(Effect.orDie)
    const started = sql.in('status', StartedStatus.literals)
    const requeueable = sql.in('status', REQUEUEABLE_STATUSES)

    const append = (objectiveId: ObjectiveId, issueId: IssueId | null, event: OrgEvent) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* sql`INSERT INTO org_events ${sql.insert({
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

    const ensureParent = Effect.fnUntraced(function* (
      objectiveId: ObjectiveId,
      parentIssueId: IssueId | null
    ) {
      if (parentIssueId !== null) yield* requireIssue(parentIssueId, objectiveId)
    })

    const ensureHire = Effect.fnUntraced(function* (hireId: HireId | null) {
      if (hireId === null) return
      const rows = yield* sql`SELECT 1 FROM hired_agents WHERE hire_id = ${hireId}`
      if (rows.length === 0) {
        return yield* HireNotFound.make({ hireId })
      }
    })

    const insertIssue = Effect.fnUntraced(function* (issue: Issue) {
      yield* sql`INSERT INTO issues ${sql.insert(toIssueRow(issue))}`
      yield* append(issue.objectiveId, issue.id, IssueCreated.make({ issue }))
    })

    const setIssueStatus = (issueId: IssueId, status: IssueStatus) =>
      sql`UPDATE issues SET status = ${status}, missing = '[]' WHERE issue_id = ${issueId}`

    const completeObjectiveIfDone = Effect.fnUntraced(function* (objectiveId: ObjectiveId) {
      const [counts] = yield* sql<{
        readonly total: number
        readonly open: number
      }>`SELECT count(*) AS total, count(*) FILTER (WHERE status NOT IN ('done', 'canceled')) AS open
        FROM issues WHERE objective_id = ${objectiveId}`
      if (counts !== undefined && counts.total > 0 && counts.open === 0) {
        yield* sql`UPDATE objectives SET state = 'completed' WHERE objective_id = ${objectiveId}`
        yield* append(objectiveId, null, ObjectiveCompleted.make({}))
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
      return WorkSnapshot.make({
        objectives: objectives.map(toObjective),
        issues: issues.map(toIssue),
        comments: comments.map(toComment)
      })
    }).pipe(orDie)

    const createObjective = Effect.fn('Work.createObjective')(function* (input: NewObjective) {
      const createdAt = yield* Clock.currentTimeMillis
      const firstIssueId = Issue.fields.id.make(yield* newUuid)
      const firstPaneId = Uuid.make(yield* newUuid)
      const registered = yield* projectExists(input.projectId)
      const objective = yield* transaction(
        Effect.gen(function* () {
          const stored = yield* findObjective(input.id)
          if (stored !== undefined) return stored
          if (!registered) {
            return yield* ProjectNotFound.make({ projectId: input.projectId })
          }
          const { route, ...fields } = input
          yield* ensureHire(route.assignee)
          const created = Objective.make({
            ...fields,
            assignee: route.assignee,
            state: 'open',
            createdAt
          })
          yield* sql`INSERT INTO objectives ${sql.insert(toObjectiveRow(created))}`
          yield* append(created.id, null, ObjectiveCreated.make({ objective: created }))
          const direct = route._tag === 'DirectRoute'
          yield* insertIssue(
            Issue.make({
              id: firstIssueId,
              objectiveId: created.id,
              parentIssueId: null,
              kind: direct ? 'work' : 'planning',
              title: direct ? created.title : prefixedTitle('Plan', created.title),
              description: direct ? created.description.slice(0, ISSUE_DESCRIPTION_MAX_LENGTH) : '',
              status: 'todo',
              assignee: created.assignee,
              paneId: firstPaneId,
              sessionId: null,
              missing: [],
              createdAt
            })
          )
          return created
        })
      )
      yield* Effect.logInfo('Created objective', {
        objectiveId: objective.id,
        route: input.route._tag
      })
      return objective
    })

    const createIssue = Effect.fn('Work.createIssue')(function* (input: NewIssue) {
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
          yield* ensureHire(input.assignee)
          const created = Issue.make({
            ...input,
            kind: 'work',
            status: 'todo',
            paneId,
            sessionId: null,
            missing: [],
            createdAt
          })
          yield* insertIssue(created)
          if (objective.state === 'completed') {
            yield* sql`UPDATE objectives SET state = 'open' WHERE objective_id = ${objective.id}`
            yield* append(objective.id, null, ObjectiveReopened.make({}))
          }
          return created
        })
      )
      yield* Effect.logInfo('Created issue', { issueId: issue.id, objectiveId: issue.objectiveId })
      return issue
    })

    const proposeIssue = Effect.fn('Work.proposeIssue')(function* (
      objectiveId: ObjectiveId,
      input: ProposedIssue
    ) {
      const createdAt = yield* Clock.currentTimeMillis
      const id = Issue.fields.id.make(yield* newUuid)
      const paneId = Uuid.make(yield* newUuid)
      const issue = yield* transaction(
        Effect.gen(function* () {
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
            missing: [],
            createdAt
          })
          yield* insertIssue(created)
          return created
        })
      )
      yield* Effect.logInfo('Proposed issue', { issueId: issue.id, objectiveId })
      return issue
    })

    const assignIssue = Effect.fn('Work.assignIssue')(function* (
      issueId: IssueId,
      hireId: HireId | null
    ) {
      const issue = yield* transaction(
        Effect.gen(function* () {
          const current = yield* requireIssue(issueId)
          if (current.assignee === hireId) return current
          if (!isAssignable(current.status)) {
            return yield* IssueNotAssignable.make({ issueId, status: current.status })
          }
          yield* ensureHire(hireId)
          yield* sql`UPDATE issues SET assignee = ${hireId} WHERE issue_id = ${issueId}`
          yield* append(current.objectiveId, issueId, IssueAssigned.make({ assignee: hireId }))
          return Issue.make({ ...current, assignee: hireId })
        })
      )
      yield* Effect.logInfo('Assigned issue', { issueId, hireId })
      return issue
    })

    const triageIssues = Effect.fn('Work.triageIssues')(function* (
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
            yield* append(current.objectiveId, issueId, IssueTriaged.make({ decision }))
            objectives.add(current.objectiveId)
            result.push(Issue.make({ ...current, status: target, missing: [] }))
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

    const updateIssue = Effect.fn('Work.updateIssue')(function* (
      objectiveId: ObjectiveId,
      issueId: IssueId,
      change: IssueChange
    ) {
      const issue = yield* transaction(
        Effect.gen(function* () {
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
          yield* append(objectiveId, issueId, IssueUpdated.make({ change }))
          return Issue.make({ ...current, ...change })
        })
      )
      yield* Effect.logInfo('Updated issue', { issueId, fields: Object.keys(change) })
      return issue
    })

    const commentIssue = Effect.fn('Work.commentIssue')(function* (
      objectiveId: ObjectiveId,
      issueId: IssueId,
      author: HireId,
      body: CommentBody
    ) {
      const createdAt = yield* Clock.currentTimeMillis
      const id = CommentId.make(yield* newUuid)
      const comment = yield* transaction(
        Effect.gen(function* () {
          yield* requireIssue(issueId, objectiveId)
          const created = IssueComment.make({ id, issueId, author, body, createdAt })
          yield* sql`INSERT INTO issue_comments ${sql.insert(toCommentRow(created))}`
          yield* append(objectiveId, issueId, IssueCommented.make({ commentId: id }))
          return created
        })
      )
      yield* Effect.logInfo('Commented on issue', { issueId, commentId: comment.id, author })
      return comment
    })

    const finishIssue = Effect.fn('Work.finishIssue')(function* (issueId: IssueId) {
      const createdAt = yield* Clock.currentTimeMillis
      const retroId = Issue.fields.id.make(yield* newUuid)
      const retroPaneId = Uuid.make(yield* newUuid)
      const issue = yield* transaction(
        Effect.gen(function* () {
          const current = yield* requireIssue(issueId)
          if (current.status === 'done') return current
          if (!isStarted(current.status)) {
            return yield* IssueNotStarted.make({ issueId, status: current.status })
          }
          yield* setIssueStatus(issueId, 'done')
          yield* append(current.objectiveId, issueId, IssueFinished.make({}))
          if (current.kind === 'work') {
            yield* insertIssue(
              Issue.make({
                id: retroId,
                objectiveId: current.objectiveId,
                parentIssueId: issueId,
                kind: 'retro',
                title: prefixedTitle('Retro', current.title),
                description: '',
                status: 'todo',
                assignee: null,
                paneId: retroPaneId,
                sessionId: null,
                missing: [],
                createdAt
              })
            )
          }
          yield* completeObjectiveIfDone(current.objectiveId)
          return Issue.make({ ...current, status: 'done' })
        })
      )
      yield* Effect.logInfo('Finished issue', { issueId, kind: issue.kind })
      return issue
    })

    const stopObjective = Effect.fn('Work.stopObjective')(function* (objectiveId: ObjectiveId) {
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
            yield* append(objectiveId, issue.id, IssueCanceled.make({}))
          }
          yield* completeObjectiveIfDone(objectiveId)
          return open.map((issue) => Issue.make({ ...issue, status: 'canceled', missing: [] }))
        })
      )
      yield* Effect.logInfo('Stopped objective', { objectiveId, canceled: canceled.length })
      return canceled
    })

    const openIssuesOf = (hireId: HireId) =>
      sql<{
        readonly open: number
      }>`SELECT count(*) AS open FROM issues WHERE assignee = ${hireId} AND status NOT IN ('done', 'canceled')`.pipe(
        Effect.map((rows) => rows[0]?.open ?? 0),
        orDie
      )

    const startCandidates = Effect.gen(function* () {
      const issueRows = yield* decodeIssueRows(
        yield* sql`SELECT * FROM issues WHERE status = 'todo' AND assignee IS NOT NULL ORDER BY created_at, rowid`
      )
      const objectiveRows = yield* decodeObjectiveRows(
        yield* sql`SELECT * FROM objectives WHERE objective_id IN (SELECT objective_id FROM issues WHERE status = 'todo' AND assignee IS NOT NULL)`
      )
      const objectives = new Map(objectiveRows.map((row) => [row.objective_id, toObjective(row)]))
      const busy = yield* sql<{
        readonly assignee: HireId
      }>`SELECT DISTINCT assignee FROM issues WHERE ${started} AND assignee IS NOT NULL`
      const startable = issueRows.flatMap((row) => {
        const objective = objectives.get(row.objective_id)
        return objective === undefined ? [] : [{ issue: toIssue(row), objective }]
      })
      return { startable, busyHires: new Set(busy.map((row) => row.assignee)) }
    }).pipe(orDie)

    const changeRun = (
      issueId: IssueId,
      update: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
      event: (issue: Issue) => OrgEvent
    ) =>
      inTransaction(
        Effect.gen(function* () {
          const changed = yield* decodeIssueRows(yield* update)
          const [row] = changed
          if (row === undefined) return false
          yield* append(row.objective_id, issueId, event(toIssue(row)))
          return true
        })
      ).pipe(Effect.tap((changed) => (changed ? publishChange : Effect.void)))

    const markStarted = (issueId: IssueId, hireId: HireId) =>
      changeRun(
        issueId,
        sql`UPDATE issues SET status = 'understanding' WHERE issue_id = ${issueId} AND status = 'todo' AND assignee = ${hireId} RETURNING *`,
        () => IssueStarted.make({ assignee: hireId })
      ).pipe(Effect.tap((changed) => Effect.logInfo('Marked issue started', { issueId, changed })))

    const markSessionStarted = (issueId: IssueId, sessionId: SessionId) =>
      changeRun(
        issueId,
        sql`UPDATE issues SET session_id = ${sessionId} WHERE issue_id = ${issueId} AND ${started} AND session_id IS NOT ${sessionId} RETURNING *`,
        () => IssueSessionStarted.make({ sessionId })
      ).pipe(Effect.tap((changed) => Effect.logDebug('Stored issue session', { issueId, changed })))

    const markRequeued = (issueId: IssueId, keepSession: boolean) =>
      changeRun(
        issueId,
        sql`UPDATE issues SET status = 'todo', session_id = CASE WHEN ${keepSession ? 1 : 0} THEN session_id END WHERE issue_id = ${issueId} AND ${requeueable} RETURNING *`,
        (issue) => IssueRequeued.make({ sessionId: issue.sessionId })
      ).pipe(
        Effect.tap((changed) => Effect.logInfo('Requeued issue', { issueId, keepSession, changed }))
      )

    const markRefused = (issueId: IssueId, missing: ReadonlyArray<MissingReference>) =>
      changeRun(
        issueId,
        sql`UPDATE issues SET status = 'triage', missing = ${encodeMissing(missing)} WHERE issue_id = ${issueId} AND status = 'todo' RETURNING *`,
        () => IssueRefused.make({ missing })
      ).pipe(
        Effect.tap((changed) =>
          Effect.logInfo('Refused to start issue', { issueId, missing, changed })
        )
      )

    const requeueRunning = transaction(
      Effect.gen(function* () {
        const rows = yield* decodeIssueRows(
          yield* sql`UPDATE issues SET status = 'todo' WHERE ${requeueable} RETURNING *`
        )
        for (const row of rows) {
          yield* append(
            row.objective_id,
            row.issue_id,
            IssueRequeued.make({ sessionId: row.session_id })
          )
        }
        return rows.length
      })
    ).pipe(Effect.tap((count) => Effect.logInfo('Requeued started issues', { count })))

    const watchChanges = Effect.map(PubSub.subscribe(changes), Stream.fromSubscription)

    const work: Work = {
      snapshot,
      watchChanges,
      createObjective,
      createIssue,
      proposeIssue,
      assignIssue,
      triageIssues,
      updateIssue,
      commentIssue,
      finishIssue,
      stopObjective
    }
    const runs: IssueRuns = {
      startCandidates,
      markStarted,
      markSessionStarted,
      markRequeued,
      requeueRunning,
      markRefused
    }
    return { work, runs, openIssuesOf }
  })
