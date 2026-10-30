import { DEFAULT_SEND_MODE, EMPTY_MESSAGE_QUEUE } from '@shared/domain/message-queue'
import { DEFAULT_USAGE_LIMIT_RESUME } from '@shared/domain/parking'
import { DEFAULT_THEME } from '@shared/domain/theme'
import { DEFAULT_TRANSCRIPT_WIDTH } from '@shared/domain/transcript-width'
import { type IpcEvent, PaneCreateFailed } from '@shared/ipc/contract'
import { DiaRpcs } from '@shared/ipc/rpc'
import { Effect, Option } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { applyOverride, PluginSources } from '../plugins/plugin-sources'
import { AdapterStatusFeed } from '../services/adapter-status-feed'
import { AgentSummaries } from '../services/agent-summaries'
import { BackgroundActivities } from '../services/background-activities'
import { CommandDeduper } from '../services/command-deduper'
import { EventHub } from '../services/event-hub'
import { ModelCatalogFeed } from '../services/model-catalog-feed'
import { ModelPreferences } from '../services/model-preferences'
import { type PaneHandle, PaneSupervisor } from '../services/pane-supervisor'
import { PaneWorkspace } from '../services/pane-workspace'
import { SettingsStore } from '../services/settings-store'
import { resolveAgentBackend } from '../session/agent-backend'

/**
 * Builds the implementation of {@link DiaRpcs} on top of the Host's services. Requires
 * `PaneWorkspace`, `AgentSummaries`, `PaneSupervisor`, `SettingsStore`, `EventHub`, `CommandDeduper`,
 * `HostPlugins`, `PluginSources`, `ModelCatalogFeed`, `AdapterStatusFeed`, `ModelPreferences` and
 * `BackgroundActivities`. Use {@link DiaRpcHandlersLive} to serve it; call this directly to invoke
 * handlers without a transport.
 *
 * Every command is applied at most once per `commandId` within its target (pane, project, or
 * `'app'`), drops with a warning when its target does not exist, and never fails the RPC:
 * failures are logged. `RegisterProject`, `RemoveProject` and `SetModelPreference` return their typed errors. `SendMessage` starts
 * the pane's session on demand when the pane has none, so a message to a pane whose session
 * ended is not lost.
 */
export const makeDiaRpcHandlers = Effect.gen(function* () {
  const workspace = yield* PaneWorkspace
  const summaries = yield* AgentSummaries
  const supervisor = yield* PaneSupervisor
  const settings = yield* SettingsStore
  const hub = yield* EventHub
  const deduper = yield* CommandDeduper
  const plugins = yield* HostPlugins
  const pluginSources = yield* PluginSources
  const models = yield* ModelCatalogFeed
  const adapterStatus = yield* AdapterStatusFeed
  const modelPreferences = yield* ModelPreferences
  const activities = yield* BackgroundActivities

  const publish = (event: IpcEvent): Effect.Effect<void> => hub.publish(event)

  const once = (
    scopeId: string,
    commandId: string,
    command: string,
    run: Effect.Effect<void>
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const accepted = yield* deduper.accept(scopeId, commandId)
      if (!accepted) {
        yield* Effect.logDebug('Ignored resent command', { command, scopeId, commandId })
        return
      }
      yield* run
    })

  const warnOnFailure =
    (command: string, target: Record<string, unknown>) =>
    <E>(effect: Effect.Effect<void, E>): Effect.Effect<void> =>
      effect.pipe(
        Effect.catch((issue) =>
          Effect.logWarning(`Failed to apply ${command}`, { ...target, issue })
        )
      )

  const withHandle = (
    command: string,
    paneId: string,
    failure: string,
    op: (handle: PaneHandle) => Effect.Effect<void>
  ): Effect.Effect<void> =>
    supervisor.getHandle(paneId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.logWarning(`Dropped ${command} for unknown pane`, { paneId }),
          onSome: (handle) =>
            op(handle).pipe(
              Effect.catchCause((cause) => Effect.logError(failure, { paneId, cause }))
            )
        })
      )
    )

  const withLiveHandle = (
    command: string,
    paneId: string,
    failure: string,
    op: (handle: PaneHandle) => Effect.Effect<void>
  ): Effect.Effect<void> =>
    workspace
      .ensureLive(paneId, publish)
      .pipe(Effect.andThen(withHandle(command, paneId, failure, op)))

  return DiaRpcs.of({
    SendMessage: (command) =>
      once(
        command.paneId,
        command.commandId,
        'SendMessage',
        withLiveHandle('SendMessage', command.paneId, 'Failed to send message to pane', (handle) =>
          handle.sendMessage(command.text, command.mode)
        )
      ),
    ResolvePermission: (command) =>
      once(
        command.paneId,
        command.commandId,
        'ResolvePermission',
        withHandle(
          'ResolvePermission',
          command.paneId,
          'Failed to resolve permission for pane',
          (handle) => handle.resolvePermission(command.requestId, command.response)
        )
      ),
    ResolveQuestion: (command) =>
      once(
        command.paneId,
        command.commandId,
        'ResolveQuestion',
        withHandle(
          'ResolveQuestion',
          command.paneId,
          'Failed to resolve question for pane',
          (handle) => handle.resolveQuestion(command.requestId, command.response)
        )
      ),
    ResolvePlanReview: (command) =>
      once(
        command.paneId,
        command.commandId,
        'ResolvePlanReview',
        withHandle(
          'ResolvePlanReview',
          command.paneId,
          'Failed to resolve plan review for pane',
          (handle) => handle.resolvePlanReview(command.requestId, command.approved)
        )
      ),
    CreateTab: ({ commandId, _tag, ...request }) =>
      once(
        request.paneId,
        commandId,
        'CreateTab',
        workspace
          .createTab(request, publish)
          .pipe(
            Effect.catch((issue) =>
              Effect.logWarning('Failed to create tab', { paneId: request.paneId, issue }).pipe(
                Effect.andThen(
                  publish(PaneCreateFailed.make({ paneId: request.paneId, reason: String(issue) }))
                )
              )
            )
          )
      ),
    MoveProject: (command) =>
      once(
        command.projectId,
        command.commandId,
        'MoveProject',
        workspace
          .moveProject(command.projectId, command.toIndex)
          .pipe(warnOnFailure('MoveProject', { projectId: command.projectId }))
      ),
    RenameTab: (command) =>
      once(
        command.paneId,
        command.commandId,
        'RenameTab',
        workspace
          .renameTab(command.paneId, command.name)
          .pipe(warnOnFailure('RenameTab', { paneId: command.paneId }))
      ),
    SelectTab: (command) =>
      once(
        'app',
        command.commandId,
        'SelectTab',
        workspace
          .selectTab(command.paneId, publish)
          .pipe(warnOnFailure('SelectTab', { paneId: command.paneId }))
      ),
    SetTranscriptWidth: (command) =>
      once(
        'app',
        command.commandId,
        'SetTranscriptWidth',
        settings.setTranscriptWidth(command.width)
      ),
    SetThinkingLevel: (command) =>
      once(
        command.paneId,
        command.commandId,
        'SetThinkingLevel',
        workspace
          .setThinkingLevel(command.paneId, command.level)
          .pipe(warnOnFailure('SetThinkingLevel', { paneId: command.paneId }))
      ),
    SetPermissionMode: (command) =>
      once(
        command.paneId,
        command.commandId,
        'SetPermissionMode',
        workspace
          .setPermissionMode(command.paneId, command.mode)
          .pipe(warnOnFailure('SetPermissionMode', { paneId: command.paneId }))
      ),
    SetModel: (command) =>
      once(
        command.paneId,
        command.commandId,
        'SetModel',
        workspace
          .setModel(command.paneId, command.model)
          .pipe(warnOnFailure('SetModel', { paneId: command.paneId }))
      ),
    InterruptPane: (command) =>
      once(
        command.paneId,
        command.commandId,
        'InterruptPane',
        withHandle('InterruptPane', command.paneId, 'Failed to interrupt pane', (handle) =>
          handle.interrupt()
        )
      ),
    ResumeParkedAgent: (command) =>
      once(
        command.paneId,
        command.commandId,
        'ResumeParkedAgent',
        withHandle(
          'ResumeParkedAgent',
          command.paneId,
          'Failed to resume a parked agent',
          (handle) => handle.resume
        )
      ),
    RewindToCheckpoint: (command) =>
      once(
        command.paneId,
        command.commandId,
        'RewindToCheckpoint',
        withLiveHandle(
          'RewindToCheckpoint',
          command.paneId,
          'Failed to rewind pane to checkpoint',
          (handle) => handle.rewindToCheckpoint(command.messageUuid, command.resumeAnchorUuid)
        )
      ),
    EditQueuedMessage: (command) =>
      once(
        command.paneId,
        command.commandId,
        'EditQueuedMessage',
        withHandle(
          'EditQueuedMessage',
          command.paneId,
          'Failed to edit a queued message',
          (handle) => handle.editQueuedMessage(command.messageId, command.text)
        )
      ),
    RemoveQueuedMessage: (command) =>
      once(
        command.paneId,
        command.commandId,
        'RemoveQueuedMessage',
        withHandle(
          'RemoveQueuedMessage',
          command.paneId,
          'Failed to remove a queued message',
          (handle) => handle.removeQueuedMessage(command.messageId)
        )
      ),
    GetMessageQueue: ({ paneId }) =>
      supervisor.getHandle(paneId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(EMPTY_MESSAGE_QUEUE),
            onSome: (handle) => handle.messageQueue
          })
        )
      ),
    GetWorkspace: () => workspace.getWorkspace,
    RegisterProject: ({ projectId, directory }) => workspace.registerProject(projectId, directory),
    RemoveProject: ({ projectId, force }) => workspace.removeProject(projectId, force),
    GetAgentSummaries: () => summaries.getAll,
    GetTranscriptWidth: () =>
      settings
        .getTranscriptWidth()
        .pipe(Effect.map(Option.getOrElse(() => DEFAULT_TRANSCRIPT_WIDTH))),
    GetPaneHistory: ({ paneId }) => workspace.getPaneHistory(paneId),
    GetTheme: () => settings.getTheme().pipe(Effect.map(Option.getOrElse(() => DEFAULT_THEME))),
    SetTheme: ({ theme }) => settings.setTheme(theme),
    GetSendMode: () =>
      settings.getSendMode().pipe(Effect.map(Option.getOrElse(() => DEFAULT_SEND_MODE))),
    SetSendMode: ({ mode }) => settings.setSendMode(mode),
    GetUsageLimitResume: () =>
      settings
        .getUsageLimitResume()
        .pipe(Effect.map(Option.getOrElse(() => DEFAULT_USAGE_LIMIT_RESUME))),
    SetUsageLimitResume: ({ mode }) => supervisor.setUsageLimitResume(mode),
    ListPlugins: () => plugins.list(),
    LoadPlugin: ({ name }) => plugins.load(name),
    UnloadPlugin: ({ name }) => plugins.unload(name),
    SetPluginOverride: ({ name, directory }) => applyOverride(pluginSources, name, directory),
    ClearPluginOverride: ({ name }) => pluginSources.clearOverride(name),
    GetModels: () => models.current,
    RefreshModels: () => models.refresh,
    GetAdapterStatus: () => adapterStatus.current,
    CheckAdapterHealth: () => adapterStatus.check,
    SetInstallPath: ({ path }) => adapterStatus.setInstallPath(path),
    GetModelPreferences: () => modelPreferences.current,
    SetModelPreference: ({ model, preference }) =>
      modelPreferences.set(model, Option.fromNullishOr(preference)),
    SetAgentDefaults: ({ defaults }) => modelPreferences.setDefaults(defaults),
    GetDisabledPermissionModes: ({ cwd }) =>
      resolveAgentBackend(plugins).pipe(
        Effect.flatMap((backend) => backend.disabledPermissionModes(cwd))
      ),
    ListActivities: () => activities.list,
    RunActivity: ({ plugin, id }) => activities.runNow(plugin, id),
    SubscribeEvents: ({ cursors }) => hub.subscribe(cursors)
  })
})

/**
 * Serves {@link DiaRpcs} with the handlers from {@link makeDiaRpcHandlers}. Provide it to an
 * `RpcServer` together with the services that effect requires.
 */
export const DiaRpcHandlersLive = DiaRpcs.toLayer(makeDiaRpcHandlers)
