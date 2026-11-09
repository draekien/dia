import {
  type AgentDefinition,
  type AgentDefinitionRegistry,
  AgentDefinition as AgentDefinitionSchema
} from '@dia-plugin/agent-definitions/registry'
import type { McpServerRegistry } from '@dia-plugin/mcp/registry'
import { McpServers } from '@dia-plugin/mcp/servers'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { BUILT_IN_DEFINITIONS } from './built-in-job-titles'

const HANDOVER_TABLE = 'job_titles_handover'

const HandoverRow = Schema.Struct({
  job_title_id: AgentDefinitionSchema.fields.id,
  name: AgentDefinitionSchema.fields.name,
  job_description: Schema.String,
  skills: Schema.fromJsonString(AgentDefinitionSchema.fields.skills),
  permissions: Schema.fromJsonString(AgentDefinitionSchema.fields.permissions),
  mcp_servers: Schema.fromJsonString(McpServers),
  bypass_opt_in: Schema.BooleanFromBit,
  model: AgentDefinitionSchema.fields.model,
  thinking_level: AgentDefinitionSchema.fields.thinkingLevel
})
type HandoverRow = typeof HandoverRow.Type

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(HandoverRow))

const BUILT_INS: ReadonlyMap<string, AgentDefinition> = new Map(
  BUILT_IN_DEFINITIONS.map((definition) => [definition.id, definition])
)

const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  const set = new Set(left)
  return set.size === new Set(right).size && right.every((entry) => set.has(entry))
}

const sameAsBuiltIn = (row: AgentDefinition, builtIn: AgentDefinition): boolean =>
  row.jobDescription.trim() === builtIn.jobDescription.trim() &&
  sameSet(row.skills, builtIn.skills) &&
  sameSet(row.permissions.allow, builtIn.permissions.allow) &&
  sameSet(row.permissions.ask, builtIn.permissions.ask) &&
  sameSet(row.permissions.deny, builtIn.permissions.deny) &&
  sameSet(row.mcpServers, builtIn.mcpServers) &&
  row.bypassOptIn === builtIn.bypassOptIn &&
  row.model === builtIn.model &&
  row.thinkingLevel === builtIn.thinkingLevel

const toDefinition = (row: HandoverRow, mcpServers: ReadonlyArray<string>): AgentDefinition => ({
  id: row.job_title_id,
  name: row.name,
  jobDescription: row.job_description,
  skills: row.skills,
  permissions: row.permissions,
  mcpServers,
  bypassOptIn: row.bypass_opt_in,
  model: row.model,
  thinkingLevel: row.thinking_level
})

const serverEntries = (row: HandoverRow) =>
  Object.keys(row.mcp_servers)
    .sort()
    .flatMap((name) => {
      const server = row.mcp_servers[name]
      return server === undefined ? [] : [{ name, server }]
    })

/**
 * Whether the `org` database still holds job titles to hand over: `9_agent_definitions` renamed
 * them to `job_titles_handover`, and {@link handOverJobTitles} drops that table when it is done.
 */
export const handoverPending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${HANDOVER_TABLE}`
  return rows.length > 0
}).pipe(Effect.orDie)

/**
 * Moves the job titles `9_agent_definitions` left in `job_titles_handover` into `definitions` and
 * their inline MCP servers into `mcp`, then drops the table. Each server is imported under the
 * name `mcp.importServers` returns, which the definition then names. A built-in job title is
 * imported as an override only when it differs from its contributed definition; every other job
 * title is imported as a user definition with its id. Running it again after a failure before the
 * drop imports nothing twice; running it once the table is gone does nothing. Call it while both
 * registries are provided.
 */
export const handOverJobTitles = (
  definitions: AgentDefinitionRegistry,
  mcp: McpServerRegistry
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!(yield* handoverPending)) {
      yield* Effect.logDebug('No org job titles left to hand over')
      return
    }
    const rows = yield* decodeRows(
      yield* sql`SELECT job_title_id, name, job_description, skills, permissions,
        mcp_servers, bypass_opt_in, model, thinking_level FROM job_titles_handover ORDER BY rowid`
    )
    const servers = rows.map(serverEntries)
    const names = yield* mcp.importServers(servers.flat())
    yield* Effect.logInfo('Handed org MCP servers to mcp', {
      servers: names.length,
      renamed: names.filter((name, index) => name !== servers.flat()[index]?.name).length
    })
    let offset = 0
    const overrides: Array<AgentDefinition> = []
    const userDefinitions: Array<AgentDefinition> = []
    for (const [index, row] of rows.entries()) {
      const count = servers[index]?.length ?? 0
      const definition = toDefinition(row, names.slice(offset, offset + count))
      offset += count
      const builtIn = BUILT_INS.get(row.job_title_id)
      if (builtIn === undefined) userDefinitions.push(definition)
      else if (!sameAsBuiltIn(definition, builtIn)) overrides.push(definition)
    }
    yield* definitions.importOverrides(overrides)
    yield* definitions.importDefinitions(userDefinitions)
    yield* sql.unsafe(`DROP TABLE ${HANDOVER_TABLE}`)
    yield* Effect.logInfo('Handed org job titles to agent-definitions', {
      jobTitles: rows.length,
      overrides: overrides.length,
      definitions: userDefinitions.length
    })
  }).pipe(Effect.orDie)
