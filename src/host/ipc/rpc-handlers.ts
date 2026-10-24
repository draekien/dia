import { DEFAULT_THEME } from '@shared/domain/theme'
import { type IpcEvent, LayoutChanged, PaneCreateFailed } from '@shared/ipc/contract'
import { DiaRpcs } from '@shared/ipc/rpc'
import { Effect, FileSystem, Option, Path } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { applyOverride, PluginSources } from '../plugins/plugin-sources'
import { CommandDeduper } from '../services/command-deduper'
import { EventHub } from '../services/event-hub'
import { type PaneHandle, PaneSupervisor } from '../services/pane-supervisor'
import { PaneWorkspace } from '../services/pane-workspace'
import { SettingsStore } from '../services/settings-store'

/**
 * Builds the implementation of {@link DiaRpcs} on top of the Host's services. Requires
 * `PaneWorkspace`, `PaneSupervisor`, `SettingsStore`, `EventHub`, `CommandDeduper`,
 * `HostPlugins`, `PluginSources`, and `FileSystem`/`Path`. Use {@link DiaRpcHandlersLive} to serve it; call this directly to invoke
 * handlers without a transport.
 *
 * Every pane command is applied at most once per `commandId`, drops with a warning when its
 * target pane does not exist, and never fails the RPC: failures are logged. `SendMessage` starts
 * the pane's session on demand when the pane has none, so a message to a pane whose session
 * ended is not lost.
 */
export const makeDiaRpcHandlers = Effect.gen(function* () {
  const workspace = yield* PaneWorkspace
  const supervisor = yield* PaneSupervisor
  const settings = yield* SettingsStore
  const hub = yield* EventHub
  const deduper = yield* CommandDeduper
  const plugins = yield* HostPlugins
  const pluginSources = yield* PluginSources
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const publish = (event: IpcEvent): Effect.Effect<void> => hub.publish(event)

  const publishLayout = (tree: LayoutChanged['tree']): Effect.Effect<void> =>
    publish(LayoutChanged.make({ tree }))

  const once = (
    paneId: string,
    commandId: string,
    command: string,
    run: Effect.Effect<void>
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const accepted = yield* deduper.accept(paneId, commandId)
      if (!accepted) {
        yield* Effect.logDebug('Ignored resent command', { command, paneId, commandId })
        return
      }
      yield* run
    })

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
          handle.sendMessage(command.text)
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
    SplitPane: (command) =>
      once(
        command.paneId,
        command.commandId,
        'SplitPane',
        workspace.split(command.paneId, command.direction).pipe(
          Effect.flatMap(publishLayout),
          Effect.catch((issue) =>
            Effect.logWarning('Failed to split pane', { paneId: command.paneId, issue })
          )
        )
      ),
    ClosePane: (command) =>
      once(
        command.paneId,
        command.commandId,
        'ClosePane',
        workspace.close(command.paneId).pipe(
          Effect.flatMap(publishLayout),
          Effect.catch((issue) =>
            Effect.logWarning('Failed to close pane', { paneId: command.paneId, issue })
          )
        )
      ),
    CreatePane: (command) =>
      once(
        command.paneId,
        command.commandId,
        'CreatePane',
        workspace
          .createPane(
            command.paneId,
            command.cwd,
            command.model,
            command.thinkingLevel,
            command.permissionMode,
            command.useWorktree,
            publish
          )
          .pipe(
            Effect.flatMap(publishLayout),
            Effect.catch((issue) =>
              Effect.logWarning('Failed to create pane', {
                paneId: command.paneId,
                issue
              }).pipe(
                Effect.andThen(
                  publish(PaneCreateFailed.make({ paneId: command.paneId, reason: String(issue) }))
                )
              )
            )
          )
      ),
    SetThinkingLevel: (command) =>
      once(
        command.paneId,
        command.commandId,
        'SetThinkingLevel',
        workspace
          .setThinkingLevel(command.paneId, command.level)
          .pipe(Effect.flatMap(publishLayout))
      ),
    SetPermissionMode: (command) =>
      once(
        command.paneId,
        command.commandId,
        'SetPermissionMode',
        workspace
          .setPermissionMode(command.paneId, command.mode)
          .pipe(Effect.flatMap(publishLayout))
      ),
    FocusPane: (command) =>
      once(
        command.paneId,
        command.commandId,
        'FocusPane',
        workspace.resumePane(command.paneId, publish)
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
    RewindToCheckpoint: (command) =>
      once(
        command.paneId,
        command.commandId,
        'RewindToCheckpoint',
        withHandle(
          'RewindToCheckpoint',
          command.paneId,
          'Failed to rewind pane to checkpoint',
          (handle) => handle.rewindToCheckpoint(command.messageUuid, command.resumeAnchorUuid)
        )
      ),
    GetInitialLayout: () => workspace.getTree(),
    GetPaneHistory: ({ paneId }) => workspace.getPaneHistory(paneId),
    GetTheme: () => settings.getTheme().pipe(Effect.map(Option.getOrElse(() => DEFAULT_THEME))),
    SetTheme: ({ theme }) => settings.setTheme(theme),
    GetLastDirectory: () => settings.getLastDirectory().pipe(Effect.map(Option.getOrNull)),
    RecordChosenDirectory: ({ path: chosenPath }) =>
      Effect.gen(function* () {
        yield* settings.setLastDirectory(chosenPath)
        const isGitRepo = yield* fs
          .exists(path.join(chosenPath, '.git'))
          .pipe(Effect.orElseSucceed(() => false))
        return { path: chosenPath, isGitRepo }
      }),
    ListPlugins: () => plugins.list(),
    LoadPlugin: ({ name }) => plugins.load(name),
    UnloadPlugin: ({ name }) => plugins.unload(name),
    SetPluginOverride: ({ name, directory }) => applyOverride(pluginSources, name, directory),
    ClearPluginOverride: ({ name }) => pluginSources.clearOverride(name),
    SubscribeEvents: ({ cursors }) => hub.subscribe(cursors)
  })
})

/**
 * Serves {@link DiaRpcs} with the handlers from {@link makeDiaRpcHandlers}. Provide it to an
 * `RpcServer` together with the services that effect requires.
 */
export const DiaRpcHandlersLive = DiaRpcs.toLayer(makeDiaRpcHandlers)
