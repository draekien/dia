import { Schema } from 'effect'
import { AgentSummary } from '../domain/agent-summary'
import {
  AttentionState,
  PermissionResponse,
  PermissionUpdate,
  Question,
  QuestionResponse
} from '../domain/attention'
import { MessageQueueSnapshot, OutgoingMessage, SendMode } from '../domain/message-queue'
import { ConversationMessage, PermissionMode, ThinkingLevel } from '../domain/pane'
import type { RegisterProjectRefusal } from '../domain/project'
import { AgentName, CreateTabRequest, ProjectId, Workspace } from '../domain/project'
import type { RemovalProgress } from '../domain/project-removal'
import { SlashCommandInfo } from '../domain/slash-command'
import type { ThemePreference } from '../domain/theme'
import { TranscriptWidth } from '../domain/transcript-width'
import { UpdateStatus } from '../domain/update'
import { Uuid } from '../domain/uuid'
import { type PluginInfo, PluginName, type PluginOverrideResult } from '../plugin/manifest'

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)

/**
 * Electron IPC channel names shared by main, preload, and renderer. Only window duties travel
 * over Electron IPC; every pane and workspace operation goes to the Host over its WebSocket
 * (see `DiaRpcs`). `event` carries updater status pushed from main; `getHostConnection` returns
 * the Host's {@link HostConnection}; `chooseDirectory` opens the native directory picker given
 * a default path; `setTitleBarOverlay` recolours the native window-control overlay when the
 * theme changes; `getAppVersion`/`getUpdateStatus`/`checkForUpdates`/`installUpdate` read the
 * running version and drive the self-updater; `toggleDevTools` opens or closes the renderer's
 * DevTools (dia's custom title bar has no native menu to do so); `revealPath` shows a directory
 * in the system file manager.
 */
export const CHANNEL = {
  event: 'dia:event',
  getHostConnection: 'dia:getHostConnection',
  chooseDirectory: 'dia:chooseDirectory',
  setTitleBarOverlay: 'dia:setTitleBarOverlay',
  getAppVersion: 'dia:getAppVersion',
  getUpdateStatus: 'dia:getUpdateStatus',
  checkForUpdates: 'dia:checkForUpdates',
  installUpdate: 'dia:installUpdate',
  toggleDevTools: 'dia:toggleDevTools',
  revealPath: 'dia:revealPath'
} as const

/**
 * Where and how the renderer reaches the Host: the loopback `port` its WebSocket listens on and
 * the `token` the client presents as the subprotocol `dia.token.<token>`. Main obtains it from
 * the Host at startup and hands it to the preload over {@link CHANNEL}.getHostConnection.
 */
export const HostConnection = Schema.Struct({
  port: Schema.Finite,
  token: Schema.String
})
export type HostConnection = typeof HostConnection.Type

/**
 * The colours the renderer pushes to the main process (over `setTitleBarOverlay`)
 * so the OS-drawn window-control buttons match the active theme: `color` is the
 * overlay background (matched to the app header), `symbolColor` the button glyph
 * colour. Both are CSS colour strings the platform title-bar overlay accepts
 * (hex/rgb — not `oklch`).
 */
export const TitleBarOverlayColors = Schema.Struct({
  color: Schema.String,
  symbolColor: Schema.String
})
export type TitleBarOverlayColors = typeof TitleBarOverlayColors.Type

/**
 * Result of choosing a directory (native picker plus the Host's git check).
 * `null` means the user cancelled the dialog; otherwise `path` is the
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
 * by `paneId`. Consumed by the pane
 * supervisor to forward `text` into that pane's agent session. `mode` decides
 * what happens while a turn runs: `queue` holds the message until the turn
 * ends, `steer` interrupts the turn so the message runs next.
 */
export const SendMessage = Schema.TaggedStruct('SendMessage', {
  paneId: Uuid,
  text: Schema.String,
  mode: SendMode
})
export type SendMessage = typeof SendMessage.Type

/**
 * Command sent by the renderer to replace the text of queued message
 * `messageId` in pane `paneId`. A message already sent is left alone.
 */
export const EditQueuedMessage = Schema.TaggedStruct('EditQueuedMessage', {
  paneId: Uuid,
  messageId: Schema.String,
  text: Schema.String
})
export type EditQueuedMessage = typeof EditQueuedMessage.Type

/**
 * Command sent by the renderer to remove queued message `messageId` from pane
 * `paneId`, so the agent never receives it. A message already sent is left alone.
 */
export const RemoveQueuedMessage = Schema.TaggedStruct('RemoveQueuedMessage', {
  paneId: Uuid,
  messageId: Schema.String
})
export type RemoveQueuedMessage = typeof RemoveQueuedMessage.Type

/**
 * Command sent by the renderer to answer a pending tool-permission prompt
 * (identified by `requestId`) for the pane `paneId`. `response` carries the
 * user's decision: `Allow` (optionally with edited input and/or an "always
 * allow" rule) or `Deny` (with an explanation for the agent).
 */
export const ResolvePermission = Schema.TaggedStruct('ResolvePermission', {
  paneId: Uuid,
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
  paneId: Uuid,
  requestId: Schema.String,
  response: QuestionResponse
})
export type ResolveQuestion = typeof ResolveQuestion.Type

/**
 * Command sent by the renderer to start a new agent as a tab of a project; see
 * {@link CreateTabRequest}. The new tab becomes the visible tab. On failure the Host sends
 * {@link PaneCreateFailed} for `paneId`.
 */
export const CreateTab = Schema.TaggedStruct('CreateTab', CreateTabRequest.fields)
export type CreateTab = typeof CreateTab.Type

/**
 * Command sent by the renderer to move project `projectId` to position `toIndex` in the project
 * order. An index past either end moves it to that end.
 */
export const MoveProject = Schema.TaggedStruct('MoveProject', {
  projectId: ProjectId,
  toIndex: Schema.Int
})
export type MoveProject = typeof MoveProject.Type

/** Command sent by the renderer to rename the tab of pane `paneId`. */
export const RenameTab = Schema.TaggedStruct('RenameTab', {
  paneId: Uuid,
  name: AgentName
})
export type RenameTab = typeof RenameTab.Type

/**
 * Command sent by the renderer to show the tab of pane `paneId`, or no tab when `paneId` is
 * `null` (the New agent form or the plugins page is shown). Showing a tab whose session is not
 * running resumes it.
 */
export const SelectTab = Schema.TaggedStruct('SelectTab', {
  paneId: Schema.NullOr(Uuid)
})
export type SelectTab = typeof SelectTab.Type

/** Command sent by the renderer to change the app-wide transcript width. */
export const SetTranscriptWidth = Schema.TaggedStruct('SetTranscriptWidth', {
  width: TranscriptWidth
})
export type SetTranscriptWidth = typeof SetTranscriptWidth.Type

/**
 * Command sent by the renderer to change the thinking level of the live pane
 * `paneId`. The change is persisted and applied on the pane's next user turn
 * (which restarts its Agent SDK session with the new thinking/effort options).
 */
export const SetThinkingLevel = Schema.TaggedStruct('SetThinkingLevel', {
  paneId: Uuid,
  level: ThinkingLevel
})
export type SetThinkingLevel = typeof SetThinkingLevel.Type

/**
 * Command sent by the renderer to change the permission mode of the live pane
 * `paneId`. Applied immediately to the running Agent SDK session (so it affects
 * the next tool call, not just the next turn) and persisted on the pane's
 * `PaneConfig`. Switching into `plan` records the prior mode so it can be
 * restored when the pane's plan is approved.
 */
export const SetPermissionMode = Schema.TaggedStruct('SetPermissionMode', {
  paneId: Uuid,
  mode: PermissionMode
})
export type SetPermissionMode = typeof SetPermissionMode.Type

/**
 * Command sent by the renderer to answer a pending plan review (identified by
 * `requestId`) for the pane `paneId`, raised when the agent called
 * `ExitPlanMode`. `approved` true lets the agent proceed and restores the mode
 * the pane held before entering plan mode; false keeps the pane planning.
 */
export const ResolvePlanReview = Schema.TaggedStruct('ResolvePlanReview', {
  paneId: Uuid,
  requestId: Schema.String,
  approved: Schema.Boolean
})
export type ResolvePlanReview = typeof ResolvePlanReview.Type

/**
 * Command sent by the renderer to interrupt the running turn of pane `paneId`.
 * The pane supersedes any pending permission/question/plan prompt and aborts
 * in-flight generation, so a turn that has stalled with no response can be
 * cancelled without sending a new message.
 */
export const InterruptPane = Schema.TaggedStruct('InterruptPane', {
  paneId: Uuid
})
export type InterruptPane = typeof InterruptPane.Type

/**
 * Command sent by the renderer to rewind pane `paneId` to a prior checkpoint:
 * `messageUuid` is a user-turn UUID previously surfaced via
 * {@link PaneCheckpointAvailable}, and `resumeAnchorUuid` (from the same event)
 * is the preceding assistant turn the conversation branches at. The pane
 * restores the working tree to the user turn's pre-edit state and branches the
 * conversation just before it, so files and conversation are rewound together.
 * `resumeAnchorUuid` is absent when rewinding the first turn (the pane starts a
 * fresh conversation). This is destructive (that turn onward, and its file
 * edits, are discarded); the renderer should confirm with the user first.
 */
export const RewindToCheckpoint = Schema.TaggedStruct('RewindToCheckpoint', {
  paneId: Uuid,
  messageUuid: Schema.String,
  resumeAnchorUuid: Schema.optional(Schema.String)
})
export type RewindToCheckpoint = typeof RewindToCheckpoint.Type

/**
 * Event pushed to the renderer to the renderer when a new
 * conversation `message` (user, assistant, or system) has been appended to
 * the pane `paneId`. Renderer should append `message` to that pane's
 * conversation history.
 */
export const PaneMessageAppended = Schema.TaggedStruct('PaneMessageAppended', {
  paneId: Uuid,
  message: ConversationMessage
})
export type PaneMessageAppended = typeof PaneMessageAppended.Type

/**
 * Event pushed to the renderer as the assistant streams a reply in pane
 * `paneId`. `text` is an incremental chunk to append to the in-progress
 * assistant message, not the full message so far.
 */
export const PaneAssistantTextDelta = Schema.TaggedStruct('PaneAssistantTextDelta', {
  paneId: Uuid,
  text: Schema.String
})
export type PaneAssistantTextDelta = typeof PaneAssistantTextDelta.Type

/**
 * Event pushed to the renderer as the assistant streams its extended-thinking
 * text (before the answer) in pane `paneId`. `text` is an incremental chunk to
 * append to the in-progress thinking block, not the full thinking so far.
 */
export const PaneAssistantThinkingDelta = Schema.TaggedStruct('PaneAssistantThinkingDelta', {
  paneId: Uuid,
  text: Schema.String
})
export type PaneAssistantThinkingDelta = typeof PaneAssistantThinkingDelta.Type

/**
 * Event pushed to the renderer when the agent in pane `paneId` begins
 * invoking tool `toolName`, identified by `toolCallId` for correlating with
 * the later {@link PaneToolCallCompleted} event.
 */
export const PaneToolCallStarted = Schema.TaggedStruct('PaneToolCallStarted', {
  paneId: Uuid,
  toolCallId: Schema.String,
  toolName: Schema.String
})
export type PaneToolCallStarted = typeof PaneToolCallStarted.Type

/**
 * Event pushed to the renderer when the tool call `toolCallId` (`toolName`)
 * previously reported via {@link PaneToolCallStarted} in pane `paneId` has
 * finished, carrying the resolved `input` the tool was called with, the
 * `output` it produced (flattened to text; empty when the turn ended before a
 * result arrived), and `isError` flagging a failed or denied result.
 */
export const PaneToolCallCompleted = Schema.TaggedStruct('PaneToolCallCompleted', {
  paneId: Uuid,
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  output: Schema.String,
  isError: Schema.Boolean
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
  paneId: Uuid,
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
  paneId: Uuid,
  requestId: Schema.String,
  questions: Schema.Array(Question)
})
export type PaneQuestionRequested = typeof PaneQuestionRequested.Type

/**
 * Event pushed to the renderer when the agent in pane `paneId` (running in
 * `plan` mode) calls `ExitPlanMode` to present its `plan` and is blocked
 * awaiting approval. Renderer should show the plan-review card and reply with a
 * {@link ResolvePlanReview} command carrying the same `requestId`.
 */
export const PanePlanReviewRequested = Schema.TaggedStruct('PanePlanReviewRequested', {
  paneId: Uuid,
  requestId: Schema.String,
  plan: Schema.String
})
export type PanePlanReviewRequested = typeof PanePlanReviewRequested.Type

/**
 * Event pushed to the renderer when pane `paneId`'s slash-command warm-up
 * begins (`active` true) or fails without producing a list (`active` false),
 * so the renderer can show a "loading commands" indicator above the input while
 * the session's command set is being discovered. A successful warm-up ends the
 * warming state via {@link PaneSlashCommandsAvailable} rather than this event.
 */
export const PaneSlashCommandsWarming = Schema.TaggedStruct('PaneSlashCommandsWarming', {
  paneId: Uuid,
  active: Schema.Boolean
})
export type PaneSlashCommandsWarming = typeof PaneSlashCommandsWarming.Type

/**
 * Event pushed to the renderer with the slash commands available in pane
 * `paneId`'s live session, so the renderer can offer them in the `/` popover.
 * Sent when the session starts (names only, empty hints) and again whenever the
 * session's command set changes (enriched with descriptions and argument
 * hints). `commands` is the complete, replacement set — the renderer should
 * replace its held list rather than merge.
 */
export const PaneSlashCommandsAvailable = Schema.TaggedStruct('PaneSlashCommandsAvailable', {
  paneId: Uuid,
  commands: Schema.Array(SlashCommandInfo)
})
export type PaneSlashCommandsAvailable = typeof PaneSlashCommandsAvailable.Type

/**
 * Event pushed to the renderer when pane `paneId`'s conversation context was
 * compacted (e.g. the user ran `/compact`), so the renderer can mark the
 * boundary in the transcript. `preTokens`/`postTokens` bracket the compaction
 * and `trigger` distinguishes a manual `/compact` from an automatic one.
 */
export const PaneConversationCompacted = Schema.TaggedStruct('PaneConversationCompacted', {
  paneId: Uuid,
  trigger: Schema.Literals(['manual', 'auto']),
  preTokens: Schema.Number,
  postTokens: Schema.optional(Schema.Number)
})
export type PaneConversationCompacted = typeof PaneConversationCompacted.Type

/**
 * Event pushed to the renderer when pane `paneId`'s conversation was reset to
 * empty (e.g. the user ran `/clear`), so the renderer can clear the pane's
 * displayed transcript. The new underlying session id is persisted in the main
 * process and is not part of this renderer-facing event.
 */
export const PaneConversationReset = Schema.TaggedStruct('PaneConversationReset', {
  paneId: Uuid
})
export type PaneConversationReset = typeof PaneConversationReset.Type

/**
 * Event pushed to the renderer once per user turn in pane `paneId`, carrying the
 * turn's `messageUuid` file-checkpoint id and, when a prior assistant turn
 * exists, `resumeAnchorUuid` — the assistant turn the conversation branches at
 * on rewind. The renderer associates both with the turn so a "rewind to here"
 * affordance can dispatch a {@link RewindToCheckpoint} command carrying them.
 * `resumeAnchorUuid` is absent for the first turn of a conversation. Emitted
 * only while file checkpointing is enabled.
 */
export const PaneCheckpointAvailable = Schema.TaggedStruct('PaneCheckpointAvailable', {
  paneId: Uuid,
  messageUuid: Schema.String,
  resumeAnchorUuid: Schema.optional(Schema.String)
})
export type PaneCheckpointAvailable = typeof PaneCheckpointAvailable.Type

/**
 * Event pushed to the renderer after a {@link RewindToCheckpoint} completes for
 * pane `paneId`, carrying the `messageUuid` that was rewound to. The renderer
 * should truncate the pane's displayed transcript at that turn (its files and
 * conversation are now branched there).
 */
export const PaneRewoundToCheckpoint = Schema.TaggedStruct('PaneRewoundToCheckpoint', {
  paneId: Uuid,
  messageUuid: Schema.String
})
export type PaneRewoundToCheckpoint = typeof PaneRewoundToCheckpoint.Type

/**
 * Event pushed to the renderer whenever the message queue of pane `paneId`
 * changes, carrying the whole queue in send order. Replaces the queue the
 * renderer shows.
 */
export const PaneMessageQueueChanged = Schema.TaggedStruct('PaneMessageQueueChanged', {
  paneId: Uuid,
  ...MessageQueueSnapshot.fields
})
export type PaneMessageQueueChanged = typeof PaneMessageQueueChanged.Type

/**
 * Event pushed to the renderer when pane `paneId` gives `messages` to the agent
 * as one turn, in order. The renderer adds each to the transcript as a user turn.
 */
export const PaneUserMessagesSent = Schema.TaggedStruct('PaneUserMessagesSent', {
  paneId: Uuid,
  messages: Schema.Array(OutgoingMessage)
})
export type PaneUserMessagesSent = typeof PaneUserMessagesSent.Type

/**
 * Event pushed to the renderer whenever the workspace changes: a project was registered, moved
 * or removed, a tab was created, renamed or changed, or the visible tab changed. `workspace` is
 * the full current workspace and replaces the renderer's copy. Never replayed.
 */
export const WorkspaceChanged = Schema.TaggedStruct('WorkspaceChanged', {
  workspace: Workspace
})
export type WorkspaceChanged = typeof WorkspaceChanged.Type

/**
 * Event pushed to the renderer when one tab's status or activity line changes. `summary`
 * replaces the renderer's summary for `summary.paneId`. Never replayed.
 */
export const AgentSummaryChanged = Schema.TaggedStruct('AgentSummaryChanged', {
  summary: AgentSummary
})
export type AgentSummaryChanged = typeof AgentSummaryChanged.Type

/**
 * Event the preload raises (the Host never sends it) after reconnecting, carrying every tab's
 * summary as the Host now holds it. Replaces all of the renderer's summaries.
 */
export const AgentSummariesReplaced = Schema.TaggedStruct('AgentSummariesReplaced', {
  summaries: Schema.Array(AgentSummary)
})
export type AgentSummariesReplaced = typeof AgentSummariesReplaced.Type

/**
 * Event pushed to the renderer when a {@link CreateTab} command for pane
 * `paneId` could not be completed, with `reason` describing what went wrong
 * so the renderer can surface it and roll back any optimistic UI state.
 */
export const PaneCreateFailed = Schema.TaggedStruct('PaneCreateFailed', {
  paneId: Uuid,
  reason: Schema.String
})
export type PaneCreateFailed = typeof PaneCreateFailed.Type

/**
 * Event pushed to the renderer when the attention state of pane `paneId`
 * changes (e.g. the agent needs input or has finished working), so the
 * renderer can update attention indicators such as tab badges.
 */
export const PaneAttentionChanged = Schema.TaggedStruct('PaneAttentionChanged', {
  paneId: Uuid,
  attention: AttentionState
})
export type PaneAttentionChanged = typeof PaneAttentionChanged.Type

/**
 * Event pushed to the renderer whenever the app's background self-update
 * changes state (checking, downloading, ready to install, up to date, or
 * errored). `status` is the full current {@link UpdateStatus} and replaces the
 * renderer's held value. Drives the header update indicator and the About
 * dialog's update line.
 */
export const UpdateStatusChanged = Schema.TaggedStruct('UpdateStatusChanged', {
  status: UpdateStatus
})
export type UpdateStatusChanged = typeof UpdateStatusChanged.Type

/**
 * Event pushed to the renderer whenever the state of plugin `name` changes (it started loading,
 * finished loading, failed, was unloaded, or began waiting for a service). It carries no state:
 * read the current one with `window.dia.plugins.list`. Never replayed after a reconnect, so
 * re-read the list when the connection returns.
 */
export const PluginStatusChanged = Schema.TaggedStruct('PluginStatusChanged', {
  name: PluginName
})
export type PluginStatusChanged = typeof PluginStatusChanged.Type

// Additional events (PaneClosed) join this union in later bullets.
/**
 * Union of every event pushed to the renderer, by the Host's event stream or
 * by main for updater status. Renderer handlers should match on the `_tag` field to
 * dispatch.
 */
export const IpcEvent = Schema.Union([
  PaneMessageAppended,
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneToolCallStarted,
  PaneToolCallCompleted,
  PanePermissionRequested,
  PaneQuestionRequested,
  PanePlanReviewRequested,
  PaneSlashCommandsWarming,
  PaneSlashCommandsAvailable,
  PaneConversationCompacted,
  PaneConversationReset,
  PaneCheckpointAvailable,
  PaneRewoundToCheckpoint,
  PaneMessageQueueChanged,
  PaneUserMessagesSent,
  WorkspaceChanged,
  AgentSummaryChanged,
  AgentSummariesReplaced,
  PaneCreateFailed,
  PaneAttentionChanged,
  PluginStatusChanged,
  UpdateStatusChanged
])
export type IpcEvent = typeof IpcEvent.Type

/**
 * The plugin lifecycle calls of `window.dia.plugins`, served by the Host. Each call resolves
 * with the plugin's resulting state; failures to load are reported in the state, not thrown.
 */
export interface PluginApi {
  /** Every known plugin with where it loads from and its state. */
  list(): Promise<ReadonlyArray<PluginInfo>>
  /** Opens a plugin, or reloads it when it is already open. A failure is a `Failed` status in the result. */
  load(name: string): Promise<PluginInfo>
  /** Closes a plugin; plugins that depend on a service it provides wait until it is loaded again. */
  unload(name: string): Promise<PluginInfo>
  /** Points a plugin at a source directory; nothing is loaded until `load`. Resolves `Rejected` with the reason when the directory cannot be a plugin source. */
  setOverride(name: string, directory: string): Promise<PluginOverrideResult>
  /** Returns a plugin to the copy shipped with dia; nothing is loaded until `load`. */
  clearOverride(name: string): Promise<void>
  /**
   * Subscribes to plugin state changes, including each plugin finishing its load while the Host
   * starts. The listener receives the plugin's name; call `list` for the new state. Returns a
   * function that stops listening.
   */
  onStatusChanged(listener: (event: PluginStatusChanged) => void): () => void
}

/**
 * Shape of the `window.dia` bridge the preload script exposes to the renderer.
 * The single source of truth for that surface: preload's implementation is
 * checked against this interface, and the renderer's ambient `Window.dia`
 * declaration imports it directly, so the two can't drift apart.
 */
export interface DiaApi {
  readonly plugins: PluginApi
  sendMessage(paneId: string, text: string, mode: SendMode): void
  editQueuedMessage(paneId: string, messageId: string, text: string): void
  removeQueuedMessage(paneId: string, messageId: string): void
  getMessageQueue(paneId: string): Promise<MessageQueueSnapshot>
  resolvePermission(paneId: string, requestId: string, response: PermissionResponse): void
  resolveQuestion(paneId: string, requestId: string, response: QuestionResponse): void
  setThinkingLevel(paneId: string, level: ThinkingLevel): void
  setPermissionMode(paneId: string, mode: PermissionMode): void
  resolvePlanReview(paneId: string, requestId: string, approved: boolean): void
  interrupt(paneId: string): void
  rewindToCheckpoint(paneId: string, messageUuid: string, resumeAnchorUuid?: string): void
  getWorkspace(): Promise<Workspace>
  /**
   * Registers `directory` as project `projectId`; generate the id once per user action so a
   * resend is harmless. Resolves `null` once registered, or the refusal when the directory is
   * already registered or does not exist.
   */
  registerProject(projectId: ProjectId, directory: string): Promise<RegisterProjectRefusal | null>
  moveProject(projectId: ProjectId, toIndex: number): void
  /**
   * Removes project `projectId`, reporting each step to `onProgress`. With `force`, drops the
   * project after stopping its agents and leaves worktrees and transcripts on disk. Rejects when
   * the connection drops; read `getWorkspace` to learn whether the project is gone. Resolves
   * when the stream ends, also when the project was already gone.
   */
  removeProject(
    projectId: ProjectId,
    force: boolean,
    onProgress: (progress: RemovalProgress) => void
  ): Promise<void>
  createTab(request: CreateTab): void
  renameTab(paneId: string, name: AgentName): void
  selectTab(paneId: string | null): void
  getAgentSummaries(): Promise<ReadonlyArray<AgentSummary>>
  getTranscriptWidth(): Promise<TranscriptWidth>
  setTranscriptWidth(width: TranscriptWidth): void
  /** Shows `directory` in the system file manager; does nothing when it is not a directory. */
  revealPath(directory: string): Promise<void>
  getPaneHistory(paneId: string): Promise<ReadonlyArray<ConversationMessage>>
  chooseDirectory(): Promise<ChooseDirectoryResult>
  /** Opens the native folder picker and resolves the chosen path, or `null` when the user cancels. Unlike `chooseDirectory`, the choice is not recorded as the last pane directory. */
  pickDirectory(): Promise<string | null>
  getTheme(): Promise<ThemePreference>
  setTheme(theme: ThemePreference): Promise<void>
  getSendMode(): Promise<SendMode>
  setSendMode(mode: SendMode): Promise<void>
  setTitleBarOverlay(colors: TitleBarOverlayColors): void
  getAppVersion(): Promise<string>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): void
  installUpdate(): void
  toggleDevTools(): void
  onUpdateStatusChanged(listener: (event: UpdateStatusChanged) => void): () => void
  /**
   * Subscribes to the Host telling the renderer it no longer holds the events the renderer
   * missed for `paneId` while disconnected. The listener should reload that pane's history with
   * `getPaneHistory` and replace the history it holds.
   */
  onHistoryReloadRequested(listener: (paneId: string) => void): () => void
  onMessageAppended(listener: (event: PaneMessageAppended) => void): () => void
  onWorkspaceChanged(listener: (event: WorkspaceChanged) => void): () => void
  onAgentSummaryChanged(listener: (event: AgentSummaryChanged) => void): () => void
  onAgentSummariesReplaced(listener: (event: AgentSummariesReplaced) => void): () => void
  onPaneCreateFailed(listener: (event: PaneCreateFailed) => void): () => void
  onAttentionChanged(listener: (event: PaneAttentionChanged) => void): () => void
  onPermissionRequested(listener: (event: PanePermissionRequested) => void): () => void
  onQuestionRequested(listener: (event: PaneQuestionRequested) => void): () => void
  onPlanReviewRequested(listener: (event: PanePlanReviewRequested) => void): () => void
  onSlashCommandsWarming(listener: (event: PaneSlashCommandsWarming) => void): () => void
  onSlashCommandsAvailable(listener: (event: PaneSlashCommandsAvailable) => void): () => void
  onConversationCompacted(listener: (event: PaneConversationCompacted) => void): () => void
  onConversationReset(listener: (event: PaneConversationReset) => void): () => void
  onCheckpointAvailable(listener: (event: PaneCheckpointAvailable) => void): () => void
  onRewoundToCheckpoint(listener: (event: PaneRewoundToCheckpoint) => void): () => void
  onMessageQueueChanged(listener: (event: PaneMessageQueueChanged) => void): () => void
  onUserMessagesSent(listener: (event: PaneUserMessagesSent) => void): () => void
  onAssistantTextDelta(listener: (event: PaneAssistantTextDelta) => void): () => void
  onAssistantThinkingDelta(listener: (event: PaneAssistantThinkingDelta) => void): () => void
  onToolCallStarted(listener: (event: PaneToolCallStarted) => void): () => void
  onToolCallCompleted(listener: (event: PaneToolCallCompleted) => void): () => void
}
