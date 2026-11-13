import { type HostPluginContext, MetaRepoKey, type PluginSetup } from '@dia/plugin'
import { directorySource } from '@dia-plugin/dia-skills/directory'
import { SkillSourceRegistryKey } from '@dia-plugin/dia-skills/registry'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Option, Path } from 'effect'
import {
  ensureMetaRepo,
  META_PLUGIN_NAME,
  makeMetaRepo,
  metaPluginDirectory,
  metaSkillsDirectory
} from './meta-repo'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.join(ctx.dataDir, 'repo')
    yield* ensureMetaRepo(directory)
    yield* ctx.provide(MetaRepoKey, yield* makeMetaRepo(directory))
    const skills = yield* directorySource('meta', {
      directory: metaSkillsDirectory(path, directory),
      group: 'Meta repo',
      plugin: Option.some(META_PLUGIN_NAME),
      pluginPath: Option.some(metaPluginDirectory(path, directory))
    })
    yield* ctx.whenProvided([SkillSourceRegistryKey], ({ skillSourceRegistry }) =>
      skillSourceRegistry.register(skills)
    )
    yield* Effect.logInfo('Meta repo provided', { plugin: ctx.name, directory })
  }).pipe(Effect.provide(NodeServices.layer))

export default setup
