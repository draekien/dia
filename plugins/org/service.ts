import { type AgentName, ServiceKey } from '@dia/plugin'
import { Effect, Predicate } from 'effect'
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
} from './domain'

/**
 * The org (ADR-0033), as the `org` plugin provides it under {@link OrgService}. Reads return the
 * current state; each change is one transaction and returns the changed value. A role's cap is the
 * number of hired agents of that role. `roles` lists the built-in roles in seed order, then copies
 * in creation order; `hiredAgents` lists by `hiredAt`, then creation order. A database failure, or
 * a failure to generate an id, is a defect.
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

const MEMBERS: Record<keyof Org, (member: unknown) => boolean> = {
  roles: Effect.isEffect,
  hiredAgents: Effect.isEffect,
  settings: Effect.isEffect,
  setRoleEnabled: Predicate.isFunction,
  copyRole: Predicate.isFunction,
  editRole: Predicate.isFunction,
  deleteRole: Predicate.isFunction,
  hire: Predicate.isFunction,
  dismiss: Predicate.isFunction,
  setOverallCap: Predicate.isFunction
}

/** Whether `value` has every {@link Org} member: the reads as effects, the changes as functions. */
export const isOrg = (value: unknown): value is Org =>
  Object.entries(MEMBERS).every(
    ([member, check]) => Predicate.hasProperty(value, member) && check(value[member])
  )

/** The key the `org` plugin provides its {@link Org} under; import it to read the org typed. */
export const OrgService = ServiceKey.make('org', isOrg)
