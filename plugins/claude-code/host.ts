import { AGENT_BACKEND_KEY, type HostPluginContext, type PluginSetup } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { makeClaudeCodeBackend } from './backend'
import { isExistingFile, makeClaudeInstall } from './claude-install'
import { makeClaudeHealth } from './health'
import { makeModelCatalog, probeModels } from './model-catalog'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const install = yield* makeClaudeInstall(ctx, isExistingFile)
    const catalog = yield* makeModelCatalog(ctx, probeModels(install))
    const health = yield* makeClaudeHealth(install, ctx.dataDir, catalog.refreshModels)
    yield* ctx.provide(AGENT_BACKEND_KEY, makeClaudeCodeBackend({ catalog, install, health }))
    yield* Effect.forkScoped(health.check)
    yield* Effect.logInfo('Claude Code agent backend provided', { plugin: ctx.name })
  }).pipe(Effect.provide(NodeServices.layer))

export default setup
