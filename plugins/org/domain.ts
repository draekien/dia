import { AgentName, Uuid } from '@dia/plugin'
import {
  AgentDefinition,
  AgentDefinitionEdit,
  AgentDefinitionId,
  AgentDefinitionName
} from '@dia-plugin/agent-definitions/registry'
import {
  IssueId,
  ProviderId,
  REFUSAL_MAX_LENGTH,
  Refusal,
  WORK_TITLE_MAX_LENGTH,
  WorkTitle
} from '@dia-plugin/issues/domain'
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

/**
 * The text of an issue the org refuses to start: `Cannot start: missing <names>`, cut to
 * `REFUSAL_MAX_LENGTH` characters. `missing` must not be empty.
 */
export const refusalOf = (missing: ReadonlyArray<MissingReference>): Refusal =>
  Refusal.make(
    `Cannot start: missing ${describeMissing(missing)}`.slice(0, REFUSAL_MAX_LENGTH).trim()
  )

/** The assignee provider id the org registers its hired agents under: `org`. */
export const ORG_PROVIDER = ProviderId.make('org')

/** `<prefix>: <title>`, cut to `WORK_TITLE_MAX_LENGTH` characters; for example `Plan: Ship it`. */
export const prefixedTitle = (prefix: string, title: WorkTitle): WorkTitle =>
  WorkTitle.make(`${prefix}: ${title}`.slice(0, WORK_TITLE_MAX_LENGTH).trimEnd())

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

/**
 * The state of hired agents' live sessions: the permission requests they wait on, and how many
 * slots of the overall cap are held now.
 */
export const LiveWork = Schema.Struct({
  pendingPermissions: Schema.Array(PendingPermission),
  heldSlots: Schema.Int
})
export type LiveWork = typeof LiveWork.Type

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

/**
 * Failure of dismissing: the `issues` plugin is not ready, so whether the hired agent is assigned
 * to an open issue cannot be checked.
 */
export class IssuesNotLoaded extends Schema.TaggedError<IssuesNotLoaded>()('IssuesNotLoaded', {}) {}
