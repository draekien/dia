import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { SaveUserServers, WatchServers } from './calls'
import { makeRegistry } from './make-registry'
import { McpServerRegistryKey } from './registry'
import type { McpServers } from './servers'
import { mcpMigrations, readUserServers, writeUserServers } from './store'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(mcpMigrations)
    const stored = yield* readUserServers.pipe(Effect.provideService(SqlClient.SqlClient, sql))
    const writeUsers = (servers: McpServers) =>
      writeUserServers(servers).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    const { registry, replaceUser } = yield* makeRegistry(stored, writeUsers)
    yield* ctx.provide(McpServerRegistryKey, registry)
    yield* ctx.serve(WatchServers, () => registry.changes)
    yield* ctx.serve(SaveUserServers, ({ servers }) => replaceUser(servers, writeUsers(servers)))
    yield* Effect.logInfo('MCP server registry provided', {
      plugin: ctx.name,
      userServers: Object.keys(stored).length
    })
  })

export default setup
