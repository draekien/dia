import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { isRunScope, RunEventsKey, RunsKey } from '@dia/plugin'
import { ToolsKey } from '@dia-plugin/dia-tools/tools'
import { Effect } from 'effect'
import { makeMessagingTools } from './messaging'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  ctx.whenProvided([RunsKey, RunEventsKey, ToolsKey], ({ runs, runEvents, tools }) =>
    Effect.gen(function* () {
      const messagingTools = yield* makeMessagingTools(runs, runEvents)
      yield* Effect.forEach(messagingTools, (tool) => tools.register(tool, { when: isRunScope }), {
        discard: true
      })
      yield* Effect.logInfo('Run messaging tools registered', { plugin: ctx.name })
    })
  )

export default setup
