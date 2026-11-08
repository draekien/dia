import { AgentName, PermissionRules, ProjectId, SessionId, ThinkingLevel, Uuid } from '@dia/plugin'
import { McpServers } from '@dia-plugin/mcp/servers'
import { Schema } from 'effect'

/**
 * The kinds of the built-in job titles dia ships (ADR-0064; `router`, ADR-0053, is not one). A
 * built-in job title keeps its fixed name; its kind identifies it.
 */
export const BuiltInJobTitle = Schema.Literals([
  'product-manager',
  'software-engineer',
  'quality-engineer',
  'business-analyst',
  'ui-ux',
  'team-lead',
  'technical-lead'
])
export type BuiltInJobTitle = typeof BuiltInJobTitle.Type

/** Identifies a job title; a UUID. Built-in job titles have the same id on every install. */
export const JobTitleId = Uuid.pipe(Schema.brand('JobTitleId'))
export type JobTitleId = typeof JobTitleId.Type

/** The longest a {@link JobTitleName} may be, in characters. */
export const JOB_TITLE_NAME_MAX_LENGTH = 40

/**
 * A job title's name: trimmed, 1 to {@link JOB_TITLE_NAME_MAX_LENGTH} characters, unique across job titles
 * ignoring ASCII case. Decode trimmed input: the schema rejects leading or trailing spaces.
 */
export const JobTitleName = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(JOB_TITLE_NAME_MAX_LENGTH)),
  Schema.brand('JobTitleName')
)
export type JobTitleName = typeof JobTitleName.Type

/** A job title's skills: skill names as the Agent SDK's `Options.skills` takes them. */
const Skills = Schema.Array(Schema.String)

/**
 * A job title (ADR-0033, ADR-0064). `builtIn` is the built-in kind, or null for a copy. A disabled
 * job title cannot be hired into. `jobDescription` is appended to its sessions' system prompt. `skills` are skill names
 * as the Agent SDK's `Options.skills` takes them; empty means Claude Code's own skill set, so a
 * session of a job title with no skills omits `Options.skills` (`[]` would enable none).
 * `permissions` and `mcpServers` are what the job title adds to a session (`SessionToolOptions`);
 * `bypassOptIn` is the job title's `bypassPermissions` opt-in (ADR-0054). `model` is the model
 * value its sessions open with, or null for the first model the agent backend lists;
 * `thinkingLevel` is the thinking level they open with.
 */
export const JobTitle = Schema.Struct({
  id: JobTitleId,
  name: JobTitleName,
  builtIn: Schema.NullOr(BuiltInJobTitle),
  enabled: Schema.Boolean,
  jobDescription: Schema.String,
  skills: Skills,
  permissions: PermissionRules,
  mcpServers: McpServers,
  bypassOptIn: Schema.Boolean,
  model: Schema.NullOr(Schema.NonEmptyString),
  thinkingLevel: ThinkingLevel
})
export type JobTitle = typeof JobTitle.Type

/**
 * A change to a job title's editable fields; an absent field is left as it is. On a built-in job
 * title, `name` is refused when it differs from the current name. The name-taken check ignores the job title
 * being edited, so recasing a copy's own name is allowed.
 */
export const JobTitleEdit = Schema.Struct({
  name: Schema.optionalKey(JobTitleName),
  jobDescription: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Skills),
  permissions: Schema.optionalKey(PermissionRules),
  mcpServers: Schema.optionalKey(McpServers),
  bypassOptIn: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(JobTitle.fields.model),
  thinkingLevel: Schema.optionalKey(ThinkingLevel)
})
export type JobTitleEdit = typeof JobTitleEdit.Type

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

/** Identifies a task; a UUID the caller generates, so creating it again is harmless. */
export const TaskId = Uuid.pipe(Schema.brand('TaskId'))
export type TaskId = typeof TaskId.Type

/** The longest a {@link WorkTitle} may be, in characters. */
export const WORK_TITLE_MAX_LENGTH = 120

/** An objective's or a task's title: trimmed, 1 to {@link WORK_TITLE_MAX_LENGTH} characters. */
export const WorkTitle = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(WORK_TITLE_MAX_LENGTH)),
  Schema.brand('WorkTitle')
)
export type WorkTitle = typeof WorkTitle.Type

/** How soon an objective's tasks start when the overall cap is full: `high` first, `low` last. */
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

/** An objective is `completed` when it has tasks and every one is `completed`; otherwise `open`. */
export const ObjectiveState = Schema.Literals(['open', 'completed'])
export type ObjectiveState = typeof ObjectiveState.Type

/** A `work` task does the objective's work; a `retro` task reviews a finished task (ADR-0064). */
export const TaskKind = Schema.Literals(['work', 'retro'])
export type TaskKind = typeof TaskKind.Type

/**
 * A task's progress. `waiting`: not started, or its session ended; it starts when it has an
 * assignee whose other tasks are not `running` and the overall cap has a free slot. `running`: its
 * hired agent has a session for it. `finished`: its work is done and its retro task is not yet
 * completed. `completed`: done. A `retro` task goes from `running` to `completed`.
 */
export const TaskState = Schema.Literals(['waiting', 'running', 'finished', 'completed'])
export type TaskState = typeof TaskState.Type

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
 * A task of an objective. `parentTaskId` is the task it belongs under; for a `retro` task, the task
 * it reviews. `assignee` is the hired agent that runs it, or null; a task with no assignee never
 * starts. `paneId` is fixed when the task is created and names its session's pane. `sessionId` is
 * the session its next start resumes, or null for a new session. `createdAt` is epoch milliseconds.
 */
export const Task = Schema.Struct({
  id: TaskId,
  objectiveId: ObjectiveId,
  parentTaskId: Schema.NullOr(TaskId),
  kind: TaskKind,
  title: WorkTitle,
  state: TaskState,
  assignee: Schema.NullOr(HireId),
  paneId: Uuid,
  sessionId: Schema.NullOr(SessionId),
  createdAt: Schema.Number
})
export type Task = typeof Task.Type

/** What creating an objective takes; `id` is generated by the caller. */
export const NewObjective = Schema.Struct({
  id: ObjectiveId,
  projectId: ProjectId,
  title: WorkTitle,
  description: Schema.String,
  priority: ObjectivePriority,
  assignee: Schema.NullOr(HireId)
})
export type NewObjective = typeof NewObjective.Type

/**
 * What creating a `work` task takes; `id` is generated by the caller. `parentTaskId`, when set,
 * must be a task of the same objective.
 */
export const NewTask = Schema.Struct({
  id: TaskId,
  objectiveId: ObjectiveId,
  parentTaskId: Schema.NullOr(TaskId),
  title: WorkTitle,
  assignee: Schema.NullOr(HireId)
})
export type NewTask = typeof NewTask.Type

/**
 * A permission request a hired agent's session waits on: the tool `toolName` with `input`. Answer
 * it with the `AnswerPermission` call, naming `taskId` and `requestId`.
 */
export const PendingPermission = Schema.Struct({
  taskId: TaskId,
  requestId: Schema.String,
  toolName: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown)
})
export type PendingPermission = typeof PendingPermission.Type

/** Every objective and task, in creation order. */
export const WorkSnapshot = Schema.Struct({
  objectives: Schema.Array(Objective),
  tasks: Schema.Array(Task)
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

/** Failure of creating a task: no objective has id `objectiveId`. */
export class ObjectiveNotFound extends Schema.TaggedError<ObjectiveNotFound>()(
  'ObjectiveNotFound',
  { objectiveId: ObjectiveId }
) {}

/** Failure of a task change: no task has id `taskId`, or a parent task is in another objective. */
export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()('TaskNotFound', {
  taskId: TaskId
}) {}

/** Failure of creating an objective: no registered project has id `projectId`. */
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()('ProjectNotFound', {
  projectId: ProjectId
}) {}

/** Failure of assigning: task `taskId` has started (`state`), so its assignee cannot change. */
export class TaskNotWaiting extends Schema.TaggedError<TaskNotWaiting>()('TaskNotWaiting', {
  taskId: TaskId,
  state: TaskState
}) {}

/** Failure of finishing: task `taskId` is `waiting`, so it has not run. */
export class TaskNotRunning extends Schema.TaggedError<TaskNotRunning>()('TaskNotRunning', {
  taskId: TaskId
}) {}

/** Failure of answering: task `taskId`'s live session never asked permission `requestId`. */
export class PermissionNotPending extends Schema.TaggedError<PermissionNotPending>()(
  'PermissionNotPending',
  { taskId: TaskId, requestId: Schema.String }
) {}

/** Failure of dismissing: hired agent `hireId` is assigned to `tasks` tasks not yet completed. */
export class HireHasOpenTasks extends Schema.TaggedError<HireHasOpenTasks>()('HireHasOpenTasks', {
  hireId: HireId,
  tasks: Schema.Int
}) {}
