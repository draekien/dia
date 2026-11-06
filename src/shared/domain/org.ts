import { Schema } from 'effect'
import { AgentName } from './project'
import { PermissionRules, RoleMcpServer } from './role-session'
import { Uuid } from './uuid'

/** The built-in roles dia ships (ADR-0033, without `router`). A built-in role's name is its kind. */
export const BuiltInRole = Schema.Literals([
  'planner',
  'engineer',
  'reviewer',
  'researcher',
  'retro'
])
export type BuiltInRole = typeof BuiltInRole.Type

/** Identifies a role; a UUID. Built-in roles have the same id on every install. */
export const RoleId = Uuid.pipe(Schema.brand('RoleId'))
export type RoleId = typeof RoleId.Type

/** The longest a {@link RoleName} may be, in characters. */
export const ROLE_NAME_MAX_LENGTH = 40

/**
 * A role's name: trimmed, 1 to {@link ROLE_NAME_MAX_LENGTH} characters, unique across roles
 * ignoring ASCII case. Decode trimmed input: the schema rejects leading or trailing spaces.
 */
export const RoleName = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(ROLE_NAME_MAX_LENGTH)),
  Schema.brand('RoleName')
)
export type RoleName = typeof RoleName.Type

/** A role's skills: skill names as the Agent SDK's `Options.skills` takes them. */
const Skills = Schema.Array(Schema.String)

/** A role's MCP servers, keyed by server name. */
const McpServers = Schema.Record(Schema.String, RoleMcpServer)

/**
 * A role (ADR-0033). `builtIn` is the built-in kind, or null for a copy. A disabled role cannot be
 * hired into. `instructions` is appended to its sessions' system prompt. `skills` are skill names
 * as the Agent SDK's `Options.skills` takes them; empty means Claude Code's own skill set, so a
 * session of a role with no skills omits `Options.skills` (`[]` would enable none).
 * `permissions` and `mcpServers` are what the role adds to a session (`RoleSessionOptions`);
 * `bypassOptIn` is the role's `bypassPermissions` opt-in (ADR-0054).
 */
export const Role = Schema.Struct({
  id: RoleId,
  name: RoleName,
  builtIn: Schema.NullOr(BuiltInRole),
  enabled: Schema.Boolean,
  instructions: Schema.String,
  skills: Skills,
  permissions: PermissionRules,
  mcpServers: McpServers,
  bypassOptIn: Schema.Boolean
})
export type Role = typeof Role.Type

/**
 * A change to a role's editable fields; an absent field is left as it is. On a built-in role,
 * `name` is refused when it differs from the current name. The name-taken check ignores the role
 * being edited, so recasing a copy's own name is allowed.
 */
export const RoleEdit = Schema.Struct({
  name: Schema.optionalKey(RoleName),
  instructions: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Skills),
  permissions: Schema.optionalKey(PermissionRules),
  mcpServers: Schema.optionalKey(McpServers),
  bypassOptIn: Schema.optionalKey(Schema.Boolean)
})
export type RoleEdit = typeof RoleEdit.Type

/** Identifies a hired agent; a UUID. */
export const HireId = Uuid.pipe(Schema.brand('HireId'))
export type HireId = typeof HireId.Type

/**
 * A hired agent (ADR-0033): a role plus an optional name, unique ignoring ASCII case when set.
 * `bypassOverride` overrides its role's `bypassOptIn` when not null. `hiredAt` is epoch
 * milliseconds.
 */
export const HiredAgent = Schema.Struct({
  id: HireId,
  roleId: RoleId,
  name: Schema.NullOr(AgentName),
  bypassOverride: Schema.NullOr(Schema.Boolean),
  hiredAt: Schema.Number
})
export type HiredAgent = typeof HiredAgent.Type

/** The most hired agents that run at once across every role (ADR-0033); an integer of at least 1. */
export const OverallCap = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand('OverallCap')
)
export type OverallCap = typeof OverallCap.Type

/** The org's settings: its {@link OverallCap}. */
export const OrgSettings = Schema.Struct({ overallCap: OverallCap })
export type OrgSettings = typeof OrgSettings.Type

/** Failure of an `Org` change: no role has id `roleId`. */
export class RoleNotFound extends Schema.TaggedError<RoleNotFound>()('RoleNotFound', {
  roleId: RoleId
}) {}

/** Failure of copying or editing a role: another role already has `roleName`, ignoring ASCII case. */
export class RoleNameTaken extends Schema.TaggedError<RoleNameTaken>()('RoleNameTaken', {
  roleName: RoleName
}) {}

/** Failure of editing a role: `roleId` is a built-in role and the edit changes its name. */
export class BuiltInRoleRenamed extends Schema.TaggedError<BuiltInRoleRenamed>()(
  'BuiltInRoleRenamed',
  { roleId: RoleId }
) {}

/** Failure of deleting a role: `roleId` is a built-in role, which can only be disabled. */
export class BuiltInRoleDeleted extends Schema.TaggedError<BuiltInRoleDeleted>()(
  'BuiltInRoleDeleted',
  { roleId: RoleId }
) {}

/** Failure of deleting a role: `hires` agents of role `roleId` are still hired. */
export class RoleHasHires extends Schema.TaggedError<RoleHasHires>()('RoleHasHires', {
  roleId: RoleId,
  hires: Schema.Int
}) {}

/** Failure of hiring: role `roleId` is disabled. */
export class RoleDisabled extends Schema.TaggedError<RoleDisabled>()('RoleDisabled', {
  roleId: RoleId
}) {}

/** Failure of dismissing: no hired agent has id `hireId`. */
export class HireNotFound extends Schema.TaggedError<HireNotFound>()('HireNotFound', {
  hireId: HireId
}) {}

/** Failure of hiring: another hired agent already has `agentName`, ignoring ASCII case. */
export class HireNameTaken extends Schema.TaggedError<HireNameTaken>()('HireNameTaken', {
  agentName: AgentName
}) {}
