import { AgentName, ProjectId } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import {
  AssistantDisabled,
  BuiltInJobTitleDeleted,
  BuiltInJobTitleRenamed,
  HiredAgent,
  HireHasOpenIssues,
  HireId,
  HireNameTaken,
  HireNotFound,
  IssuesNotLoaded,
  JobTitle,
  JobTitleDisabled,
  JobTitleEdit,
  JobTitleHasHires,
  JobTitleId,
  JobTitleName,
  JobTitleNameTaken,
  JobTitleNotFound,
  JobTitleNotHireable,
  OrgSettings,
  OverallCap,
  ReportsToCycle,
  TeamPlan
} from './domain'

/**
 * What the org screens show: every job title, every hired agent, the org settings, and whether any
 * session could start in `bypassPermissions` (false when managed or user Claude Code settings
 * disable it, or no agent backend is provided; ADR-0054), and `worktreeProjects`, the projects whose
 * issues run in their own git worktrees.
 */
export const OrgSnapshot = Schema.Struct({
  jobTitles: Schema.Array(JobTitle),
  hiredAgents: Schema.Array(HiredAgent),
  settings: OrgSettings,
  bypassAvailable: Schema.Boolean,
  worktreeProjects: Schema.Array(ProjectId)
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
  error: Schema.Union([
    JobTitleNotFound,
    JobTitleDisabled,
    JobTitleNotHireable,
    HireNameTaken,
    HireNotFound
  ])
})

/**
 * Hires `plan` in one transaction: the lead reports to the user, and every member reports to the
 * lead, or to the user when there is no lead. Every hire is unnamed. Fails, hiring nobody, when a
 * job title is missing, disabled or the Executive assistant.
 */
export const StaffTeam = Rpc.make('StaffTeam', {
  payload: { plan: TeamPlan },
  success: Schema.Array(HiredAgent),
  error: Schema.Union([JobTitleNotFound, JobTitleDisabled, JobTitleNotHireable])
})

/**
 * Dismisses hired agent `hireId`; refused while it is assigned to an issue that is neither `done`
 * nor `canceled`, and while the `issues` plugin is not ready to tell.
 */
export const Dismiss = Rpc.make('Dismiss', {
  payload: { hireId: HireId },
  error: Schema.Union([HireNotFound, HireHasOpenIssues, IssuesNotLoaded])
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
 * Sets whether issues of project `projectId` run in their own git worktrees; the setting applies
 * to projects that are git repositories. Returns the projects that now run issues in worktrees.
 */
export const SetProjectWorktrees = Rpc.make('SetProjectWorktrees', {
  payload: { projectId: ProjectId, enabled: Schema.Boolean },
  success: Schema.Array(ProjectId)
})

/**
 * The org's live state the Dashboard shows: `assistantEnabled`, whether the built-in Executive
 * assistant job title is enabled, so it takes requests; `assistantRunId`, the Executive assistant's
 * run, null before its first request or after Start over; `teamHasWork`, whether any hired agent
 * has an open issue.
 */
export const OrgLive = Schema.Struct({
  assistantEnabled: Schema.Boolean,
  assistantRunId: Schema.NullOr(Schema.String),
  teamHasWork: Schema.Boolean
})
export type OrgLive = typeof OrgLive.Type

/** Streams the {@link OrgLive}: the current one when subscribed, then a new one after each change. */
export const WatchOrgLive = Rpc.make('WatchOrgLive', {
  payload: {},
  success: OrgLive,
  stream: true
})

/**
 * Sends `text` to the Executive assistant, starting its run when it has none, and returns the
 * run's id; show it with `dia-runs`' `OpenRunInTab`. Served while `dia-runs` is provided.
 */
export const AskAssistant = Rpc.make('AskAssistant', {
  payload: { text: Schema.NonEmptyString },
  success: Schema.String,
  error: AssistantDisabled
})

/** Archives the Executive assistant's run; the next request starts a new one. */
export const StartOverAssistant = Rpc.make('StartOverAssistant', { payload: {} })
