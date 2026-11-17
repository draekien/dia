import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'
import { makeAgentAdapterRegistry } from './adapter-registry'
import {
  CheckAdapterHealth,
  FollowAdapterStatus,
  FollowAdapters,
  FollowModels,
  GetAdapterStatus,
  GetAttachmentTypes,
  GetDisabledPermissionModes,
  GetModels,
  RefreshModels,
  SetInstallPath
} from './calls'
import { AgentAdaptersKey } from './registry'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const registry = yield* makeAgentAdapterRegistry()
    yield* ctx.provide(AgentAdaptersKey, registry.service)

    yield* ctx.serve(FollowAdapters, () => registry.summaries)
    yield* ctx.serve(GetModels, ({ adapter }) => registry.models.current(adapter))
    yield* ctx.serve(RefreshModels, ({ adapter }) => registry.models.refresh(adapter))
    yield* ctx.serve(FollowModels, ({ adapter }) => registry.models.changes(adapter))
    yield* ctx.serve(GetAdapterStatus, ({ adapter }) => registry.status.current(adapter))
    yield* ctx.serve(CheckAdapterHealth, ({ adapter }) => registry.status.check(adapter))
    yield* ctx.serve(SetInstallPath, ({ adapter, path }) =>
      registry.status.setInstallPath(adapter, path)
    )
    yield* ctx.serve(FollowAdapterStatus, ({ adapter }) => registry.status.changes(adapter))
    yield* ctx.serve(GetDisabledPermissionModes, ({ adapter, cwd }) =>
      registry.disabledPermissionModes(adapter, cwd)
    )
    yield* ctx.serve(GetAttachmentTypes, ({ adapter }) => registry.attachmentTypes(adapter))
    yield* Effect.logInfo('Agent adapter registry provided', { plugin: ctx.name })
  })

export default setup
