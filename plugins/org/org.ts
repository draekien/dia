import {
  BuiltInRoleDeleted,
  BuiltInRoleRenamed,
  HiredAgent,
  HireNameTaken,
  HireNotFound,
  OrgSettings,
  Role,
  RoleDisabled,
  RoleHasHires,
  RoleNameTaken,
  RoleNotFound
} from '@dia/plugin'
import type { HireId, OverallCap, RoleEdit, RoleId, RoleName } from '@shared/domain/org'
import type { AgentName } from '@shared/domain/project'
import { Clock, Crypto, Effect, Schema } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import type { Org } from './service'

const RoleRow = Schema.Struct({
  role_id: Role.fields.id,
  name: Role.fields.name,
  built_in: Role.fields.builtIn,
  enabled: Schema.BooleanFromBit,
  instructions: Role.fields.instructions,
  skills: Schema.fromJsonString(Role.fields.skills),
  permissions: Schema.fromJsonString(Role.fields.permissions),
  mcp_servers: Schema.fromJsonString(Role.fields.mcpServers),
  bypass_opt_in: Schema.BooleanFromBit
})

const HireRow = Schema.Struct({
  hire_id: HiredAgent.fields.id,
  role_id: HiredAgent.fields.roleId,
  name: HiredAgent.fields.name,
  bypass_override: Schema.NullOr(Schema.BooleanFromBit),
  hired_at: HiredAgent.fields.hiredAt
})

const SettingsRow = Schema.Struct({ overall_cap: OrgSettings.fields.overallCap })

const toRole = (row: typeof RoleRow.Type): Role => ({
  id: row.role_id,
  name: row.name,
  builtIn: row.built_in,
  enabled: row.enabled,
  instructions: row.instructions,
  skills: row.skills,
  permissions: row.permissions,
  mcpServers: row.mcp_servers,
  bypassOptIn: row.bypass_opt_in
})

const encodeRoleRow = Schema.encodeSync(RoleRow)

const toRoleRow = (role: Role) =>
  encodeRoleRow({
    role_id: role.id,
    name: role.name,
    built_in: role.builtIn,
    enabled: role.enabled,
    instructions: role.instructions,
    skills: role.skills,
    permissions: role.permissions,
    mcp_servers: role.mcpServers,
    bypass_opt_in: role.bypassOptIn
  })

const toHiredAgent = (row: typeof HireRow.Type): HiredAgent => ({
  id: row.hire_id,
  roleId: row.role_id,
  name: row.name,
  bypassOverride: row.bypass_override,
  hiredAt: row.hired_at
})

const encodeHireRow = Schema.encodeSync(HireRow)

const toHireRow = (agent: HiredAgent) =>
  encodeHireRow({
    hire_id: agent.id,
    role_id: agent.roleId,
    name: agent.name,
    bypass_override: agent.bypassOverride,
    hired_at: agent.hiredAt
  })

const rowsDecoder =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (rows: ReadonlyArray<unknown>) =>
    Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie)

const decodeRoleRows = rowsDecoder(RoleRow)
const decodeHireRows = rowsDecoder(HireRow)
const decodeSettingsRows = rowsDecoder(SettingsRow)

/**
 * Builds the {@link Org} over the `org` plugin's database, which `orgMigrations` must already have
 * migrated. Call it once in the plugin's setup and provide the result under `OrgService`.
 */
export const makeOrg = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto

  const transaction = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
    sql.withTransaction(effect).pipe(Effect.catchTag('SqlError', Effect.die))

  const newId = crypto.randomUUIDv4().pipe(Effect.orDie)

  const findRole = Effect.fnUntraced(function* (roleId: RoleId) {
    const rows = yield* sql`SELECT * FROM roles WHERE role_id = ${roleId}`
    const [row] = yield* decodeRoleRows(rows)
    if (row === undefined) {
      return yield* RoleNotFound.make({ roleId })
    }
    return toRole(row)
  })

  const ensureRoleNameFree = Effect.fnUntraced(function* (name: RoleName, exceptId: RoleId | null) {
    const rows = yield* sql`SELECT 1 FROM roles WHERE name = ${name} AND role_id IS NOT ${exceptId}`
    if (rows.length > 0) {
      return yield* RoleNameTaken.make({ roleName: name })
    }
  })

  const insertRole = (role: Role) => sql`INSERT INTO roles ${sql.insert(toRoleRow(role))}`

  const updateRole = (role: Role) =>
    sql`UPDATE roles SET ${sql.update(toRoleRow(role), ['role_id'])} WHERE role_id = ${role.id}`

  const roles = Effect.gen(function* () {
    const rows = yield* sql`SELECT * FROM roles ORDER BY rowid`
    return (yield* decodeRoleRows(rows)).map(toRole)
  }).pipe(Effect.catchTag('SqlError', Effect.die))

  const hiredAgents = Effect.gen(function* () {
    const rows = yield* sql`SELECT * FROM hired_agents ORDER BY hired_at, rowid`
    return (yield* decodeHireRows(rows)).map(toHiredAgent)
  }).pipe(Effect.catchTag('SqlError', Effect.die))

  const settings = Effect.gen(function* () {
    const rows = yield* sql`SELECT overall_cap FROM org_settings`
    const [row] = yield* decodeSettingsRows(rows)
    if (row === undefined) {
      return yield* Effect.die('The org_settings row is missing')
    }
    return OrgSettings.make({ overallCap: row.overall_cap })
  }).pipe(Effect.catchTag('SqlError', Effect.die))

  const setRoleEnabled = Effect.fn('Org.setRoleEnabled')(function* (
    roleId: RoleId,
    enabled: boolean
  ) {
    const role = yield* transaction(
      Effect.gen(function* () {
        const changed = { ...(yield* findRole(roleId)), enabled }
        yield* updateRole(changed)
        return changed
      })
    )
    yield* Effect.logInfo('Set role enabled', { roleId, enabled })
    return role
  })

  const copyRole = Effect.fn('Org.copyRole')(function* (roleId: RoleId, name: RoleName) {
    const id = Role.fields.id.make(yield* newId)
    const copy = yield* transaction(
      Effect.gen(function* () {
        const source = yield* findRole(roleId)
        yield* ensureRoleNameFree(name, null)
        const copied: Role = { ...source, id, name, builtIn: null, enabled: true }
        yield* insertRole(copied)
        return copied
      })
    )
    yield* Effect.logInfo('Copied role', { roleId, copyId: id })
    return copy
  })

  const editRole = Effect.fn('Org.editRole')(function* (roleId: RoleId, edit: RoleEdit) {
    const role = yield* transaction(
      Effect.gen(function* () {
        const current = yield* findRole(roleId)
        if (edit.name !== undefined && edit.name !== current.name) {
          if (current.builtIn !== null) {
            return yield* BuiltInRoleRenamed.make({ roleId })
          }
          yield* ensureRoleNameFree(edit.name, roleId)
        }
        const edited: Role = {
          ...current,
          ...edit,
          id: current.id,
          builtIn: current.builtIn,
          enabled: current.enabled
        }
        yield* updateRole(edited)
        return edited
      })
    )
    yield* Effect.logInfo('Edited role', { roleId, fields: Object.keys(edit) })
    return role
  })

  const deleteRole = Effect.fn('Org.deleteRole')(function* (roleId: RoleId) {
    yield* transaction(
      Effect.gen(function* () {
        const role = yield* findRole(roleId)
        if (role.builtIn !== null) {
          return yield* BuiltInRoleDeleted.make({ roleId })
        }
        const hires = yield* sql<{
          readonly hires: number
        }>`SELECT count(*) AS hires FROM hired_agents WHERE role_id = ${roleId}`
        const count = hires[0]?.hires ?? 0
        if (count > 0) {
          return yield* RoleHasHires.make({ roleId, hires: count })
        }
        yield* sql`DELETE FROM roles WHERE role_id = ${roleId}`
      })
    )
    yield* Effect.logInfo('Deleted role', { roleId })
  })

  const hire = Effect.fn('Org.hire')(function* (roleId: RoleId, name: AgentName | null) {
    const id = HiredAgent.fields.id.make(yield* newId)
    const hiredAt = yield* Clock.currentTimeMillis
    const hired = yield* transaction(
      Effect.gen(function* () {
        const role = yield* findRole(roleId)
        if (!role.enabled) {
          return yield* RoleDisabled.make({ roleId })
        }
        if (name !== null) {
          const taken = yield* sql`SELECT 1 FROM hired_agents WHERE name = ${name}`
          if (taken.length > 0) {
            return yield* HireNameTaken.make({ agentName: name })
          }
        }
        const agent = HiredAgent.make({ id, roleId, name, bypassOverride: null, hiredAt })
        yield* sql`INSERT INTO hired_agents ${sql.insert(toHireRow(agent))}`
        return agent
      })
    )
    yield* Effect.logInfo('Hired agent', { roleId, hireId: id })
    return hired
  })

  const dismiss = Effect.fn('Org.dismiss')(function* (hireId: HireId) {
    const deleted =
      yield* sql`DELETE FROM hired_agents WHERE hire_id = ${hireId} RETURNING hire_id`.pipe(
        Effect.catchTag('SqlError', Effect.die)
      )
    if (deleted.length === 0) {
      return yield* HireNotFound.make({ hireId })
    }
    yield* Effect.logInfo('Dismissed agent', { hireId })
  })

  const setOverallCap = Effect.fn('Org.setOverallCap')(function* (cap: OverallCap) {
    yield* sql`UPDATE org_settings SET overall_cap = ${cap}`.pipe(
      Effect.catchTag('SqlError', Effect.die)
    )
    yield* Effect.logInfo('Set overall cap', { overallCap: cap })
    return OrgSettings.make({ overallCap: cap })
  })

  return {
    roles,
    hiredAgents,
    settings,
    setRoleEnabled,
    copyRole,
    editRole,
    deleteRole,
    hire,
    dismiss,
    setOverallCap
  } satisfies Org
})
