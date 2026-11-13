import {
  type Git,
  GitKey,
  type HostPluginContext,
  MetaRepoKey,
  type PluginSetup
} from '@dia/plugin'
import { directorySource } from '@dia-plugin/dia-skills/directory'
import { SkillSourceRegistryKey } from '@dia-plugin/dia-skills/registry'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Option, Path, Ref } from 'effect'
import {
  ensureMetaFiles,
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
    yield* ensureMetaFiles(directory)
    const git = yield* Ref.make(Option.none<Git>())
    yield* ctx.whenProvided([GitKey], ({ git: provided }) =>
      Effect.acquireRelease(Ref.set(git, Option.some(provided)), () =>
        Ref.set(git, Option.none())
      ).pipe(
        Effect.andThen(
          ensureMetaRepo(directory, provided).pipe(
            Effect.catch((error) =>
              Effect.logWarning('Could not create the meta repo files', { directory, error })
            ),
            Effect.forkScoped
          )
        ),
        Effect.provide(NodeServices.layer)
      )
    )
    yield* ctx.provide(MetaRepoKey, yield* makeMetaRepo(directory, Ref.get(git)))
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
