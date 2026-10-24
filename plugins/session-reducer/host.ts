import { type HostPluginContext, type PluginSetup, SESSION_REDUCER_KEY } from '@dia/plugin'
import { Effect } from 'effect'
import { makeSessionEventReducer } from './reducer'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(SESSION_REDUCER_KEY, makeSessionEventReducer)
    yield* Effect.logInfo('Session reducer provided', { plugin: ctx.name })
  })

export default setup
