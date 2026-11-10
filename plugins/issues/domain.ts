import { ProjectId, SessionId, Uuid } from '@dia/plugin'
import { Schema } from 'effect'

/** A registered assignee provider's id: lowercase letters, digits and `-`, 1 to 40 characters. */
export const ProviderId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9-]{1,40}$/)),
  Schema.brand('ProviderId')
)
export type ProviderId = typeof ProviderId.Type

/**
 * Who an issue or objective is given to, or who wrote a comment: an id the assignee provider
 * `provider` lists. A stored reference is kept when its provider stops listing the id.
 */
export const AssigneeRef = Schema.Struct({ provider: ProviderId, id: Schema.NonEmptyString })
export type AssigneeRef = typeof AssigneeRef.Type

/** Whether two assignee references name the same assignee; two nulls are the same. */
export const sameAssignee = (left: AssigneeRef | null, right: AssigneeRef | null): boolean =>
  left === null || right === null
    ? left === right
    : left.provider === right.provider && left.id === right.id

/** The longest a {@link Refusal} may be, in characters. */
export const REFUSAL_MAX_LENGTH = 1000

/**
 * Why an assignee provider refused to start an issue, shown as it is: trimmed, 1 to
 * {@link REFUSAL_MAX_LENGTH} characters.
 */
export const Refusal = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(REFUSAL_MAX_LENGTH)),
  Schema.brand('Refusal')
)
export type Refusal = typeof Refusal.Type

/** Identifies an objective; a UUID the caller generates, so creating it again is harmless. */
export const ObjectiveId = Uuid.pipe(Schema.brand('ObjectiveId'))
export type ObjectiveId = typeof ObjectiveId.Type

/** Identifies an issue; a UUID the caller generates, so creating it again is harmless. */
export const IssueId = Uuid.pipe(Schema.brand('IssueId'))
export type IssueId = typeof IssueId.Type

/** The longest a {@link WorkTitle} may be, in characters. */
export const WORK_TITLE_MAX_LENGTH = 120

/** An objective's or an issue's title: trimmed, 1 to {@link WORK_TITLE_MAX_LENGTH} characters. */
export const WorkTitle = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(WORK_TITLE_MAX_LENGTH)),
  Schema.brand('WorkTitle')
)
export type WorkTitle = typeof WorkTitle.Type

/** How soon an objective's issues start when the overall cap is full: `high` first, `low` last. */
export const ObjectivePriority = Schema.Literals(['high', 'normal', 'low'])
export type ObjectivePriority = typeof ObjectivePriority.Type

/** The order objectives of each priority come in, lowest first: `high` is 0, `low` is 2. */
export const PRIORITY_RANK: Record<ObjectivePriority, number> = { high: 0, normal: 1, low: 2 }

/** The label the screens show for each priority. */
export const PRIORITY_LABELS: Record<ObjectivePriority, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low'
}

/**
 * An objective is `completed` when it has issues and every one is `done` or `canceled`; otherwise
 * `open`.
 */
export const ObjectiveState = Schema.Literals(['open', 'completed'])
export type ObjectiveState = typeof ObjectiveState.Type

/**
 * A `work` issue does the objective's work; a `retro` issue reviews a finished `work` issue
 * (ADR-0064); the `planning` issue, one per objective, breaks the objective into `triage` issues.
 */
export const IssueKind = Schema.Literals(['work', 'retro', 'planning'])
export type IssueKind = typeof IssueKind.Type

/**
 * The statuses an assignee moves its own issue through while its session works on it, in
 * implement-task order; any order is allowed. An issue in one of them holds its assignee.
 */
export const StartedStatus = Schema.Literals([
  'understanding',
  'designing',
  'implementing',
  'testing',
  'verifying',
  'in_review'
])
export type StartedStatus = typeof StartedStatus.Type

/**
 * An issue's status. `triage`: an agent proposed it and the user has not accepted it, or its
 * provider refused to start it. `todo`: not started, or its session ended. A {@link StartedStatus}:
 * its assignee works on it. `done` and `canceled` are closed.
 */
export const IssueStatus = Schema.Literals([
  'triage',
  'todo',
  ...StartedStatus.literals,
  'done',
  'canceled'
])
export type IssueStatus = typeof IssueStatus.Type

const isStartedStatus = Schema.is(StartedStatus)

/** Whether an issue in `status` can be given to or taken from an assignee: `triage` or `todo`. */
export const isAssignable = (status: IssueStatus): boolean =>
  status === 'triage' || status === 'todo'

/** Whether `status` is a {@link StartedStatus}: the issue's assignee works on it. */
export const isStarted = (status: IssueStatus): status is StartedStatus => isStartedStatus(status)

/** Whether `status` is closed: `done` or `canceled`. */
export const isClosed = (status: IssueStatus): boolean => status === 'done' || status === 'canceled'

/** The longest an {@link IssueDescription} may be, in characters. */
export const ISSUE_DESCRIPTION_MAX_LENGTH = 10_000

/** An issue's description: up to {@link ISSUE_DESCRIPTION_MAX_LENGTH} characters; may be empty. */
export const IssueDescription = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_LENGTH))
)
export type IssueDescription = typeof IssueDescription.Type

/**
 * An objective in a registered project (ADR-0033). `assignee` is who the objective is given to, or
 * null; `createdAt` is epoch milliseconds.
 */
export const Objective = Schema.Struct({
  id: ObjectiveId,
  projectId: ProjectId,
  title: WorkTitle,
  description: Schema.String,
  priority: ObjectivePriority,
  assignee: Schema.NullOr(AssigneeRef),
  state: ObjectiveState,
  createdAt: Schema.Number
})
export type Objective = typeof Objective.Type

/**
 * An issue of an objective. `parentIssueId` is the issue it belongs under; for a `retro` issue, the
 * issue it reviews. `assignee` is who runs it, or null; an issue with no assignee never starts.
 * `paneId` is fixed when the issue is created and names its session's pane. `sessionId` is the
 * session its next start resumes, or null for a new session. `refusal` is why its provider refused
 * to start it; it is non-null only while `status` is `triage`. `createdAt` is epoch milliseconds.
 */
export const Issue = Schema.Struct({
  id: IssueId,
  objectiveId: ObjectiveId,
  parentIssueId: Schema.NullOr(IssueId),
  kind: IssueKind,
  title: WorkTitle,
  description: IssueDescription,
  status: IssueStatus,
  assignee: Schema.NullOr(AssigneeRef),
  paneId: Uuid,
  sessionId: Schema.NullOr(SessionId),
  refusal: Schema.NullOr(Refusal),
  createdAt: Schema.Number
})
export type Issue = typeof Issue.Type

/** What creating an objective takes; `id` is generated by the caller. */
export const NewObjective = Schema.Struct({
  id: ObjectiveId,
  projectId: ProjectId,
  title: WorkTitle,
  description: Schema.String,
  priority: ObjectivePriority,
  assignee: Schema.NullOr(AssigneeRef)
})
export type NewObjective = typeof NewObjective.Type

/** One of the issues an objective is created with: `work`, or the objective's `planning` issue. */
export const FirstIssue = Schema.Struct({
  kind: Schema.Literals(['work', 'planning']),
  title: WorkTitle,
  description: IssueDescription,
  assignee: Schema.NullOr(AssigneeRef)
})
export type FirstIssue = typeof FirstIssue.Type

/**
 * A `work` issue added to an existing objective; it lands in `todo`. `id` is generated by the
 * caller. `parentIssueId`, when set, must be an issue of the same objective.
 */
export const NewWorkIssue = Schema.Struct({
  id: IssueId,
  objectiveId: ObjectiveId,
  parentIssueId: Schema.NullOr(IssueId),
  title: WorkTitle,
  description: IssueDescription,
  assignee: Schema.NullOr(AssigneeRef)
})
export type NewWorkIssue = typeof NewWorkIssue.Type

/**
 * What an assignee's proposing a `work` issue takes; it lands in `triage`, unassigned.
 * `parentIssueId`, when set, must be an issue of the same objective.
 */
export const ProposedIssue = Schema.Struct({
  parentIssueId: Schema.NullOr(IssueId),
  title: WorkTitle,
  description: IssueDescription
})
export type ProposedIssue = typeof ProposedIssue.Type

/**
 * What an assignee's updating an issue may change; an absent field is left as it is. `status`
 * applies only to a started issue; `title` and `description` only to an issue that is not closed.
 */
export const IssueChange = Schema.Struct({
  title: Schema.optionalKey(WorkTitle),
  description: Schema.optionalKey(IssueDescription),
  status: Schema.optionalKey(StartedStatus)
})
export type IssueChange = typeof IssueChange.Type

/** The user's decision on `triage` issues: `accept` moves them to `todo`, `decline` to `canceled`. */
export const TriageDecision = Schema.Literals(['accept', 'decline'])
export type TriageDecision = typeof TriageDecision.Type

/** Identifies a comment on an issue; a UUID. */
export const CommentId = Uuid.pipe(Schema.brand('CommentId'))
export type CommentId = typeof CommentId.Type

/** The longest a {@link CommentBody} may be, in characters. */
export const COMMENT_BODY_MAX_LENGTH = 10_000

/**
 * A comment's text: trimmed, 1 to {@link COMMENT_BODY_MAX_LENGTH} characters. Decode trimmed input:
 * the schema rejects leading or trailing spaces.
 */
export const CommentBody = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(COMMENT_BODY_MAX_LENGTH))
)
export type CommentBody = typeof CommentBody.Type

/**
 * Text an assignee attached to issue `issueId`. `author` is the assignee, or null when unknown.
 * `createdAt` is epoch milliseconds.
 */
export const IssueComment = Schema.Struct({
  id: CommentId,
  issueId: IssueId,
  author: Schema.NullOr(AssigneeRef),
  body: CommentBody,
  createdAt: Schema.Number
})
export type IssueComment = typeof IssueComment.Type

/** Every objective, issue and comment, each in creation order. */
export const IssuesSnapshot = Schema.Struct({
  objectives: Schema.Array(Objective),
  issues: Schema.Array(Issue),
  comments: Schema.Array(IssueComment)
})
export type IssuesSnapshot = typeof IssuesSnapshot.Type

/**
 * One assignee a provider lists now: its `id`, the `name` to show, and `detail` to show under it
 * (the org shows the job title).
 */
export const ListedAssignee = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  detail: Schema.String
})
export type ListedAssignee = typeof ListedAssignee.Type

/** The assignees one held provider lists now, with its label. */
export const AssigneeGroup = Schema.Struct({
  provider: ProviderId,
  label: Schema.String,
  assignees: Schema.Array(ListedAssignee)
})
export type AssigneeGroup = typeof AssigneeGroup.Type

/** Failure of creating an issue: no objective has id `objectiveId`. */
export class ObjectiveNotFound extends Schema.TaggedError<ObjectiveNotFound>()(
  'ObjectiveNotFound',
  { objectiveId: ObjectiveId }
) {}

/**
 * Failure of an issue change: no issue has id `issueId`, or it is in another objective than the
 * one the change names (a parent issue's, or an assignee's session's).
 */
export class IssueNotFound extends Schema.TaggedError<IssueNotFound>()('IssueNotFound', {
  issueId: IssueId
}) {}

/** Failure of creating an objective: no registered project has id `projectId`. */
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()('ProjectNotFound', {
  projectId: ProjectId
}) {}

/** Failure of assigning: issue `issueId` is in `status`, neither `triage` nor `todo`. */
export class IssueNotAssignable extends Schema.TaggedError<IssueNotAssignable>()(
  'IssueNotAssignable',
  { issueId: IssueId, status: IssueStatus }
) {}

/**
 * Failure of finishing an issue, or of changing its status: issue `issueId` is in `status`, which
 * is not started.
 */
export class IssueNotStarted extends Schema.TaggedError<IssueNotStarted>()('IssueNotStarted', {
  issueId: IssueId,
  status: IssueStatus
}) {}

/**
 * Failure of a triage decision: issue `issueId` is in `status`, neither `triage` nor the
 * decision's target.
 */
export class IssueNotInTriage extends Schema.TaggedError<IssueNotInTriage>()('IssueNotInTriage', {
  issueId: IssueId,
  status: IssueStatus
}) {}

/** Failure of changing an issue's title or description: issue `issueId` is closed (`status`). */
export class IssueClosed extends Schema.TaggedError<IssueClosed>()('IssueClosed', {
  issueId: IssueId,
  status: IssueStatus
}) {}

/** Failure of assigning or creating: no held provider lists `assignee`. */
export class AssigneeNotFound extends Schema.TaggedError<AssigneeNotFound>()('AssigneeNotFound', {
  assignee: AssigneeRef
}) {}

/** Failure of registering a provider: another registration holds `provider`. */
export class AssigneeProviderTaken extends Schema.TaggedError<AssigneeProviderTaken>()(
  'AssigneeProviderTaken',
  { provider: ProviderId }
) {}
