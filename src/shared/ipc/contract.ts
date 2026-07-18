import { Schema } from 'effect'
import {
  AttentionState,
  PermissionResponse,
  PermissionUpdate,
  Question,
  QuestionResponse
} from '../domain/attention'
import { ConversationMessage } from '../domain/pane'
import { PaneNode } from '../domain/pane-tree'
import type { ThemePreference } from '../domain/theme'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/**
 * Electron IPC channel names shared by main, preload, and renderer.
 * Use `command` to send an {@link IpcCommand} from renderer to main, `event` to
 * receive an {@link IpcEvent} pushed from main to renderer, `getInitialLayout` to
 * fetch the pane tree on renderer startup, `getPaneHistory` to fetch a restored
 * pane's past conversation, `chooseDirectory` to invoke the native directory
 * picker, and `getTheme`/`setTheme` to read and persist the colour-theme choice.
 */
export const CHANNEL = {
  command: 'dia:command',
  event: 'dia:event',
  getInitialLayout: 'dia:getInitialLayout',
  getPaneHistory: 'dia:getPaneHistory',
  chooseDirectory: 'dia:chooseDirectory',
  getTheme: 'dia:getTheme',
  setTheme: 'dia:setTheme'
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
 * (identified by `requestId`) for the pane `paneId`. `response` carries the
 * user's decision: `Allow` (optionally with edited input and/or an "always
 * allow" rule) or `Deny` (with an explanation for the agent).
 */
export const ResolvePermission = Schema.TaggedStruct('ResolvePermission', {
  paneId: Schema.UUID,
  requestId: Schema.String,
  response: PermissionResponse
})
export type ResolvePermission = typeof ResolvePermission.Type

/**
 * Command sent by the renderer to answer a pending clarifying-question prompt
 * (identified by `requestId`) for the pane `paneId`. `response` carries the
 * user's `Answers` (per-question choices, including free text) or a
 * `FreeformResponse` typed instead of using the question card.
 */
export const ResolveQuestion = Schema.TaggedStruct('ResolveQuestion', {
  paneId: Schema.UUID,
  requestId: Schema.String,
  response: QuestionResponse
})
export type ResolveQuestion = typeof ResolveQuestion.Type

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

/**
 * Command sent by the renderer when the user focuses the pane `paneId`. A cold
 * (restored-but-not-yet-live) pane resumes its Agent SDK session on receipt; a
 * pane that is already live is left untouched (the command is idempotent).
 */
export const FocusPane = Schema.TaggedStruct('FocusPane', {
  paneId: Schema.UUID
})
export type FocusPane = typeof FocusPane.Type

/**
 * Union of every command the renderer may send over the `command` channel.
 * Main-process handlers should match on the `_tag` field to dispatch.
 */
export const IpcCommand = Schema.Union(
  SendMessage,
  ResolvePermission,
  ResolveQuestion,
  SplitPane,
  ClosePane,
  CreatePane,
  FocusPane
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
 * `suggestions`, when present, are the SDK's offered "always allow" rules the
 * renderer may echo back. Renderer should prompt the user and reply with a
 * {@link ResolvePermission} command carrying the same `requestId`.
 */
export const PanePermissionRequested = Schema.TaggedStruct('PanePermissionRequested', {
  paneId: Schema.UUID,
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  suggestions: Schema.optional(Schema.Array(PermissionUpdate))
})
export type PanePermissionRequested = typeof PanePermissionRequested.Type

/**
 * Event pushed to the renderer when the agent in pane `paneId` calls
 * `AskUserQuestion` and is blocked awaiting the user's answers. Renderer should
 * show the clarifying-question card and reply with a {@link ResolveQuestion}
 * command carrying the same `requestId`.
 */
export const PaneQuestionRequested = Schema.TaggedStruct('PaneQuestionRequested', {
  paneId: Schema.UUID,
  requestId: Schema.String,
  questions: Schema.Array(Question)
})
export type PaneQuestionRequested = typeof PaneQuestionRequested.Type

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
  PaneQuestionRequested,
  LayoutChanged,
  PaneCreateFailed,
  PaneAttentionChanged
)
export type IpcEvent = typeof IpcEvent.Type

/**
 * Shape of the `window.dia` bridge the preload script exposes to the renderer.
 * The single source of truth for that surface: preload's implementation is
 * checked against this interface, and the renderer's ambient `Window.dia`
 * declaration imports it directly, so the two can't drift apart.
 */
export interface DiaApi {
  sendMessage(paneId: string, text: string): void
  resolvePermission(paneId: string, requestId: string, response: PermissionResponse): void
  resolveQuestion(paneId: string, requestId: string, response: QuestionResponse): void
  splitPane(paneId: string, direction: 'row' | 'column'): void
  closePane(paneId: string): void
  createPane(paneId: string, cwd: string, model: string, useWorktree: boolean): void
  focusPane(paneId: string): void
  getInitialLayout(): Promise<PaneNode>
  getPaneHistory(paneId: string): Promise<ReadonlyArray<ConversationMessage>>
  chooseDirectory(): Promise<ChooseDirectoryResult>
  getTheme(): Promise<ThemePreference>
  setTheme(theme: ThemePreference): Promise<void>
  onMessageAppended(listener: (event: PaneMessageAppended) => void): () => void
  onLayoutChanged(listener: (event: LayoutChanged) => void): () => void
  onPaneCreateFailed(listener: (event: PaneCreateFailed) => void): () => void
  onAttentionChanged(listener: (event: PaneAttentionChanged) => void): () => void
  onPermissionRequested(listener: (event: PanePermissionRequested) => void): () => void
  onQuestionRequested(listener: (event: PaneQuestionRequested) => void): () => void
  onAssistantTextDelta(listener: (event: PaneAssistantTextDelta) => void): () => void
  onToolCallStarted(listener: (event: PaneToolCallStarted) => void): () => void
  onToolCallCompleted(listener: (event: PaneToolCallCompleted) => void): () => void
}
