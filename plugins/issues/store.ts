import { type PluginMigrations, SessionId } from '@dia/plugin'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  AssigneeRef,
  CommentId,
  Issue,
  IssueChange,
  IssueComment,
  Objective,
  ProviderId,
  Refusal,
  TriageDecision
} from './domain'

const STATUSES =
  "'triage','todo','understanding','designing','implementing','testing','verifying','in_review','done','canceled'"

const assigneeColumns = (prefix: string) => `${prefix}_provider TEXT,
    ${prefix}_id       TEXT,
    CHECK ((${prefix}_provider IS NULL) = (${prefix}_id IS NULL))`

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE objectives (
    objective_id TEXT    PRIMARY KEY,
    project_id   TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL,
    priority     TEXT    NOT NULL CHECK (priority IN ('high', 'normal', 'low')),
    state        TEXT    NOT NULL CHECK (state IN ('open', 'completed')),
    created_at   INTEGER NOT NULL,
    ${assigneeColumns('assignee')}
  )`)
  yield* sql.unsafe(`CREATE TABLE issues (
    issue_id        TEXT    PRIMARY KEY,
    objective_id    TEXT    NOT NULL REFERENCES objectives,
    parent_issue_id TEXT    REFERENCES issues(issue_id),
    kind            TEXT    NOT NULL CHECK (kind IN ('work', 'retro', 'planning')),
    title           TEXT    NOT NULL,
    description     TEXT    NOT NULL,
    status          TEXT    NOT NULL CHECK (status IN (${STATUSES})),
    pane_id         TEXT    NOT NULL UNIQUE,
    session_id      TEXT,
    refusal         TEXT    CHECK (status = 'triage' OR refusal IS NULL),
    created_at      INTEGER NOT NULL,
    ${assigneeColumns('assignee')}
  )`)
  yield* sql.unsafe('CREATE INDEX issues_objective ON issues(objective_id)')
  yield* sql.unsafe(
    'CREATE INDEX issues_status_assignee ON issues(status, assignee_provider, assignee_id)'
  )
  yield* sql.unsafe(`CREATE TABLE issue_comments (
    comment_id TEXT    PRIMARY KEY,
    issue_id   TEXT    NOT NULL REFERENCES issues,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    ${assigneeColumns('author')}
  )`)
  yield* sql.unsafe('CREATE INDEX issue_comments_issue ON issue_comments(issue_id)')
  yield* sql.unsafe(`CREATE TABLE issue_events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    at           INTEGER NOT NULL,
    objective_id TEXT    NOT NULL,
    issue_id     TEXT,
    event        TEXT    NOT NULL,
    imported_seq INTEGER UNIQUE
  )`)
  yield* Effect.logInfo('Created the objectives, issues, issue comments and issue events tables')
})

/**
 * The `issues` plugin's migrations, passed to `ctx.database`. `1_create_issues` creates the
 * objectives, issues, issue comments and issue events tables; an assignee or author is stored as
 * its provider and id, both null or both set, and an issue's refusal must be null unless the issue
 * is in `triage`. Each runs once per database.
 */
export const issuesMigrations: PluginMigrations = {
  '1_create_issues': createTables
}

const ObjectiveCreated = Schema.TaggedStruct('ObjectiveCreated', { objective: Objective })
const ObjectiveReopened = Schema.TaggedStruct('ObjectiveReopened', {})
const ObjectiveCompleted = Schema.TaggedStruct('ObjectiveCompleted', {})
const IssueCreated = Schema.TaggedStruct('IssueCreated', { issue: Issue })
const IssueAssigned = Schema.TaggedStruct('IssueAssigned', { assignee: Issue.fields.assignee })
const IssueStarted = Schema.TaggedStruct('IssueStarted', { assignee: AssigneeRef })
const IssueSessionStarted = Schema.TaggedStruct('IssueSessionStarted', { sessionId: SessionId })
const IssueRequeued = Schema.TaggedStruct('IssueRequeued', { sessionId: Issue.fields.sessionId })
const IssueUpdated = Schema.TaggedStruct('IssueUpdated', { change: IssueChange })
const IssueTriaged = Schema.TaggedStruct('IssueTriaged', { decision: TriageDecision })
const IssueCommented = Schema.TaggedStruct('IssueCommented', { commentId: CommentId })
const IssueFinished = Schema.TaggedStruct('IssueFinished', {})
const IssueCanceled = Schema.TaggedStruct('IssueCanceled', {})
const IssueRefused = Schema.TaggedStruct('IssueRefused', { refusal: Refusal })

/** The constructors of the events each change appends to `issue_events`. */
export const IssueEvents = {
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
}

const IssueEvent = Schema.Union(Object.values(IssueEvents))

/** An event appended to `issue_events`. */
export type IssueEvent = typeof IssueEvent.Type

/** The text `issue_events.event` stores for `event`. */
export const encodeEvent = Schema.encodeSync(Schema.fromJsonString(IssueEvent))

const NullableString = Schema.NullOr(Schema.String)

const ObjectiveRow = Schema.Struct({
  objective_id: Objective.fields.id,
  project_id: Objective.fields.projectId,
  title: Objective.fields.title,
  description: Objective.fields.description,
  priority: Objective.fields.priority,
  assignee_provider: Schema.NullOr(ProviderId),
  assignee_id: NullableString,
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
  assignee_provider: Schema.NullOr(ProviderId),
  assignee_id: NullableString,
  pane_id: Issue.fields.paneId,
  session_id: Issue.fields.sessionId,
  refusal: Issue.fields.refusal,
  created_at: Issue.fields.createdAt
})

const CommentRow = Schema.Struct({
  comment_id: IssueComment.fields.id,
  issue_id: IssueComment.fields.issueId,
  author_provider: Schema.NullOr(ProviderId),
  author_id: NullableString,
  body: IssueComment.fields.body,
  created_at: IssueComment.fields.createdAt
})

/** A stored `issues` row. */
export type IssueRow = typeof IssueRow.Type

const refOf = (provider: ProviderId | null, id: string | null): AssigneeRef | null =>
  provider === null || id === null || id === '' ? null : AssigneeRef.make({ provider, id })

const refColumns = (prefix: 'assignee' | 'author', ref: AssigneeRef | null) => ({
  [`${prefix}_provider`]: ref?.provider ?? null,
  [`${prefix}_id`]: ref?.id ?? null
})

/** The objective a stored row holds. */
export const toObjective = (row: typeof ObjectiveRow.Type): Objective =>
  Objective.make({
    id: row.objective_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    assignee: refOf(row.assignee_provider, row.assignee_id),
    state: row.state,
    createdAt: row.created_at
  })

/** The issue a stored row holds. */
export const toIssue = (row: IssueRow): Issue =>
  Issue.make({
    id: row.issue_id,
    objectiveId: row.objective_id,
    parentIssueId: row.parent_issue_id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: refOf(row.assignee_provider, row.assignee_id),
    paneId: row.pane_id,
    sessionId: row.session_id,
    refusal: row.refusal,
    createdAt: row.created_at
  })

/** The comment a stored row holds. */
export const toComment = (row: typeof CommentRow.Type): IssueComment =>
  IssueComment.make({
    id: row.comment_id,
    issueId: row.issue_id,
    author: refOf(row.author_provider, row.author_id),
    body: row.body,
    createdAt: row.created_at
  })

/** The `objectives` row that stores `objective`. */
export const objectiveRow = (objective: Objective) => ({
  objective_id: objective.id,
  project_id: objective.projectId,
  title: objective.title,
  description: objective.description,
  priority: objective.priority,
  state: objective.state,
  created_at: objective.createdAt,
  ...refColumns('assignee', objective.assignee)
})

/** The `issues` row that stores `issue`. */
export const issueRow = (issue: Issue) => ({
  issue_id: issue.id,
  objective_id: issue.objectiveId,
  parent_issue_id: issue.parentIssueId,
  kind: issue.kind,
  title: issue.title,
  description: issue.description,
  status: issue.status,
  pane_id: issue.paneId,
  session_id: issue.sessionId,
  refusal: issue.refusal,
  created_at: issue.createdAt,
  ...refColumns('assignee', issue.assignee)
})

/** The `issue_comments` row that stores `comment`. */
export const commentRow = (comment: IssueComment) => ({
  comment_id: comment.id,
  issue_id: comment.issueId,
  body: comment.body,
  created_at: comment.createdAt,
  ...refColumns('author', comment.author)
})

/** Decodes `objectives` rows; a row that does not decode is a defect. */
export const decodeObjectiveRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(ObjectiveRow))(rows).pipe(Effect.orDie)

/** Decodes `issues` rows; a row that does not decode is a defect. */
export const decodeIssueRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(IssueRow))(rows).pipe(Effect.orDie)

/** Decodes `issue_comments` rows; a row that does not decode is a defect. */
export const decodeCommentRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(CommentRow))(rows).pipe(Effect.orDie)
