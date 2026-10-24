import { AGENT_BACKEND_KEY, type HostPluginContext, type PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'
import { makeClaudeCodeBackend } from './backend'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(AGENT_BACKEND_KEY, makeClaudeCodeBackend())
    yield* Effect.logInfo('Claude Code agent backend provided', { plugin: ctx.name })
  })

export default setup
