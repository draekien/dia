import type { PluginMigrations } from '@dia/plugin'
import { Effect, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { McpServer, type McpServers } from './servers'

/** The `mcp` plugin's database migrations; pass them to `ctx.database`. */
export const mcpMigrations: PluginMigrations = {
  '1_create_user_servers': Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE user_servers (
      name   TEXT PRIMARY KEY,
      server TEXT NOT NULL
    )`)
  })
}

const Row = Schema.Struct({ name: Schema.String, server: Schema.String })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))
const decodeServer = Schema.decodeUnknownResult(Schema.fromJsonString(McpServer))
const encodeServer = Schema.encodeSync(Schema.fromJsonString(McpServer))

/** The servers the user saved. A row that no longer decodes is left out and logged. */
export const readUserServers: Effect.Effect<McpServers, never, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* decodeRows(yield* sql`SELECT name, server FROM user_servers`)
    const servers: Record<string, McpServer> = {}
    for (const row of rows) {
      const server = decodeServer(row.server)
      if (Result.isSuccess(server)) servers[row.name] = server.success
      else
        yield* Effect.logWarning('Stored MCP server skipped', {
          name: row.name,
          message: server.failure.message
        })
    }
    return servers
  }
).pipe(Effect.orDie)

/** Replaces every stored user server with `servers`, in one transaction. */
export const writeUserServers = (
  servers: McpServers
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM user_servers`
        for (const [name, server] of Object.entries(servers)) {
          yield* sql`INSERT INTO user_servers ${sql.insert({ name, server: encodeServer(server) })}`
        }
      })
    )
  }).pipe(Effect.orDie)
