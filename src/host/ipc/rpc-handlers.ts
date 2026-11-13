import { DEFAULT_SEND_MODE } from '@shared/domain/message-queue'
import type {
  TabNotFoundError,
  WorktreeNotRemovedError,
  WorktreeNotRestoredError
} from '@shared/domain/project'
import { DEFAULT_THEME } from '@shared/domain/theme'
import { DEFAULT_TRANSCRIPT_WIDTH } from '@shared/domain/transcript-width'
import { type IpcEvent, PaneCreateFailed } from '@shared/ipc/contract'
import { DiaRpcs } from '@shared/ipc/rpc'
import { Effect, Option, Stream } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { callPlugin, subscribePlugin } from '../plugins/plugin-messages'
import { applyOverride, PluginSources } from '../plugins/plugin-sources'
import { AgentSummaries } from '../services/agent-summaries'
import { BackgroundActivities } from '../services/background-activities'
import { CommandDeduper } from '../services/command-deduper'
import { EventHub } from '../services/event-hub'
import { withMetaRepo } from '../services/meta-repo-seam'
import { PaneWorkspace } from '../services/pane-workspace'
import { ProjectEntries } from '../services/project-entries'
import { RunEventLog } from '../services/run-event-log'
import { SettingsStore } from '../services/settings-store'
import { WorkspaceProblems } from '../services/workspace-problems'

/**
 * Builds the implementation of {@link DiaRpcs} on top of the Host's services. Requires
 * `PaneWorkspace`, `AgentSummaries`, `SettingsStore`, `EventHub`, `CommandDeduper`, `HostPlugins`,
 * `PluginSources`, `BackgroundActivities`, `RunEventLog` and `WorkspaceProblems`. Use
 * {@link DiaRpcHandlersLive} to serve it; call this directly to invoke handlers without a transport.
 *
 * Every command is applied at most once per `commandId` within its target (pane, project, or
 * `'app'`), drops with a warning when its target does not exist, and never fails the RPC:
 * failures are logged. `RegisterProject`, `RemoveProject`, `ArchiveTab`, `DeleteTab`,
 * `UnarchiveTab` and the workspace problem calls return their typed errors.
 */
export const makeDiaRpcHandlers = Effect.gen(function* () {
  const workspace = yield* PaneWorkspace
  const summaries = yield* AgentSummaries
  const settings = yield* SettingsStore
  const hub = yield* EventHub
  const projectEntries = yield* ProjectEntries
  const deduper = yield* CommandDeduper
  const plugins = yield* HostPlugins
  const pluginSources = yield* PluginSources
  const activities = yield* BackgroundActivities
  const problems = yield* WorkspaceProblems
  const paneChats = yield* RunEventLog

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

  const treatGoneTabAsDone =
    (call: string) =>
    <E extends WorktreeNotRemovedError | WorktreeNotRestoredError>(
      effect: Effect.Effect<void, TabNotFoundError | E>
    ): Effect.Effect<void, E> =>
      effect.pipe(
        Effect.catchTag('TabNotFoundError', (error) =>
          Effect.logInfo(`${call} found no tab to change`, { paneId: error.paneId })
        )
      )

  return DiaRpcs.of({
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
    GetWorkspace: () => workspace.getWorkspace,
    RegisterProject: ({ projectId, directory }) => workspace.registerProject(projectId, directory),
    RemoveProject: ({ projectId, force }) => workspace.removeProject(projectId, force),
    ArchiveTab: ({ paneId }) => workspace.archiveTab(paneId).pipe(treatGoneTabAsDone('ArchiveTab')),
    DeleteTab: ({ paneId }) => workspace.deleteTab(paneId).pipe(treatGoneTabAsDone('DeleteTab')),
    UnarchiveTab: ({ paneId }) =>
      workspace.unarchiveTab(paneId).pipe(treatGoneTabAsDone('UnarchiveTab')),
    GetAgentSummaries: () => summaries.getAll,
    GetTranscriptWidth: () =>
      settings
        .getTranscriptWidth()
        .pipe(Effect.map(Option.getOrElse(() => DEFAULT_TRANSCRIPT_WIDTH))),
    GetPaneChat: ({ paneId }) => paneChats.snapshot(paneId),
    GetTheme: () => settings.getTheme().pipe(Effect.map(Option.getOrElse(() => DEFAULT_THEME))),
    SetTheme: ({ theme }) => settings.setTheme(theme),
    GetSendMode: () =>
      settings.getSendMode().pipe(Effect.map(Option.getOrElse(() => DEFAULT_SEND_MODE))),
    SetSendMode: ({ mode }) => settings.setSendMode(mode),
    ListPlugins: () => plugins.list(),
    LoadPlugin: ({ name }) => plugins.load(name),
    UnloadPlugin: ({ name }) => plugins.unload(name),
    SetPluginOverride: ({ name, directory }) => applyOverride(pluginSources, name, directory),
    ClearPluginOverride: ({ name }) => pluginSources.clearOverride(name),
    ListProjectEntries: ({ cwd }) => projectEntries.list(cwd),
    ListActivities: () => activities.list,
    RunActivity: ({ plugin, id }) => activities.runNow(plugin, id),
    GetMetaRepo: () => withMetaRepo(plugins, (repo) => repo.state),
    SetMetaRemote: ({ url }) => withMetaRepo(plugins, (repo) => repo.setRemote(url)),
    PushMetaRepo: () => withMetaRepo(plugins, (repo) => repo.push),
    ListWorkspaceProblems: () => problems.list,
    DeleteUnreadableRow: (row) => problems.deleteUnreadable(row),
    ResolveImportConflict: ({ agentId, resolution }) =>
      problems.resolveImportConflict(agentId, resolution),
    CallPlugin: (request) => callPlugin(plugins, request),
    SubscribePlugin: (request) => Stream.unwrap(subscribePlugin(plugins, request)),
    SubscribeEvents: ({ cursors }) => hub.subscribe(cursors)
  })
})

/**
 * Serves {@link DiaRpcs} with the handlers from {@link makeDiaRpcHandlers}. Provide it to an
 * `RpcServer` together with the services that effect requires.
 */
export const DiaRpcHandlersLive = DiaRpcs.toLayer(makeDiaRpcHandlers)
