import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { AgentSummary } from '../domain/agent-summary'
import { ProjectEntry } from '../domain/attachment'
import { ActivityId, ActivityInfo, ActivityNotFound } from '../domain/background-activity'
import { SendMode } from '../domain/message-queue'
import { MetaRepoPushResult, MetaRepoStateResult } from '../domain/meta-repo'
import { PaneChatSnapshot } from '../domain/pane-chat'
import {
  ProjectId,
  ProjectNotFoundError,
  RegisterProjectError,
  Workspace,
  WorktreeNotRemovedError,
  WorktreeNotRestoredError
} from '../domain/project'
import { RemovalProgress } from '../domain/project-removal'
import { ThemePreference } from '../domain/theme'
import { TranscriptWidth } from '../domain/transcript-width'
import { Uuid } from '../domain/uuid'
import {
  ImportResolution,
  UnreadableRow,
  WorkspaceProblem,
  WorkspaceProblemError
} from '../domain/workspace-problem'
import { PluginInfo, PluginName, PluginOverrideResult } from '../plugin/manifest'
import { PluginCallAttempt, PluginCallError } from '../plugin/messages'
import {
  CreateTab,
  IpcEvent,
  MoveProject,
  RenameTab,
  SelectTab,
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
export const PROTOCOL_VERSION = '0.0.30'

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
 * Event stream item for an event that belongs to a pane. `seq` is the event's sequence number in
 * the Host's event store: it increases across a pane's events but is not contiguous, and survives a
 * Host restart. A resubscribing client names the last one it received as its cursor.
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
 * The Host's RPC surface. Every command takes a `commandId`; `RegisterProject`, `RemoveProject`,
 * `ArchiveTab`, `DeleteTab` and `UnarchiveTab` are queries so their typed errors reach the caller
 * (`ArchiveTab`, `DeleteTab` and `UnarchiveTab` succeed for a tab already gone, so repeating one is
 * harmless); the plugin calls (`LoadPlugin`
 * on a loaded plugin reloads it) and the activity calls (`ListActivities`, `RunActivity`) are safe
 * to repeat and take none; a `RunActivity` sent while that run is in progress waits for it instead
 * of starting another. The session, model and adapter calls are `dia-runs` plugin calls, made
 * through `CallPlugin` and `SubscribePlugin`;
 * the meta repo calls (`GetMetaRepo`, `SetMetaRemote`, `PushMetaRepo`) take none and report every
 * failure in their result, never as an RPC error;
 * the workspace problem calls (`ListWorkspaceProblems`, `DeleteUnreadableRow`,
 * `ResolveImportConflict`) take none, are safe to repeat (a resolved problem is a no-op) and fail
 * with `WorkspaceProblemError`;
 * `CallPlugin` takes none and runs a handler that plugin `plugin`'s `host` entry serves for `tag`,
 * with `payload` and the result encoded by the plugin's own schemas; it is resent like every query,
 * so the handler may run more than once; `call` carries the call's id, the same on every resend, and
 * whether this attempt is a resend;
 * `SubscribePlugin` is not a query: it streams the encoded values of a streaming call that plugin
 * `plugin`'s `host` entry serves for `tag`, the preload subscribes again after a lost connection,
 * and its handler may run more than once;
 * `SubscribeEvents` takes the
 * last sequence number received per pane (`cursors`) and streams {@link EventFrame}s. Serve it
 * with `RpcServer` in the Host and call it with `RpcClient` from the preload.
 */
export const DiaRpcs = RpcGroup.make(
  Rpc.make('CreateTab', { payload: withRequestId(CreateTab) }),
  Rpc.make('MoveProject', { payload: withRequestId(MoveProject) }),
  Rpc.make('RenameTab', { payload: withRequestId(RenameTab) }),
  Rpc.make('SelectTab', { payload: withRequestId(SelectTab) }),
  Rpc.make('SetTranscriptWidth', { payload: withRequestId(SetTranscriptWidth) }),
  Rpc.make('SetThinkingLevel', { payload: withRequestId(SetThinkingLevel) }),
  Rpc.make('SetPermissionMode', { payload: withRequestId(SetPermissionMode) }),
  Rpc.make('SetModel', { payload: withRequestId(SetModel) }),
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
  Rpc.make('ArchiveTab', { payload: { paneId: Uuid }, error: WorktreeNotRemovedError }),
  Rpc.make('DeleteTab', { payload: { paneId: Uuid }, error: WorktreeNotRemovedError }),
  Rpc.make('UnarchiveTab', { payload: { paneId: Uuid }, error: WorktreeNotRestoredError }),
  Rpc.make('GetAgentSummaries', { success: Schema.Array(AgentSummary) }),
  Rpc.make('GetTranscriptWidth', { success: TranscriptWidth }),
  Rpc.make('GetPaneChat', {
    payload: { paneId: Schema.String },
    success: PaneChatSnapshot
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
  Rpc.make('ListProjectEntries', {
    payload: { cwd: Schema.String },
    success: Schema.Array(ProjectEntry)
  }),
  Rpc.make('ListActivities', { success: Schema.Array(ActivityInfo) }),
  Rpc.make('RunActivity', {
    payload: { plugin: PluginName, id: ActivityId },
    error: ActivityNotFound
  }),
  Rpc.make('GetMetaRepo', { success: MetaRepoStateResult }),
  Rpc.make('SetMetaRemote', { payload: { url: Schema.String }, success: MetaRepoStateResult }),
  Rpc.make('PushMetaRepo', { success: MetaRepoPushResult }),
  Rpc.make('ListWorkspaceProblems', {
    success: Schema.Array(WorkspaceProblem),
    error: WorkspaceProblemError
  }),
  Rpc.make('DeleteUnreadableRow', { payload: UnreadableRow, error: WorkspaceProblemError }),
  Rpc.make('ResolveImportConflict', {
    payload: { agentId: Schema.String, resolution: ImportResolution },
    error: WorkspaceProblemError
  }),
  Rpc.make('CallPlugin', {
    payload: {
      plugin: PluginName,
      tag: Schema.NonEmptyString,
      payload: Schema.Unknown,
      call: PluginCallAttempt
    },
    success: Schema.Unknown,
    error: PluginCallError
  }),
  Rpc.make('SubscribePlugin', {
    payload: { plugin: PluginName, tag: Schema.NonEmptyString, payload: Schema.Unknown },
    success: Schema.Unknown,
    error: PluginCallError,
    stream: true
  }),
  Rpc.make('SubscribeEvents', {
    payload: { cursors: Schema.Record(Schema.String, Schema.Finite) },
    success: EventFrame,
    stream: true
  })
)
