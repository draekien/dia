import type {
  BuiltInRoleDeleted,
  BuiltInRoleRenamed,
  HiredAgent,
  HireId,
  HireNameTaken,
  HireNotFound,
  OrgSettings,
  OverallCap,
  Role,
  RoleDisabled,
  RoleEdit,
  RoleHasHires,
  RoleId,
  RoleName,
  RoleNameTaken,
  RoleNotFound
} from '@shared/domain/org'
import type { AgentName } from '@shared/domain/project'
import type { Effect } from 'effect'

/**
 * The org (ADR-0033), as the `org` plugin provides it under `ORG_KEY`. Reads return the current
 * state; each change is one transaction and returns the changed value. A role's cap is the number
 * of hired agents of that role. `roles` lists the built-in roles in seed order, then copies in
 * creation order; `hiredAgents` lists by `hiredAt`, then creation order. A database failure, or a
 * failure to generate an id, is a defect.
 *
 * `copyRole` copies every field of `roleId` into a new enabled role named `name` that is not
 * built in. `editRole` applies `edit`'s present fields. `deleteRole` deletes a copy with no hired
 * agents. `hire` hires an agent of an enabled role, named `name` or unnamed when null. `dismiss`
 * removes a hired agent.
 */
export interface Org {
  readonly roles: Effect.Effect<ReadonlyArray<Role>>
  readonly hiredAgents: Effect.Effect<ReadonlyArray<HiredAgent>>
  readonly settings: Effect.Effect<OrgSettings>
  readonly setRoleEnabled: (roleId: RoleId, enabled: boolean) => Effect.Effect<Role, RoleNotFound>
  readonly copyRole: (
    roleId: RoleId,
    name: RoleName
  ) => Effect.Effect<Role, RoleNotFound | RoleNameTaken>
  readonly editRole: (
    roleId: RoleId,
    edit: RoleEdit
  ) => Effect.Effect<Role, RoleNotFound | RoleNameTaken | BuiltInRoleRenamed>
  readonly deleteRole: (
    roleId: RoleId
  ) => Effect.Effect<void, RoleNotFound | BuiltInRoleDeleted | RoleHasHires>
  readonly hire: (
    roleId: RoleId,
    name: AgentName | null
  ) => Effect.Effect<HiredAgent, RoleNotFound | RoleDisabled | HireNameTaken>
  readonly dismiss: (hireId: HireId) => Effect.Effect<void, HireNotFound>
  readonly setOverallCap: (cap: OverallCap) => Effect.Effect<OrgSettings>
}
