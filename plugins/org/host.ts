import {
  type AgentBackend,
  AgentBackendKey,
  type HostPluginContext,
  type PluginSetup
} from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Effect, Option, Ref, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { bypassAvailable } from './bypass'
import {
  CopyJobTitle,
  DeleteJobTitle,
  Dismiss,
  EditJobTitle,
  Hire,
  ReadOrg,
  RenameHire,
  SetBypassOverride,
  SetJobTitleEnabled,
  SetOverallCap,
  SetReportsTo
} from './calls'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { type Org, OrgService } from './service'

const holdAgentBackend = (ctx: HostPluginContext, backend: Ref.Ref<Option.Option<AgentBackend>>) =>
  ctx
    .whenProvided([AgentBackendKey], ({ agentBackend }) =>
      Effect.acquireRelease(
        Ref.set(backend, Option.some(agentBackend)).pipe(
          Effect.tap(() => Effect.logDebug('Org holds the agent backend'))
        ),
        () => Ref.set(backend, Option.none())
      )
    )
    .pipe(Effect.orDie)

const serveOrgCalls = (
  ctx: HostPluginContext,
  org: Org,
  backend: Ref.Ref<Option.Option<AgentBackend>>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.all(
    [
      ctx.serve(ReadOrg, () =>
        Effect.all(
          {
            jobTitles: org.jobTitles,
            hiredAgents: org.hiredAgents,
            settings: org.settings,
            bypassAvailable: bypassAvailable(backend)
          },
          { concurrency: 'unbounded' }
        )
      ),
      ctx.serve(SetJobTitleEnabled, ({ jobTitleId, enabled }) =>
        org.setJobTitleEnabled(jobTitleId, enabled)
      ),
      ctx.serve(CopyJobTitle, ({ jobTitleId, name }) => org.copyJobTitle(jobTitleId, name)),
      ctx.serve(EditJobTitle, ({ jobTitleId, edit }) => org.editJobTitle(jobTitleId, edit)),
      ctx.serve(DeleteJobTitle, ({ jobTitleId }) => org.deleteJobTitle(jobTitleId)),
      ctx.serve(Hire, ({ jobTitleId, name, reportsTo }) => org.hire(jobTitleId, name, reportsTo)),
      ctx.serve(Dismiss, ({ hireId }) => org.dismiss(hireId)),
      ctx.serve(RenameHire, ({ hireId, name }) => org.renameHire(hireId, name)),
      ctx.serve(SetBypassOverride, ({ hireId, override }) =>
        org.setBypassOverride(hireId, override)
      ),
      ctx.serve(SetReportsTo, ({ hireId, reportsTo }) => org.setReportsTo(hireId, reportsTo)),
      ctx.serve(SetOverallCap, ({ cap }) => org.setOverallCap(cap))
    ],
    { discard: true }
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(orgMigrations)
    const org = yield* makeOrg.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* ctx.provide(OrgService, org)
    const backend = yield* Ref.make(Option.none<AgentBackend>())
    yield* holdAgentBackend(ctx, backend)
    yield* serveOrgCalls(ctx, org, backend)
    const jobTitles = yield* org.jobTitles
    const hires = yield* org.hiredAgents
    yield* Effect.logInfo('Org service provided', {
      plugin: ctx.name,
      jobTitles: jobTitles.length,
      hiredAgents: hires.length
    })
  })

export default setup
