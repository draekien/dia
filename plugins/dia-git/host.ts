import { GitKey, type HostPluginContext, type PluginSetup } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { makeGit } from './git'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(GitKey, yield* makeGit.pipe(Effect.provide(NodeServices.layer)))
    yield* Effect.logInfo('Git provided', { plugin: ctx.name })
  })

export default setup
