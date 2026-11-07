import { type HostPluginContext, MetaRepoKey, type PluginSetup } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Path } from 'effect'
import { ensureMetaRepo, makeMetaRepo } from './meta-repo'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.join(ctx.dataDir, 'repo')
    yield* ensureMetaRepo(directory)
    yield* ctx.provide(MetaRepoKey, yield* makeMetaRepo(directory))
    yield* Effect.logInfo('Meta repo provided', { plugin: ctx.name, directory })
  }).pipe(Effect.provide(NodeServices.layer))

export default setup
