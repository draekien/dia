import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { AdapterStatusSnapshot } from '../domain/adapter-status'
import { AgentSummary } from '../domain/agent-summary'
import { ActivityId, ActivityInfo, ActivityNotFound } from '../domain/background-activity'
import { MessageQueueSnapshot, SendMode } from '../domain/message-queue'
import { ModelCatalogSnapshot } from '../domain/model'
import {
  AgentDefaults,
  LastVisibleModel,
  ModelPreference,
  ModelPreferencesSnapshot
} from '../domain/model-preferences'
import { ConversationMessage } from '../domain/pane'
import { ProjectId, ProjectNotFoundError, RegisterProjectError, Workspace } from '../domain/project'
import { RemovalProgress } from '../domain/project-removal'
import { ThemePreference } from '../domain/theme'
import { TranscriptWidth } from '../domain/transcript-width'
import { PluginInfo, PluginName, PluginOverrideResult } from '../plugin/manifest'
import {
  CreateTab,
  EditQueuedMessage,
  InterruptPane,
  IpcEvent,
  MoveProject,
  RemoveQueuedMessage,
  RenameTab,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion,
  RewindToCheckpoint,
  SelectTab,
  SendMessage,
  SetModel,
  SetPermissionMode,
  SetThinkingLevel,
  SetTranscriptWidth
} from './contract'

/**
 * Version of the renderer-to-Host protocol, `MAJOR.MINOR.PATCH`. The renderer offers it as the
 * WebSocket subprotocol `dia.protocol.<version>`; the Host closes the connection with
 * {@link CLOSE_PROTOCOL_MISMATCH} unless the client offers exactly this version. Bump it whenever
 * {@link DiaRpcs} changes shape; while dia is in development, increment the patch version.
 */
export const PROTOCOL_VERSION = '0.0.2'

/** Prefix of the WebSocket subprotocol that carries the Host's token: `dia.token.<hex>`. */
export const TOKEN_SUBPROTOCOL_PREFIX = 'dia.token.'

/** Prefix of the WebSocket subprotocol that carries the client's {@link PROTOCOL_VERSION}. */
export const VERSION_SUBPROTOCOL_PREFIX = 'dia.protocol.'

/**
 * WebSocket close code the Host sends after accepting an upgrade whose client speaks a
 * different {@link PROTOCOL_VERSION}. Browsers report a refused upgrade as close code 1006 for
 * every cause, so a version mismatch is signalled with an application code instead.
 */
export const CLOSE_PROTOCOL_MISMATCH = 4001

/**
 * Client-generated identifier of one command. The Host ignores a command whose `commandId` it
 * already accepted for the same target (pane, project, or app setting), so a client that resends after a reconnect does not
 * apply the command twice. Generate a fresh one per user action and reuse it across retries.
 */
export const CommandId = Schema.String

const withRequestId = <Fields extends Schema.Struct.Fields>(command: Schema.Struct<Fields>) =>
  Schema.Struct({ ...command.fields, commandId: CommandId })

/**
 * Event stream item for an event that belongs to a pane. `seq` is the pane's sequence number,
 * starting at 1, which a resubscribing client names as its cursor.
 */
export const PaneEventFrame = Schema.TaggedStruct('PaneEvent', {
  paneId: Schema.String,
  seq: Schema.Finite,
  event: IpcEvent
})
export type PaneEventFrame = typeof PaneEventFrame.Type

/** Event stream item for an event with no pane (such as a workspace change). Never replayed. */
export const GlobalEventFrame = Schema.TaggedStruct('GlobalEvent', { event: IpcEvent })
export type GlobalEventFrame = typeof GlobalEventFrame.Type

/**
 * Event stream item telling the client the Host no longer holds the events after its cursor for
 * `paneId`, so the client must reload that pane's history from the transcript.
 */
export const ReloadHistoryFrame = Schema.TaggedStruct('ReloadHistory', { paneId: Schema.String })
export type ReloadHistoryFrame = typeof ReloadHistoryFrame.Type

/** One item of the Host's event stream: a {@link PaneEventFrame}, {@link GlobalEventFrame} or {@link ReloadHistoryFrame}. */
export const EventFrame = Schema.Union([PaneEventFrame, GlobalEventFrame, ReloadHistoryFrame])
export type EventFrame = typeof EventFrame.Type

/**
 * The Host's RPC surface. Every command takes a `commandId`; `RegisterProject` and
 * `RemoveProject` are queries so their typed errors reach the caller; the plugin calls (`LoadPlugin`
 * on a loaded plugin reloads it), the model calls (`GetModels`, `RefreshModels`), the adapter calls
 * (`GetAdapterStatus`, `CheckAdapterHealth`, `SetInstallPath`, `GetModelPreferences`,
 * `SetModelPreference`, `SetAgentDefaults`, each setting a value, so repeating one is harmless) and
 * the activity calls (`ListActivities`, `RunActivity`) are safe to repeat and take none; a
 * `RefreshModels`, `CheckAdapterHealth` or `RunActivity` sent while that run is in progress waits
 * for it instead of starting another;
 * `SubscribeEvents` takes the
 * last sequence number received per pane (`cursors`) and streams {@link EventFrame}s. Serve it
 * with `RpcServer` in the Host and call it with `RpcClient` from the preload.
 */
export const DiaRpcs = RpcGroup.make(
  Rpc.make('SendMessage', { payload: withRequestId(SendMessage) }),
  Rpc.make('ResolvePermission', { payload: withRequestId(ResolvePermission) }),
  Rpc.make('ResolveQuestion', { payload: withRequestId(ResolveQuestion) }),
  Rpc.make('ResolvePlanReview', { payload: withRequestId(ResolvePlanReview) }),
  Rpc.make('CreateTab', { payload: withRequestId(CreateTab) }),
  Rpc.make('MoveProject', { payload: withRequestId(MoveProject) }),
  Rpc.make('RenameTab', { payload: withRequestId(RenameTab) }),
  Rpc.make('SelectTab', { payload: withRequestId(SelectTab) }),
  Rpc.make('SetTranscriptWidth', { payload: withRequestId(SetTranscriptWidth) }),
  Rpc.make('SetThinkingLevel', { payload: withRequestId(SetThinkingLevel) }),
  Rpc.make('SetPermissionMode', { payload: withRequestId(SetPermissionMode) }),
  Rpc.make('SetModel', { payload: withRequestId(SetModel) }),
  Rpc.make('InterruptPane', { payload: withRequestId(InterruptPane) }),
  Rpc.make('RewindToCheckpoint', { payload: withRequestId(RewindToCheckpoint) }),
  Rpc.make('EditQueuedMessage', { payload: withRequestId(EditQueuedMessage) }),
  Rpc.make('RemoveQueuedMessage', { payload: withRequestId(RemoveQueuedMessage) }),
  Rpc.make('GetMessageQueue', {
    payload: { paneId: Schema.String },
    success: MessageQueueSnapshot
  }),
  Rpc.make('GetWorkspace', { success: Workspace }),
  Rpc.make('RegisterProject', {
    payload: { projectId: ProjectId, directory: Schema.String },
    error: RegisterProjectError
  }),
  Rpc.make('RemoveProject', {
    payload: { projectId: ProjectId, force: Schema.Boolean },
    success: RemovalProgress,
    error: ProjectNotFoundError,
    stream: true
  }),
  Rpc.make('GetAgentSummaries', { success: Schema.Array(AgentSummary) }),
  Rpc.make('GetTranscriptWidth', { success: TranscriptWidth }),
  Rpc.make('GetPaneHistory', {
    payload: { paneId: Schema.String },
    success: Schema.Array(ConversationMessage)
  }),
  Rpc.make('GetTheme', { success: ThemePreference }),
  Rpc.make('SetTheme', { payload: { theme: ThemePreference } }),
  Rpc.make('GetSendMode', { success: SendMode }),
  Rpc.make('SetSendMode', { payload: { mode: SendMode } }),
  Rpc.make('ListPlugins', { success: Schema.Array(PluginInfo) }),
  Rpc.make('LoadPlugin', { payload: { name: PluginName }, success: PluginInfo }),
  Rpc.make('UnloadPlugin', { payload: { name: PluginName }, success: PluginInfo }),
  Rpc.make('SetPluginOverride', {
    payload: { name: PluginName, directory: Schema.String },
    success: PluginOverrideResult
  }),
  Rpc.make('ClearPluginOverride', { payload: { name: PluginName } }),
  Rpc.make('GetModels', { success: ModelCatalogSnapshot }),
  Rpc.make('RefreshModels', {}),
  Rpc.make('GetAdapterStatus', { success: AdapterStatusSnapshot }),
  Rpc.make('CheckAdapterHealth', {}),
  Rpc.make('SetInstallPath', { payload: { path: Schema.NullOr(Schema.NonEmptyString) } }),
  Rpc.make('GetModelPreferences', { success: ModelPreferencesSnapshot }),
  Rpc.make('SetModelPreference', {
    payload: { model: Schema.NonEmptyString, preference: Schema.NullOr(ModelPreference) },
    error: LastVisibleModel
  }),
  Rpc.make('SetAgentDefaults', { payload: { defaults: AgentDefaults } }),
  Rpc.make('ListActivities', { success: Schema.Array(ActivityInfo) }),
  Rpc.make('RunActivity', {
    payload: { plugin: PluginName, id: ActivityId },
    error: ActivityNotFound
  }),
  Rpc.make('SubscribeEvents', {
    payload: { cursors: Schema.Record(Schema.String, Schema.Finite) },
    success: EventFrame,
    stream: true
  })
)
