import { AgentName, McpServer, PermissionRules, Uuid } from '@dia/plugin'
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

/** A job title's MCP servers, keyed by server name. */
const McpServers = Schema.Record(Schema.String, McpServer)

/**
 * A job title (ADR-0033, ADR-0064). `builtIn` is the built-in kind, or null for a copy. A disabled
 * job title cannot be hired into. `jobDescription` is appended to its sessions' system prompt. `skills` are skill names
 * as the Agent SDK's `Options.skills` takes them; empty means Claude Code's own skill set, so a
 * session of a job title with no skills omits `Options.skills` (`[]` would enable none).
 * `permissions` and `mcpServers` are what the job title adds to a session (`SessionToolOptions`);
 * `bypassOptIn` is the job title's `bypassPermissions` opt-in (ADR-0054).
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
  bypassOptIn: Schema.Boolean
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
  bypassOptIn: Schema.optionalKey(Schema.Boolean)
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

/** Failure of dismissing: no hired agent has id `hireId`. */
export class HireNotFound extends Schema.TaggedError<HireNotFound>()('HireNotFound', {
  hireId: HireId
}) {}

/** Failure of hiring: another hired agent already has `agentName`, ignoring ASCII case. */
export class HireNameTaken extends Schema.TaggedError<HireNameTaken>()('HireNameTaken', {
  agentName: AgentName
}) {}
