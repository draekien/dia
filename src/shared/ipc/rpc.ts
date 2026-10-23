import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { ConversationMessage } from '../domain/pane'
import { PaneNode } from '../domain/pane-tree'
import { ThemePreference } from '../domain/theme'
import {
  ChooseDirectoryResult,
  ClosePane,
  CreatePane,
  FocusPane,
  InterruptPane,
  IpcEvent,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion,
  RewindToCheckpoint,
  SendMessage,
  SetPermissionMode,
  SetThinkingLevel,
  SplitPane
} from './contract'

/**
 * Version of the renderer-to-Host protocol. The renderer offers it as the WebSocket subprotocol
 * `dia.protocol.<version>`; the Host closes the connection with {@link CLOSE_PROTOCOL_MISMATCH}
 * when it speaks a different version. Increment it whenever {@link DiaRpcs} changes shape.
 */
export const PROTOCOL_VERSION = 1

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
 * Client-generated identifier of one command. The Host ignores a command whose `requestId` it
 * already accepted for the same pane, so a client that resends after a reconnect does not
 * apply the command twice. Generate a fresh one per user action and reuse it across retries.
 */
export const RequestId = Schema.String

const withRequestId = <Fields extends Schema.Struct.Fields>(command: Schema.Struct<Fields>) =>
  Schema.Struct({ ...command.fields, requestId: RequestId })

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

/** Event stream item for an event with no pane (such as a layout change). Never replayed. */
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
 * The Host's RPC surface. Every pane command takes a `requestId`; `SubscribeEvents` takes the
 * last sequence number received per pane (`cursors`) and streams {@link EventFrame}s. Serve it
 * with `RpcServer` in the Host and call it with `RpcClient` from the preload.
 */
export const DiaRpcs = RpcGroup.make(
  Rpc.make('SendMessage', { payload: withRequestId(SendMessage) }),
  Rpc.make('ResolvePermission', { payload: withRequestId(ResolvePermission) }),
  Rpc.make('ResolveQuestion', { payload: withRequestId(ResolveQuestion) }),
  Rpc.make('ResolvePlanReview', { payload: withRequestId(ResolvePlanReview) }),
  Rpc.make('SplitPane', { payload: withRequestId(SplitPane) }),
  Rpc.make('ClosePane', { payload: withRequestId(ClosePane) }),
  Rpc.make('CreatePane', { payload: withRequestId(CreatePane) }),
  Rpc.make('SetThinkingLevel', { payload: withRequestId(SetThinkingLevel) }),
  Rpc.make('SetPermissionMode', { payload: withRequestId(SetPermissionMode) }),
  Rpc.make('FocusPane', { payload: withRequestId(FocusPane) }),
  Rpc.make('InterruptPane', { payload: withRequestId(InterruptPane) }),
  Rpc.make('RewindToCheckpoint', { payload: withRequestId(RewindToCheckpoint) }),
  Rpc.make('GetInitialLayout', { success: PaneNode }),
  Rpc.make('GetPaneHistory', {
    payload: { paneId: Schema.String },
    success: Schema.Array(ConversationMessage)
  }),
  Rpc.make('GetTheme', { success: ThemePreference }),
  Rpc.make('SetTheme', { payload: { theme: ThemePreference } }),
  Rpc.make('GetLastDirectory', { success: Schema.NullOr(Schema.String) }),
  Rpc.make('RecordChosenDirectory', {
    payload: { path: Schema.String },
    success: ChooseDirectoryResult
  }),
  Rpc.make('SubscribeEvents', {
    payload: { cursors: Schema.Record(Schema.String, Schema.Finite) },
    success: EventFrame,
    stream: true
  })
)
