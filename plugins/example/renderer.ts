import type { PluginServices, PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.logInfo('Example renderer plugin closed', ctx.name))
    yield* Effect.logInfo('Example renderer plugin opened', ctx.name)
  })

export default setup
