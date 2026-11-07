import type { PluginMigrations } from '@dia/plugin'
import { Clock, Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { BUILT_IN_ROLES, DEFAULT_OVERALL_CAP, FIRST_RETRO_HIRE_ID } from './built-in-roles'
import { Role } from './domain'

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE roles (
    role_id       TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    built_in      TEXT    UNIQUE CHECK (built_in IN ('planner', 'engineer', 'reviewer', 'researcher', 'retro')),
    enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    instructions  TEXT    NOT NULL,
    skills        TEXT    NOT NULL,
    permissions   TEXT    NOT NULL,
    mcp_servers   TEXT    NOT NULL,
    bypass_opt_in INTEGER NOT NULL CHECK (bypass_opt_in IN (0, 1))
  )`)
  yield* sql.unsafe(`CREATE TABLE hired_agents (
    hire_id         TEXT    PRIMARY KEY,
    role_id         TEXT    NOT NULL REFERENCES roles,
    name            TEXT    UNIQUE COLLATE NOCASE,
    bypass_override INTEGER CHECK (bypass_override IN (0, 1)),
    hired_at        INTEGER NOT NULL
  )`)
  yield* sql.unsafe(`CREATE TABLE org_settings (
    singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
    overall_cap INTEGER NOT NULL CHECK (overall_cap >= 1)
  )`)
})

const encodePermissions = Schema.encodeSync(Schema.fromJsonString(Role.fields.permissions))

const seedOrg = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const role of BUILT_IN_ROLES) {
    yield* sql`INSERT INTO roles ${sql.insert({
      role_id: role.id,
      name: role.kind,
      built_in: role.kind,
      enabled: 1,
      instructions: role.instructions,
      skills: '[]',
      permissions: encodePermissions({ allow: [], ask: [], deny: role.deny }),
      mcp_servers: '{}',
      bypass_opt_in: 0
    })}`
  }
  const retro = BUILT_IN_ROLES.find((role) => role.kind === 'retro')
  if (retro !== undefined) {
    yield* sql`INSERT INTO hired_agents ${sql.insert({
      hire_id: FIRST_RETRO_HIRE_ID,
      role_id: retro.id,
      name: null,
      bypass_override: null,
      hired_at: yield* Clock.currentTimeMillis
    })}`
  }
  yield* sql`INSERT INTO org_settings ${sql.insert({ singleton: 1, overall_cap: DEFAULT_OVERALL_CAP })}`
})

/**
 * The `org` plugin's migrations, passed to `ctx.database`. `1_create_org_tables` creates the
 * roles, hired agents and org settings tables; `2_seed_org` inserts the built-in roles, one
 * unnamed `retro` hire and the default overall cap. Each runs once per database, so a dismissed
 * first `retro` is never hired again.
 */
export const orgMigrations: PluginMigrations = {
  '1_create_org_tables': createTables,
  '2_seed_org': seedOrg
}
