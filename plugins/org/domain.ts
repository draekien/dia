import { AgentName, ProjectId, SessionId, Uuid } from '@dia/plugin'
import {
  AgentDefinition,
  AgentDefinitionEdit,
  AgentDefinitionId,
  AgentDefinitionName
} from '@dia-plugin/agent-definitions/registry'
import { Schema } from 'effect'

/**
 * The kinds of the built-in job titles dia ships (ADR-0064, ADR-0071). A built-in job title keeps
 * its fixed name; its kind identifies it. `executive-assistant` is never hired: it runs the org's
 * one assistant session.
 */
export const BuiltInJobTitle = Schema.Literals([
  'product-manager',
  'software-engineer',
  'quality-engineer',
  'business-analyst',
  'ui-ux',
  'team-lead',
  'technical-lead',
  'executive-assistant'
])
export type BuiltInJobTitle = typeof BuiltInJobTitle.Type

/** A job title's id: the id of the agent definition it is. Built-in job titles have the same id on every install. */
export const JobTitleId = AgentDefinitionId
export type JobTitleId = typeof JobTitleId.Type

/** The longest a {@link JobTitleName} may be, in characters. */
export const JOB_TITLE_NAME_MAX_LENGTH = 40

/**
 * A job title's name: an agent definition name, trimmed, 1 to {@link JOB_TITLE_NAME_MAX_LENGTH}
 * characters, unique across job titles ignoring ASCII case. Decode trimmed input: the schema
 * rejects leading or trailing spaces.
 */
export const JobTitleName = AgentDefinitionName
export type JobTitleName = typeof JobTitleName.Type

/**
 * A job title (ADR-0033, ADR-0064, ADR-0072): an agent definition plus what only the org knows
 * about it. `builtIn` is the built-in kind, or null for any other definition. A disabled job title
 * cannot be hired into. The definition fields are what its sessions run with: `jobDescription` is
 * appended to the system prompt, `skills` and `mcpServers` are names a session resolves when it
 * starts (empty `skills` means Claude Code's own skill set), `permissions` are added to the
 * session, `bypassOptIn` is the `bypassPermissions` opt-in (ADR-0054), and `model` (null for the
 * first model the agent backend lists) and `thinkingLevel` are what its sessions open with.
 */
export const JobTitle = Schema.Struct({
  ...AgentDefinition.fields,
  builtIn: Schema.NullOr(BuiltInJobTitle),
  enabled: Schema.Boolean
})
export type JobTitle = typeof JobTitle.Type

/**
 * A change to a job title's definition fields; an absent field is left as it is. On a built-in job
 * title, `name` is refused when it differs from the current name. The name-taken check ignores the
 * job title being edited, so recasing a copy's own name is allowed.
 */
export const JobTitleEdit = AgentDefinitionEdit
export type JobTitleEdit = typeof JobTitleEdit.Type

/**
 * A name an agent definition holds that resolves to nothing: an MCP server the `mcp` registry
 * does not list, or a skill no skill source lists.
 */
export const MissingReference = Schema.Struct({
  kind: Schema.Literals(['mcp-server', 'skill']),
  name: Schema.String
})
export type MissingReference = typeof MissingReference.Type

/** Whether two lists hold the same {@link MissingReference}s in the same order. */
export const sameMissingReferences = Schema.toEquivalence(Schema.Array(MissingReference))

const MISSING_KIND_LABELS: Record<MissingReference['kind'], string> = {
  'mcp-server': 'MCP server',
  skill: 'skill'
}

/**
 * The text the org screens show after `missing `: each name with its kind, for example
 * `github (MCP server), dia-meta:plan (skill)`.
 */
export const describeMissing = (missing: ReadonlyArray<MissingReference>): string =>
  missing.map((entry) => `${entry.name} (${MISSING_KIND_LABELS[entry.kind]})`).join(', ')

/** Identifies a hired agent; a UUID. */
export const HireId = Uuid.pipe(Schema.brand('HireId'))
export type HireId = typeof HireId.Type

/**
 * A hired agent (ADR-0033): a job title plus an optional name, unique ignoring ASCII case when set.
 * `bypassOverride` overrides its job title's `bypassOptIn` when not null. `hiredAt` is epoch
 * milliseconds.
 */
export const HiredAgent = Schema.Struct({
  id: HireId,
  jobTitleId: JobTitleId,
  name: Schema.NullOr(AgentName),
  bypassOverride: Schema.NullOr(Schema.Boolean),
  reportsTo: Schema.NullOr(HireId),
  hiredAt: Schema.Number
})
export type HiredAgent = typeof HiredAgent.Type

/** The name of `agent`'s job title in `jobTitles`, or undefined when `jobTitles` lacks it. */
export const jobTitleName = (
  agent: HiredAgent,
  jobTitles: ReadonlyArray<JobTitle>
): string | undefined => jobTitles.find((jobTitle) => jobTitle.id === agent.jobTitleId)?.name

/** The name the org screens show for `agent`: its name, or `Unnamed <job title name>`. */
export const agentName = (agent: HiredAgent, jobTitles: ReadonlyArray<JobTitle>): string =>
  agent.name ?? `Unnamed ${jobTitleName(agent, jobTitles) ?? 'agent'}`

/** The most hired agents that run at once across every job title (ADR-0033); an integer of at least 1. */
export const OverallCap = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand('OverallCap')
)
export type OverallCap = typeof OverallCap.Type

/** The org's settings: its {@link OverallCap}. */
export const OrgSettings = Schema.Struct({ overallCap: OverallCap })
export type OrgSettings = typeof OrgSettings.Type

/** Failure of an `Org` change: no job title has id `jobTitleId`. */
export class JobTitleNotFound extends Schema.TaggedError<JobTitleNotFound>()('JobTitleNotFound', {
  jobTitleId: JobTitleId
}) {}

/**
 * Failure of copying or editing a job title: another job title already has `jobTitleName`,
 * ignoring ASCII case.
 */
export class JobTitleNameTaken extends Schema.TaggedError<JobTitleNameTaken>()(
  'JobTitleNameTaken',
  {
    jobTitleName: JobTitleName
  }
) {}

/** Failure of editing a job title: `jobTitleId` is built in and the edit changes its name. */
export class BuiltInJobTitleRenamed extends Schema.TaggedError<BuiltInJobTitleRenamed>()(
  'BuiltInJobTitleRenamed',
  { jobTitleId: JobTitleId }
) {}

/** Failure of deleting a job title: `jobTitleId` is built in, so it can only be disabled. */
export class BuiltInJobTitleDeleted extends Schema.TaggedError<BuiltInJobTitleDeleted>()(
  'BuiltInJobTitleDeleted',
  { jobTitleId: JobTitleId }
) {}

/** Failure of deleting a job title: `hires` agents of job title `jobTitleId` are still hired. */
export class JobTitleHasHires extends Schema.TaggedError<JobTitleHasHires>()('JobTitleHasHires', {
  jobTitleId: JobTitleId,
  hires: Schema.Int
}) {}

/** Failure of hiring: job title `jobTitleId` is disabled. */
export class JobTitleDisabled extends Schema.TaggedError<JobTitleDisabled>()('JobTitleDisabled', {
  jobTitleId: JobTitleId
}) {}

/**
 * Failure of hiring: job title `jobTitleId` is the built-in Executive assistant, which runs the
 * org's one assistant session and is never hired (ADR-0071).
 */
export class JobTitleNotHireable extends Schema.TaggedError<JobTitleNotHireable>()(
  'JobTitleNotHireable',
  { jobTitleId: JobTitleId }
) {}

/**
 * Failure of a change to a hired agent, or of a reporting line: no hired agent has id `hireId`,
 * which is the agent changed or the manager named by `reportsTo`.
 */
export class HireNotFound extends Schema.TaggedError<HireNotFound>()('HireNotFound', {
  hireId: HireId
}) {}

/** Failure of hiring: another hired agent already has `agentName`, ignoring ASCII case. */
export class HireNameTaken extends Schema.TaggedError<HireNameTaken>()('HireNameTaken', {
  agentName: AgentName
}) {}

/** Failure of setting a reporting line: `reportsTo` is `hireId` or already reports to `hireId`. */
export class ReportsToCycle extends Schema.TaggedError<ReportsToCycle>()('ReportsToCycle', {
  hireId: HireId,
  reportsTo: HireId
}) {}

/**
 * The ids of every agent in `hiredAgents` that reports to `hireId` through any chain of `reportsTo`
 * values, not including `hireId`. A reporting line from `hireId` to one of them, or to itself,
 * would form a cycle.
 */
export const descendantsOf = (
  hiredAgents: ReadonlyArray<HiredAgent>,
  hireId: HireId
): ReadonlySet<HireId> => {
  const below = new Set<HireId>()
  const visit = (manager: HireId) => {
    for (const agent of hiredAgents) {
      if (agent.reportsTo === manager && agent.id !== hireId && !below.has(agent.id)) {
        below.add(agent.id)
        visit(agent.id)
      }
    }
  }
  visit(hireId)
  return below
}

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

/** The label the org screens show for each priority. */
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
 * The statuses a hired agent moves its own issue through while its session works on it, in
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
 * An issue's status. `triage`: an agent proposed it and the user has not accepted it. `todo`: not
 * started, or its session ended; it starts when it has an assignee with no started issue and the
 * overall cap has a free slot. A {@link StartedStatus}: its hired agent works on it. `done` and
 * `canceled` are closed.
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

/** Whether an issue in `status` can be given to or taken from a hired agent: `triage` or `todo`. */
export const isAssignable = (status: IssueStatus): boolean =>
  status === 'triage' || status === 'todo'

/** Whether `status` is a {@link StartedStatus}: the issue's hired agent works on it. */
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
 * An objective in a registered project (ADR-0033). `assignee` is the hired agent the objective is
 * given to, or null; `createdAt` is epoch milliseconds.
 */
export const Objective = Schema.Struct({
  id: ObjectiveId,
  projectId: ProjectId,
  title: WorkTitle,
  description: Schema.String,
  priority: ObjectivePriority,
  assignee: Schema.NullOr(HireId),
  state: ObjectiveState,
  createdAt: Schema.Number
})
export type Objective = typeof Objective.Type

/**
 * An issue of an objective. `parentIssueId` is the issue it belongs under; for a `retro` issue, the
 * issue it reviews. `assignee` is the hired agent that runs it, or null; an issue with no assignee
 * never starts. `paneId` is fixed when the issue is created and names its session's pane.
 * `sessionId` is the session its next start resumes, or null for a new session. `missing` names
 * what its assignee's job title holds that resolves to nothing; it is non-empty only while
 * `status` is `triage`, after the dispatcher refused to start the issue. `createdAt` is epoch
 * milliseconds.
 */
export const Issue = Schema.Struct({
  id: IssueId,
  objectiveId: ObjectiveId,
  parentIssueId: Schema.NullOr(IssueId),
  kind: IssueKind,
  title: WorkTitle,
  description: IssueDescription,
  status: IssueStatus,
  assignee: Schema.NullOr(HireId),
  paneId: Uuid,
  sessionId: Schema.NullOr(SessionId),
  missing: Schema.Array(MissingReference),
  createdAt: Schema.Number
})
export type Issue = typeof Issue.Type

/**
 * Route `plan` (ADR-0053, ADR-0069): the objective's planning issue goes to `assignee`, or waits
 * for the user to assign it when null.
 */
export const PlanRoute = Schema.TaggedStruct('PlanRoute', { assignee: Schema.NullOr(HireId) })
export type PlanRoute = typeof PlanRoute.Type

/**
 * Route `direct` (ADR-0053, ADR-0071): the objective is one piece of work, a single `work` issue
 * for hired agent `assignee`, with no planning issue.
 */
export const DirectRoute = Schema.TaggedStruct('DirectRoute', { assignee: HireId })
export type DirectRoute = typeof DirectRoute.Type

/** How a new objective's first issue is created: {@link PlanRoute} or {@link DirectRoute}. */
export const ObjectiveRoute = Schema.Union([PlanRoute, DirectRoute])
export type ObjectiveRoute = typeof ObjectiveRoute.Type

/**
 * What creating an objective takes; `id` is generated by the caller. `route` decides its first
 * issue and its assignee.
 */
export const NewObjective = Schema.Struct({
  id: ObjectiveId,
  projectId: ProjectId,
  title: WorkTitle,
  description: Schema.String,
  priority: ObjectivePriority,
  route: ObjectiveRoute
})
export type NewObjective = typeof NewObjective.Type

/**
 * What the user's creating a `work` issue takes; it lands in `todo`. `id` is generated by the
 * caller. `parentIssueId`, when set, must be an issue of the same objective.
 */
export const NewIssue = Schema.Struct({
  id: IssueId,
  objectiveId: ObjectiveId,
  parentIssueId: Schema.NullOr(IssueId),
  title: WorkTitle,
  description: IssueDescription,
  assignee: Schema.NullOr(HireId)
})
export type NewIssue = typeof NewIssue.Type

/**
 * What a hired agent's proposing a `work` issue takes; it lands in `triage`, unassigned.
 * `parentIssueId`, when set, must be an issue of the same objective.
 */
export const ProposedIssue = Schema.Struct({
  parentIssueId: Schema.NullOr(IssueId),
  title: WorkTitle,
  description: IssueDescription
})
export type ProposedIssue = typeof ProposedIssue.Type

/**
 * What a hired agent's updating an issue may change; an absent field is left as it is. `status`
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
 * Text a hired agent attached to issue `issueId`. `author` is the hired agent, or null once it was
 * dismissed. `createdAt` is epoch milliseconds.
 */
export const IssueComment = Schema.Struct({
  id: CommentId,
  issueId: IssueId,
  author: Schema.NullOr(HireId),
  body: CommentBody,
  createdAt: Schema.Number
})
export type IssueComment = typeof IssueComment.Type

/**
 * A permission request a hired agent's session waits on: the tool `toolName` with `input`. Answer
 * it with the `AnswerPermission` call, naming `issueId` and `requestId`.
 */
export const PendingPermission = Schema.Struct({
  issueId: IssueId,
  requestId: Schema.String,
  toolName: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown)
})
export type PendingPermission = typeof PendingPermission.Type

/** Every objective, issue and comment, in creation order. */
export const WorkSnapshot = Schema.Struct({
  objectives: Schema.Array(Objective),
  issues: Schema.Array(Issue),
  comments: Schema.Array(IssueComment)
})
export type WorkSnapshot = typeof WorkSnapshot.Type

/**
 * The state of hired agents' live sessions: the permission requests they wait on, and how many
 * slots of the overall cap are held now.
 */
export const LiveWork = Schema.Struct({
  pendingPermissions: Schema.Array(PendingPermission),
  heldSlots: Schema.Int
})
export type LiveWork = typeof LiveWork.Type

/** Failure of creating an issue: no objective has id `objectiveId`. */
export class ObjectiveNotFound extends Schema.TaggedError<ObjectiveNotFound>()(
  'ObjectiveNotFound',
  { objectiveId: ObjectiveId }
) {}

/**
 * Failure of an issue change: no issue has id `issueId`, or it is in another objective than the
 * one the change names (a parent issue's, or a hired agent's session's).
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

/** Failure of answering: issue `issueId`'s live session never asked permission `requestId`. */
export class PermissionNotPending extends Schema.TaggedError<PermissionNotPending>()(
  'PermissionNotPending',
  { issueId: IssueId, requestId: Schema.String }
) {}

/**
 * Failure of dismissing: hired agent `hireId` is assigned to `issues` issues that are neither
 * `done` nor `canceled`.
 */
export class HireHasOpenIssues extends Schema.TaggedError<HireHasOpenIssues>()(
  'HireHasOpenIssues',
  { hireId: HireId, issues: Schema.Int }
) {}
