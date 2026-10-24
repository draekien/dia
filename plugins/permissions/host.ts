import { type HostPluginContext, PENDING_USER_INPUT_KEY, type PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'
import { makePendingUserInput } from './pending-user-input'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(PENDING_USER_INPUT_KEY, makePendingUserInput)
    yield* Effect.logInfo('Pending user input provided', { plugin: ctx.name })
  })

export default setup
