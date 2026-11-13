import * as os from 'node:os'
import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { AgentBackendKey } from '@dia-plugin/dia-runs/backend'
import { SkillSourceRegistryKey } from '@dia-plugin/dia-skills/registry'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Duration, Effect } from 'effect'
import { makeClaudeCodeBackend } from './backend'
import { isExistingFile, makeClaudeInstall } from './claude-install'
import { makeClaudeHealth } from './health'
import { makeModelCatalog, probeModels } from './model-catalog'
import { logShadowedCanUseToolWarnings } from './sdk-warnings'
import { claudeCodeSources } from './skills'
import { claudeProjectsDir, moveTranscriptFolders, sessionCwds } from './transcript-folders'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* logShadowedCanUseToolWarnings(process)
    const services = yield* Effect.context<NodeServices.NodeServices>()
    const recentSessionCwds = yield* Effect.cachedWithTTL(sessionCwds, Duration.minutes(1))
    yield* ctx.onPathsMoved((move) =>
      Effect.gen(function* () {
        yield* moveTranscriptFolders(move, yield* claudeProjectsDir, recentSessionCwds)
      }).pipe(Effect.provideContext(services))
    )
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
