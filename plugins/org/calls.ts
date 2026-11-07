import { AgentName, PermissionResponse } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import {
  BuiltInJobTitleDeleted,
  BuiltInJobTitleRenamed,
  HiredAgent,
  HireHasOpenTasks,
  HireId,
  HireNameTaken,
  HireNotFound,
  JobTitle,
  JobTitleDisabled,
  JobTitleEdit,
  JobTitleHasHires,
  JobTitleId,
  JobTitleName,
  JobTitleNameTaken,
  JobTitleNotFound,
  LiveWork,
  NewObjective,
  NewTask,
  Objective,
  ObjectiveNotFound,
  OrgSettings,
  OverallCap,
  PermissionNotPending,
  ProjectNotFound,
  ReportsToCycle,
  Task,
  TaskId,
  TaskNotFound,
  TaskNotRunning,
  TaskNotWaiting,
  WorkSnapshot
} from './domain'

/**
 * What the org screens show: every job title, every hired agent, the org settings, and whether any
 * session could start in `bypassPermissions` (false when managed or user Claude Code settings
 * disable it, or no agent backend is provided; ADR-0054).
 */
export const OrgSnapshot = Schema.Struct({
  jobTitles: Schema.Array(JobTitle),
  hiredAgents: Schema.Array(HiredAgent),
  settings: OrgSettings,
  bypassAvailable: Schema.Boolean
})
export type OrgSnapshot = typeof OrgSnapshot.Type

/** The `org` plugin's renderer entry reads the {@link OrgSnapshot} from its host entry. */
export const ReadOrg = Rpc.make('ReadOrg', { payload: {}, success: OrgSnapshot })

/** Enables or disables job title `jobTitleId`; a disabled job title cannot be hired into. */
export const SetJobTitleEnabled = Rpc.make('SetJobTitleEnabled', {
  payload: { jobTitleId: JobTitleId, enabled: Schema.Boolean },
  success: JobTitle,
  error: JobTitleNotFound
})

/** Copies job title `jobTitleId` into a new enabled job title named `name`. */
export const CopyJobTitle = Rpc.make('CopyJobTitle', {
  payload: { jobTitleId: JobTitleId, name: JobTitleName },
  success: JobTitle,
  error: Schema.Union([JobTitleNotFound, JobTitleNameTaken])
})

/** Applies `edit`'s present fields to job title `jobTitleId`. */
export const EditJobTitle = Rpc.make('EditJobTitle', {
  payload: { jobTitleId: JobTitleId, edit: JobTitleEdit },
  success: JobTitle,
  error: Schema.Union([JobTitleNotFound, JobTitleNameTaken, BuiltInJobTitleRenamed])
})

/** Deletes job title `jobTitleId`, a copy with no hired agents. */
export const DeleteJobTitle = Rpc.make('DeleteJobTitle', {
  payload: { jobTitleId: JobTitleId },
  error: Schema.Union([JobTitleNotFound, BuiltInJobTitleDeleted, JobTitleHasHires])
})

/**
 * Hires an agent of job title `jobTitleId`, named `name` or unnamed when null, reporting to hired
 * agent `reportsTo` or to the user when null.
 */
export const Hire = Rpc.make('Hire', {
  payload: {
    jobTitleId: JobTitleId,
    name: Schema.NullOr(AgentName),
    reportsTo: Schema.NullOr(HireId)
  },
  success: HiredAgent,
  error: Schema.Union([JobTitleNotFound, JobTitleDisabled, HireNameTaken, HireNotFound])
})

/** Dismisses hired agent `hireId`; refused while it is assigned to a task not yet completed. */
export const Dismiss = Rpc.make('Dismiss', {
  payload: { hireId: HireId },
  error: Schema.Union([HireNotFound, HireHasOpenTasks])
})

/** Names hired agent `hireId` `name`, or clears its name when null. */
export const RenameHire = Rpc.make('RenameHire', {
  payload: { hireId: HireId, name: Schema.NullOr(AgentName) },
  success: HiredAgent,
  error: Schema.Union([HireNotFound, HireNameTaken])
})

/** Sets hired agent `hireId`'s bypass override; null follows its job title. */
export const SetBypassOverride = Rpc.make('SetBypassOverride', {
  payload: { hireId: HireId, override: Schema.NullOr(Schema.Boolean) },
  success: HiredAgent,
  error: HireNotFound
})

/** Makes hired agent `hireId` report to hired agent `reportsTo`, or to the user when null. */
export const SetReportsTo = Rpc.make('SetReportsTo', {
  payload: { hireId: HireId, reportsTo: Schema.NullOr(HireId) },
  success: HiredAgent,
  error: Schema.Union([HireNotFound, ReportsToCycle])
})

/** Sets the org's overall cap. */
export const SetOverallCap = Rpc.make('SetOverallCap', {
  payload: { cap: OverallCap },
  success: OrgSettings
})

/**
 * Every objective and task, the permission requests hired agents wait on, and how many slots of
 * the overall cap are held now.
 */
export const WorkView = Schema.Struct({
  ...WorkSnapshot.fields,
  ...LiveWork.fields
})
export type WorkView = typeof WorkView.Type

/** Reads the {@link WorkView}. */
export const ReadWork = Rpc.make('ReadWork', { payload: {}, success: WorkView })

/** Creates an open objective; a repeated call with the same `id` returns the stored objective. */
export const CreateObjective = Rpc.make('CreateObjective', {
  payload: { objective: NewObjective },
  success: Objective,
  error: Schema.Union([ProjectNotFound, HireNotFound])
})

/** Creates a waiting `work` task; a repeated call with the same `id` returns the stored task. */
export const CreateTask = Rpc.make('CreateTask', {
  payload: { task: NewTask },
  success: Task,
  error: Schema.Union([ObjectiveNotFound, TaskNotFound, HireNotFound])
})

/** Gives waiting task `taskId` to hired agent `hireId`, or takes it from its agent when null. */
export const AssignTask = Rpc.make('AssignTask', {
  payload: { taskId: TaskId, hireId: Schema.NullOr(HireId) },
  success: Task,
  error: Schema.Union([TaskNotFound, TaskNotWaiting, HireNotFound])
})

/**
 * Finishes running task `taskId` and stops its session: a `work` task becomes `finished` and gets
 * a retro task; a `retro` task, and the task it reviews, become `completed`.
 */
export const FinishTask = Rpc.make('FinishTask', {
  payload: { taskId: TaskId },
  success: Task,
  error: Schema.Union([TaskNotFound, TaskNotRunning])
})

/** Answers permission request `requestId` that task `taskId`'s hired agent waits on. */
export const AnswerPermission = Rpc.make('AnswerPermission', {
  payload: { taskId: TaskId, requestId: Schema.String, response: PermissionResponse },
  success: Schema.Void,
  error: PermissionNotPending
})
