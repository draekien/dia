import { type HostPluginContext, type PluginSetup, THINKING_OPTIONS_KEY } from '@dia/plugin'
import { Effect } from 'effect'
import { thinkingOptions } from './thinking-options'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(THINKING_OPTIONS_KEY, thinkingOptions)
    yield* Effect.logInfo('Thinking options provided', { plugin: ctx.name })
  })

export default setup
