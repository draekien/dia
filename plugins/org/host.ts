import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { OrgService } from './service'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(orgMigrations)
    const org = yield* makeOrg.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* ctx.provide(OrgService, org)
    const jobTitles = yield* org.jobTitles
    const hires = yield* org.hiredAgents
    yield* Effect.logInfo('Org service provided', {
      plugin: ctx.name,
      jobTitles: jobTitles.length,
      hiredAgents: hires.length
    })
  })

export default setup
