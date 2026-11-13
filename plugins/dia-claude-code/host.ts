import * as os from 'node:os'
import { AgentBackendKey, type HostPluginContext, type PluginSetup } from '@dia/plugin'
import { SkillSourceRegistryKey } from '@dia-plugin/dia-skills/registry'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import { makeClaudeCodeBackend } from './backend'
import { isExistingFile, makeClaudeInstall } from './claude-install'
import { makeClaudeHealth } from './health'
import { makeModelCatalog, probeModels } from './model-catalog'
import { logShadowedCanUseToolWarnings } from './sdk-warnings'
import { claudeCodeSources } from './skills'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* logShadowedCanUseToolWarnings(process)
    const install = yield* makeClaudeInstall(ctx, isExistingFile)
    const catalog = yield* makeModelCatalog(ctx, probeModels(install))
    const health = yield* makeClaudeHealth(install, ctx.dataDir, catalog.refreshModels)
    yield* ctx.provide(AgentBackendKey, makeClaudeCodeBackend({ catalog, install, health }))
    yield* Effect.forkScoped(health.check)
    for (const source of yield* claudeCodeSources(os.homedir())) {
      yield* ctx.whenProvided([SkillSourceRegistryKey], ({ skillSourceRegistry }) =>
        skillSourceRegistry.register(source)
      )
    }
    yield* Effect.logInfo('Claude Code agent backend provided', { plugin: ctx.name })
  }).pipe(Effect.provide(NodeServices.layer))

export default setup
