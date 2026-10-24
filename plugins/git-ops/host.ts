import { GIT_OPS_KEY, type HostPluginContext, type PluginSetup } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { makeGitOps } from './git-ops'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const gitOps = yield* makeGitOps.pipe(Effect.provide(NodeServices.layer))
    yield* ctx.provide(GIT_OPS_KEY, () => gitOps)
    yield* Effect.logInfo('Git operations provided', { plugin: ctx.name })
  })

export default setup
