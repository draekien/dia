import { AgentName, PermissionResponse } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import {
  BuiltInJobTitleDeleted,
  BuiltInJobTitleRenamed,
  HiredAgent,
  HireHasOpenIssues,
  HireId,
  HireNameTaken,
  HireNotFound,
  Issue,
  IssueId,
  IssueNotAssignable,
  IssueNotFound,
  IssueNotInTriage,
  IssueNotStarted,
  JobTitle,
  JobTitleDisabled,
  JobTitleEdit,
  JobTitleHasHires,
  JobTitleId,
  JobTitleName,
  JobTitleNameTaken,
  JobTitleNotFound,
  LiveWork,
  NewIssue,
  NewObjective,
  Objective,
  ObjectiveNotFound,
  OrgSettings,
  OverallCap,
  PermissionNotPending,
  ProjectNotFound,
  ReportsToCycle,
  TriageDecision,
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

/**
 * Dismisses hired agent `hireId`; refused while it is assigned to an issue that is neither `done`
 * nor `canceled`.
 */
export const Dismiss = Rpc.make('Dismiss', {
  payload: { hireId: HireId },
  error: Schema.Union([HireNotFound, HireHasOpenIssues])
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
 * Every objective, issue and comment, the permission requests hired agents wait on, and how many slots of
 * the overall cap are held now.
 */
export const WorkView = Schema.Struct({
  ...WorkSnapshot.fields,
  ...LiveWork.fields
})
export type WorkView = typeof WorkView.Type

/** Reads the {@link WorkView}. */
export const ReadWork = Rpc.make('ReadWork', { payload: {}, success: WorkView })

/**
 * Streams the {@link WorkView}: the current one when subscribed, then a new one after each change
 * to objectives, issues and comments, held slots or pending permissions. Several changes during one read give
 * one more view, so a subscriber always ends on the latest state.
 */
export const WatchWork = Rpc.make('WatchWork', { payload: {}, success: WorkView, stream: true })

/**
 * Creates an open objective and its `planning` issue, assigned to the objective's assignee; a
 * repeated call with the same `id` returns the stored objective.
 */
export const CreateObjective = Rpc.make('CreateObjective', {
  payload: { objective: NewObjective },
  success: Objective,
  error: Schema.Union([ProjectNotFound, HireNotFound])
})

/**
 * Creates a `work` issue in `todo`, reopening a completed objective; a repeated call with the same
 * `id` returns the stored issue.
 */
export const CreateIssue = Rpc.make('CreateIssue', {
  payload: { issue: NewIssue },
  success: Issue,
  error: Schema.Union([ObjectiveNotFound, IssueNotFound, HireNotFound])
})

/**
 * Gives `triage` or `todo` issue `issueId` to hired agent `hireId`, or takes it from its agent when
 * null.
 */
export const AssignIssue = Rpc.make('AssignIssue', {
  payload: { issueId: IssueId, hireId: Schema.NullOr(HireId) },
  success: Issue,
  error: Schema.Union([IssueNotFound, IssueNotAssignable, HireNotFound])
})

/**
 * Accepts (to `todo`) or declines (to `canceled`) every `triage` issue in `issueIds`, all or none;
 * an issue already in the decision's target is left as it is. Returns the issues in `issueIds`
 * order.
 */
export const TriageIssues = Rpc.make('TriageIssues', {
  payload: { issueIds: Schema.NonEmptyArray(IssueId), decision: TriageDecision },
  success: Schema.Array(Issue),
  error: Schema.Union([IssueNotFound, IssueNotInTriage])
})

/**
 * Finishes started issue `issueId` and stops its session: it becomes `done`, and a `work` issue
 * gets a `retro` sub-issue in `todo`.
 */
export const FinishIssue = Rpc.make('FinishIssue', {
  payload: { issueId: IssueId },
  success: Issue,
  error: Schema.Union([IssueNotFound, IssueNotStarted])
})

/** Answers permission request `requestId` that issue `issueId`'s hired agent waits on. */
export const AnswerPermission = Rpc.make('AnswerPermission', {
  payload: { issueId: IssueId, requestId: Schema.String, response: PermissionResponse },
  success: Schema.Void,
  error: PermissionNotPending
})
