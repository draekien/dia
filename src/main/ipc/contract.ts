import { Schema } from 'effect'
import { AttentionState } from '../domain/attention'
import { ConversationMessage } from '../domain/pane'
import { PaneNode } from '../domain/pane-tree'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/**
 * Electron IPC channel names shared by main, preload, and renderer.
 * Use `command` to send an {@link IpcCommand} from renderer to main, `event` to
 * receive an {@link IpcEvent} pushed from main to renderer, `getInitialLayout` to
 * fetch the pane tree on renderer startup, and `chooseDirectory` to invoke the
 * native directory picker.
 */
export const CHANNEL = {
  command: 'dia:command',
  event: 'dia:event',
  getInitialLayout: 'dia:getInitialLayout',
  chooseDirectory: 'dia:chooseDirectory'
} as const

/**
 * Result of the native directory picker invoked over the `chooseDirectory`
 * channel. `null` means the user cancelled the dialog; otherwise `path` is the
 * chosen directory and `isGitRepo` reports whether it contains a `.git` folder.
 */
export const ChooseDirectoryResult = Schema.NullOr(
  Schema.Struct({
    path: Schema.String,
    isGitRepo: Schema.Boolean
  })
)
export type ChooseDirectoryResult = typeof ChooseDirectoryResult.Type

/**
 * Command sent by the renderer to submit a user prompt to the pane identified
 * by `paneId`. Dispatched over the `command` channel and consumed by the pane
 * supervisor to forward `text` into that pane's agent session.
 */
export const SendMessage = Schema.TaggedStruct('SendMessage', {
  paneId: Schema.UUID,
  text: Schema.String
})
export type SendMessage = typeof SendMessage.Type

/**
 * Command sent by the renderer to answer a pending tool-permission prompt
 * (identified by `requestId`) for the pane `paneId`. `decision` allows or
 * denies the tool call; `message` optionally explains a denial to the agent.
 */
export const ResolvePermission = Schema.TaggedStruct('ResolvePermission', {
  paneId: Schema.UUID,
  requestId: Schema.String,
  decision: Schema.Literal('allow', 'deny'),
  message: Schema.optional(Schema.String)
})
export type ResolvePermission = typeof ResolvePermission.Type

/**
 * Command sent by the renderer to split the pane `paneId` into two panes
 * arranged along `direction` (`row` for side-by-side, `column` for stacked).
 */
export const SplitPane = Schema.TaggedStruct('SplitPane', {
  paneId: Schema.UUID,
  direction: Schema.Literal('row', 'column')
})
export type SplitPane = typeof SplitPane.Type

/**
 * Command sent by the renderer to close the pane `paneId` and remove it from
 * the layout tree.
 */
export const ClosePane = Schema.TaggedStruct('ClosePane', {
  paneId: Schema.UUID
})
export type ClosePane = typeof ClosePane.Type

/**
 * Command sent by the renderer to create a new pane with id `paneId`, rooted
 * at `cwd`, running the given `model`. Set `useWorktree` to have the pane
 * operate on a dedicated git worktree instead of `cwd` directly.
 */
export const CreatePane = Schema.TaggedStruct('CreatePane', {
  paneId: Schema.UUID,
  cwd: Schema.String,
  model: Schema.String,
  useWorktree: Schema.Boolean
})
export type CreatePane = typeof CreatePane.Type

// Additional commands (FocusPane) join this union in later bullets.
/**
 * Union of every command the renderer may send over the `command` channel.
 * Main-process handlers should match on the `_tag` field to dispatch.
 */
export const IpcCommand = Schema.Union(
  SendMessage,
  ResolvePermission,
  SplitPane,
  ClosePane,
  CreatePane
)
export type IpcCommand = typeof IpcCommand.Type

/**
 * Event pushed to the renderer over the `event` channel when a new
 * conversation `message` (user, assistant, or system) has been appended to
 * the pane `paneId`. Renderer should append `message` to that pane's
 * conversation history.
 */
export const PaneMessageAppended = Schema.TaggedStruct('PaneMessageAppended', {
  paneId: Schema.UUID,
  message: ConversationMessage
})
export type PaneMessageAppended = typeof PaneMessageAppended.Type

/**
 * Event pushed to the renderer as the assistant streams a reply in pane
 * `paneId`. `text` is an incremental chunk to append to the in-progress
 * assistant message, not the full message so far.
 */
export const PaneAssistantTextDelta = Schema.TaggedStruct('PaneAssistantTextDelta', {
  paneId: Schema.UUID,
  text: Schema.String
})
export type PaneAssistantTextDelta = typeof PaneAssistantTextDelta.Type

/**
 * Event pushed to the renderer when the agent in pane `paneId` begins
 * invoking tool `toolName`, identified by `toolCallId` for correlating with
 * the later {@link PaneToolCallCompleted} event.
 */
export const PaneToolCallStarted = Schema.TaggedStruct('PaneToolCallStarted', {
  paneId: Schema.UUID,
  toolCallId: Schema.String,
  toolName: Schema.String
})
export type PaneToolCallStarted = typeof PaneToolCallStarted.Type

/**
 * Event pushed to the renderer when the tool call `toolCallId` (`toolName`)
 * previously reported via {@link PaneToolCallStarted} in pane `paneId` has
 * finished, carrying the resolved `input` the tool was called with.
 */
export const PaneToolCallCompleted = Schema.TaggedStruct('PaneToolCallCompleted', {
  paneId: Schema.UUID,
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord
})
export type PaneToolCallCompleted = typeof PaneToolCallCompleted.Type

/**
 * Event pushed to the renderer when the agent in pane `paneId` wants to run
 * tool `toolName` with the given `input` and is blocked awaiting approval.
 * Renderer should prompt the user and reply with a {@link ResolvePermission}
 * command carrying the same `requestId`.
 */
export const PanePermissionRequested = Schema.TaggedStruct('PanePermissionRequested', {
  paneId: Schema.UUID,
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord
})
export type PanePermissionRequested = typeof PanePermissionRequested.Type

/**
 * Event pushed to the renderer whenever the pane layout tree changes (pane
 * created, split, closed, or resized). `tree` is the full, current layout and
 * should replace the renderer's local copy rather than being merged.
 */
export const LayoutChanged = Schema.TaggedStruct('LayoutChanged', {
  tree: PaneNode
})
export type LayoutChanged = typeof LayoutChanged.Type

/**
 * Event pushed to the renderer when a {@link CreatePane} command for pane
 * `paneId` could not be completed, with `reason` describing what went wrong
 * so the renderer can surface it and roll back any optimistic UI state.
 */
export const PaneCreateFailed = Schema.TaggedStruct('PaneCreateFailed', {
  paneId: Schema.UUID,
  reason: Schema.String
})
export type PaneCreateFailed = typeof PaneCreateFailed.Type

/**
 * Event pushed to the renderer when the attention state of pane `paneId`
 * changes (e.g. the agent needs input or has finished working), so the
 * renderer can update attention indicators such as tab badges.
 */
export const PaneAttentionChanged = Schema.TaggedStruct('PaneAttentionChanged', {
  paneId: Schema.UUID,
  attention: AttentionState
})
export type PaneAttentionChanged = typeof PaneAttentionChanged.Type

// Additional events (PaneClosed) join this union in later bullets.
/**
 * Union of every event the main process may push to the renderer over the
 * `event` channel. Renderer handlers should match on the `_tag` field to
 * dispatch.
 */
export const IpcEvent = Schema.Union(
  PaneMessageAppended,
  PaneAssistantTextDelta,
  PaneToolCallStarted,
  PaneToolCallCompleted,
  PanePermissionRequested,
  LayoutChanged,
  PaneCreateFailed,
  PaneAttentionChanged
)
export type IpcEvent = typeof IpcEvent.Type
