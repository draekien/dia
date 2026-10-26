import { AGENT_BACKEND_KEY, type HostPluginContext, type PluginSetup } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { makeClaudeCodeBackend } from './backend'
import { makeModelCatalog } from './model-catalog'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const catalog = yield* makeModelCatalog(ctx).pipe(Effect.provide(NodeServices.layer))
    yield* ctx.provide(AGENT_BACKEND_KEY, makeClaudeCodeBackend(catalog))
    yield* Effect.logInfo('Claude Code agent backend provided', { plugin: ctx.name })
  })

export default setup
