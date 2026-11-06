import { type HostPluginContext, ORG_KEY, type PluginSetup } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(orgMigrations)
    const org = yield* makeOrg.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* ctx.provide(ORG_KEY, org)
    const roles = yield* org.roles
    const hires = yield* org.hiredAgents
    yield* Effect.logInfo('Org service provided', {
      plugin: ctx.name,
      roles: roles.length,
      hiredAgents: hires.length
    })
  })

export default setup
