import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { makeRegistry } from './make-registry'
import { AgentDefinitionRegistryKey } from './registry'
import { agentDefinitionMigrations } from './store'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(agentDefinitionMigrations)
    const registry = yield* makeRegistry.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* ctx.provide(AgentDefinitionRegistryKey, registry)
    yield* Effect.logInfo('Agent definition registry provided', {
      plugin: ctx.name,
      listed: (yield* registry.list).length
    })
  })

export default setup
