import { Schema } from 'effect'
import { AdapterStatusSnapshot } from '../domain/adapter-status'
import { AgentEvent } from '../domain/agent-event'
import { AgentSummary } from '../domain/agent-summary'
import { AttachedSession } from '../domain/attached-session'
import { Attachment, type AttachmentType, type ProjectEntry } from '../domain/attachment'
import {
  AttentionState,
  PermissionResponse,
  PermissionUpdate,
  Question,
  QuestionResponse
} from '../domain/attention'
import type { ActivityInfo, ActivityNotFound } from '../domain/background-activity'
import { BackgroundTask } from '../domain/background-task'
import { CompactionFailure, ContextUsage } from '../domain/context-usage'
import { JsonRecord } from '../domain/json-record'
import { MessageQueueSnapshot, OutgoingMessage, SendMode } from '../domain/message-queue'
import type { MetaRepoPushResult, MetaRepoStateResult } from '../domain/meta-repo'
import { ModelCatalogSnapshot } from '../domain/model'
import {
  type AgentDefaults,
  type LastVisibleModel,
  type ModelPreference,
  ModelPreferencesSnapshot
} from '../domain/model-preferences'
import { PermissionMode, ThinkingLevel } from '../domain/pane'
import type { PaneChatSnapshot } from '../domain/pane-chat'
import type { UsageLimitResume } from '../domain/parking'
import type { RegisterProjectRefusal } from '../domain/project'
import { AgentName, CreateTabRequest, ProjectId, Workspace } from '../domain/project'
import type { RemovalProgress } from '../domain/project-removal'
import { RewindFailureCause } from '../domain/rewind'
import { SlashCommandInfo } from '../domain/slash-command'
import { SetupStep } from '../domain/tab-setup'
import type { ThemePreference } from '../domain/theme'
import { TranscriptWidth } from '../domain/transcript-width'
import { UpdateStatus } from '../domain/update'
import { Uuid } from '../domain/uuid'
import type { ImportResolution, UnreadableRow, WorkspaceProblem } from '../domain/workspace-problem'
import { type PluginInfo, PluginName, type PluginOverrideResult } from '../plugin/manifest'
import type { PluginCallError, PluginSubscriptionEnd } from '../plugin/messages'
import type { PaneEventFrame } from './rpc'

/**
 * Electron IPC channel names shared by main, preload, and renderer. Only window duties travel
 * over Electron IPC; every pane and workspace operation goes to the Host over its WebSocket
 * (see `DiaRpcs`). `event` carries updater status pushed from main; `getHostConnection` returns
 * the Host's {@link HostConnection}; `chooseDirectory` and `chooseFile` open the native directory
 * or file picker given a default path; `setTitleBarOverlay` recolours the native window-control glyphs when the
 * theme changes; `getAppVersion`/`getUpdateStatus`/`checkForUpdates`/`installUpdate` read the
 * running version and drive the self-updater; `toggleDevTools` opens or closes the renderer's
 * DevTools (dia's custom title bar has no native menu to do so); `revealPath` shows a directory
 * in the system file manager.
 */
export const CHANNEL = {
  event: 'dia:event',
  getHostConnection: 'dia:getHostConnection',
  chooseDirectory: 'dia:chooseDirectory',
  chooseFile: 'dia:chooseFile',
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
 * What the renderer pushes to the main process (over `setTitleBarOverlay`) so the OS-drawn
 * window-control glyphs match the active theme. The renderer sends only `symbolColor`, a CSS colour
 * string the platform title-bar overlay accepts (hex/rgb, not `oklch`); main fixes the overlay
 * background as transparent so the app draws beneath the controls.
 */
export const TitleBarOverlayColors = Schema.Struct({
  symbolColor: Schema.String
})
export type TitleBarOverlayColors = typeof TitleBarOverlayColors.Type

/**
 * Command sent by the renderer to submit a user prompt to the pane identified
 * by `paneId`. Consumed by the pane
 * supervisor to forward `text` into that pane's agent session. `mode` decides
 * what happens while a turn runs: `queue` holds the message until the turn
 * ends, `steer` interrupts the turn so the message runs next. `attachments`
 * travel with the text; absent means none.
 */
export const SendMessage = Schema.TaggedStruct('SendMessage', {
  paneId: Uuid,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(Attachment)),
  mode: SendMode
})
export type SendMessage = typeof SendMessage.Type

/**
 * Command sent by the renderer to replace the text of queued message
 * `messageId` in pane `paneId`, and its attachments when `attachments` is
 * present. A message already sent is left alone.
 */
export const EditQueuedMessage = Schema.TaggedStruct('EditQueuedMessage', {
  paneId: Uuid,
  messageId: Schema.String,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(Attachment))
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
 * Command sent by the renderer to send queued message `messageId` in pane `paneId` now instead of
 * after the running turn: it interrupts the turn and runs next, and the rest of the queue keeps
 * waiting. With no turn running it is sent alone. A message already sent is left alone.
 */
export const SendQueuedMessageNow = Schema.TaggedStruct('SendQueuedMessageNow', {
  paneId: Uuid,
  messageId: Schema.String
})
export type SendQueuedMessageNow = typeof SendQueuedMessageNow.Type

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
 * Command sent by the renderer to make the turns of pane `paneId` use `model` from its next turn,
 * persisted on the pane's `PaneConfig`. A running turn finishes on its model.
 */
export const SetModel = Schema.TaggedStruct('SetModel', {
  paneId: Uuid,
  model: Schema.NonEmptyString
})
export type SetModel = typeof SetModel.Type

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
 * Command sent by the renderer to resume the parked agent in pane `paneId`: the agent gets
 * `continue` ahead of any messages held while it was parked. A pane that is not parked ignores it.
 */
export const ResumeParkedAgent = Schema.TaggedStruct('ResumeParkedAgent', {
  paneId: Uuid
})
export type ResumeParkedAgent = typeof ResumeParkedAgent.Type

/**
 * Command sent by the renderer to rewind pane `paneId` to a prior checkpoint:
 * `messageUuid` is a user turn's `checkpointUuid`, and `resumeAnchorUuid` (from the same turn)
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
 * Event pushed to the renderer with one stored event of pane `paneId`'s conversation: a message
 * or extended-thinking span created, grown or finalised (each update carries the whole text so
 * far, at most one per 50 ms while it streams), a tool call started or completed, or a lifecycle
 * event. Fold it into the pane's chat state by item id.
 */
export const PaneAgentEvent = Schema.TaggedStruct('PaneAgentEvent', {
  paneId: Uuid,
  agentEvent: AgentEvent
})
export type PaneAgentEvent = typeof PaneAgentEvent.Type

/**
 * Event pushed to the renderer with news about tool call `toolCallId` in pane
 * `paneId`: `input` once it has streamed in (before the call runs), `elapsedSeconds` while it runs, and `detail` for a line to show on
 * its row (a subagent's progress, or why it was denied or failed). An absent
 * field leaves the row's value unchanged.
 */
export const PaneToolCallUpdated = Schema.TaggedStruct('PaneToolCallUpdated', {
  paneId: Uuid,
  toolCallId: Schema.String,
  input: Schema.optional(JsonRecord),
  elapsedSeconds: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String)
})
export type PaneToolCallUpdated = typeof PaneToolCallUpdated.Type

/**
 * Event pushed to the renderer when the current turn in pane `paneId` enters a
 * state its activity line should name (retrying the API, compacting, thinking),
 * with `label` as the text. `label` null ends the state, and arrives before the
 * turn's next output or its end.
 */
export const PaneTurnStatusChanged = Schema.TaggedStruct('PaneTurnStatusChanged', {
  paneId: Uuid,
  label: Schema.NullOr(Schema.String)
})
export type PaneTurnStatusChanged = typeof PaneTurnStatusChanged.Type

/**
 * Event pushed to the renderer with a one-line `text` the transcript of pane
 * `paneId` should record as a notice (a model fallback, a usage-limit warning,
 * a message from Claude Code itself).
 */
export const PaneSessionNotice = Schema.TaggedStruct('PaneSessionNotice', {
  paneId: Uuid,
  text: Schema.String
})
export type PaneSessionNotice = typeof PaneSessionNotice.Type

/**
 * Event pushed to the renderer while worktree tab `paneId` is being created or resumed, and when
 * one of its setup steps changes afterwards. `steps` is the whole list, in order; replace any
 * earlier list with it.
 */
export const PaneSetupProgress = Schema.TaggedStruct('PaneSetupProgress', {
  paneId: Uuid,
  steps: Schema.Array(SetupStep)
})
export type PaneSetupProgress = typeof PaneSetupProgress.Type

/**
 * Event pushed to the renderer when the set of work running outside the turns of pane `paneId`
 * changes. `tasks` is the full set, in the order the session reported it, and is empty when none
 * runs.
 */
export const PaneBackgroundTasksChanged = Schema.TaggedStruct('PaneBackgroundTasksChanged', {
  paneId: Uuid,
  tasks: Schema.Array(BackgroundTask)
})
export type PaneBackgroundTasksChanged = typeof PaneBackgroundTasksChanged.Type

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
 * Event pushed to the renderer when a {@link RewindToCheckpoint} for `messageUuid` in pane
 * `paneId` did not complete. The displayed transcript stays as it is; show `cause`, and `detail`
 * when present (the Agent SDK's own explanation), to the user.
 */
export const PaneRewindFailed = Schema.TaggedStruct('PaneRewindFailed', {
  paneId: Uuid,
  messageUuid: Schema.String,
  cause: RewindFailureCause,
  detail: Schema.optional(Schema.String)
})
/** A {@link PaneRewindFailed} event value. */
export type PaneRewindFailed = typeof PaneRewindFailed.Type

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
 * Event pushed to the renderer when pane `paneId`'s next turn is the first to use `model`, before
 * that turn's `PaneUserMessagesSent`. The renderer marks the switch in the transcript.
 */
export const PaneModelChanged = Schema.TaggedStruct('PaneModelChanged', {
  paneId: Uuid,
  model: Schema.NonEmptyString
})
export type PaneModelChanged = typeof PaneModelChanged.Type

/**
 * Event pushed to the renderer with a new reading of how full pane `paneId`'s context window is.
 * `usage` replaces the reading the renderer holds.
 */
export const PaneContextUsageChanged = Schema.TaggedStruct('PaneContextUsageChanged', {
  paneId: Uuid,
  usage: ContextUsage
})
/** A {@link PaneContextUsageChanged} event. */
export type PaneContextUsageChanged = typeof PaneContextUsageChanged.Type

/**
 * Event pushed to the renderer when a compaction requested in pane `paneId` did not run. `failure`
 * says why and carries the text to show.
 */
export const PaneCompactionFailed = Schema.TaggedStruct('PaneCompactionFailed', {
  paneId: Uuid,
  failure: CompactionFailure
})
/** A {@link PaneCompactionFailed} event. */
export type PaneCompactionFailed = typeof PaneCompactionFailed.Type

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
 * Event pushed to the renderer whenever a plugin attaches or detaches a session (ADR-0070).
 * `sessions` is every attached session and replaces the renderer's list. Never replayed.
 */
export const AttachedSessionsChanged = Schema.TaggedStruct('AttachedSessionsChanged', {
  sessions: Schema.Array(AttachedSession)
})
export type AttachedSessionsChanged = typeof AttachedSessionsChanged.Type

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

/**
 * Event pushed to the renderer whenever a background activity is registered, removed, or changes
 * state. It carries no state: read the current list with `window.dia.activities.list`. Never
 * replayed; the preload raises it itself after a reconnect so listeners re-read the list.
 */
export const ActivitiesChanged = Schema.TaggedStruct('ActivitiesChanged', {})
export type ActivitiesChanged = typeof ActivitiesChanged.Type

/**
 * Event pushed to the renderer whenever the model list changes; `snapshot` is the full current
 * list state. Never replayed; the preload raises it itself after a reconnect with the state read
 * from `GetModels`. Keep the snapshot with the highest `revision`.
 */
export const ModelsChanged = Schema.TaggedStruct('ModelsChanged', {
  snapshot: ModelCatalogSnapshot
})
export type ModelsChanged = typeof ModelsChanged.Type

/**
 * Event pushed to the renderer whenever the agent adapter's install status changes. Never
 * replayed; the preload raises it itself after a reconnect. Keep the snapshot with the highest
 * `revision`.
 */
export const AdapterStatusChanged = Schema.TaggedStruct('AdapterStatusChanged', {
  snapshot: AdapterStatusSnapshot
})
export type AdapterStatusChanged = typeof AdapterStatusChanged.Type

/**
 * Event pushed to the renderer whenever the adapter's model preferences or defaults change.
 * Never replayed; the preload raises it itself after a reconnect. Keep the snapshot with the
 * highest `revision`.
 */
export const ModelPreferencesChanged = Schema.TaggedStruct('ModelPreferencesChanged', {
  snapshot: ModelPreferencesSnapshot
})
export type ModelPreferencesChanged = typeof ModelPreferencesChanged.Type

// Additional events (PaneClosed) join this union in later bullets.
/**
 * Every pane event other than {@link PaneAgentEvent}: the events that carry a `paneId` and
 * describe the pane's session rather than its conversation items. The Host stores each one in the
 * pane's event stream and sends it to the renderer unchanged.
 */
export const PaneSignal = Schema.Union([
  PaneToolCallUpdated,
  PaneTurnStatusChanged,
  PaneSessionNotice,
  PaneSetupProgress,
  PaneBackgroundTasksChanged,
  PanePermissionRequested,
  PaneQuestionRequested,
  PanePlanReviewRequested,
  PaneSlashCommandsWarming,
  PaneSlashCommandsAvailable,
  PaneConversationCompacted,
  PaneConversationReset,
  PaneRewoundToCheckpoint,
  PaneRewindFailed,
  PaneMessageQueueChanged,
  PaneUserMessagesSent,
  PaneModelChanged,
  PaneContextUsageChanged,
  PaneCompactionFailed,
  PaneAttentionChanged,
  PaneCreateFailed
])
export type PaneSignal = typeof PaneSignal.Type

/**
 * Union of every event pushed to the renderer, by the Host's event stream or
 * by main for updater status. Renderer handlers should match on the `_tag` field to
 * dispatch.
 */
export const IpcEvent = Schema.Union([
  PaneAgentEvent,
  ...PaneSignal.members,
  WorkspaceChanged,
  AttachedSessionsChanged,
  AgentSummaryChanged,
  AgentSummariesReplaced,
  PluginStatusChanged,
  ActivitiesChanged,
  ModelsChanged,
  AdapterStatusChanged,
  ModelPreferencesChanged,
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
  /**
   * Runs the handler plugin `plugin`'s `host` entry serves for `tag` with `payload`, a value
   * encoded with the call's payload schema. Resolves the encoded result, or the failure as plain
   * data; a renderer plugin calls it through `callHost`, never directly.
   */
  call(plugin: string, tag: string, payload: unknown): Promise<PluginCallResultJson>
  /**
   * Follows the streaming call plugin `plugin`'s `host` entry serves for `tag` with `payload`, a
   * value encoded with the call's payload schema. `onValue` receives each encoded value,
   * starting with the current state. `onEnd` receives how the stream ended: a failure as plain
   * data, or completion. After a lost Host connection the subscription starts again by itself
   * and `onEnd` is not called. A renderer plugin follows a call through `followHost`, never
   * directly. Returns a function that ends the subscription.
   */
  subscribe(
    plugin: string,
    tag: string,
    payload: unknown,
    onValue: (value: unknown) => void,
    onEnd: (end: PluginSubscriptionEndJson) => void
  ): () => void
}

/** A `PluginSubscriptionEnd` as plain data, as `window.dia.plugins.subscribe` delivers it to `onEnd`. */
export type PluginSubscriptionEndJson = typeof PluginSubscriptionEnd.Encoded

/** The outcome of `window.dia.plugins.call`, as plain data. */
export type PluginCallResultJson =
  | { readonly _tag: 'Success'; readonly value: unknown }
  | { readonly _tag: 'Failure'; readonly error: typeof PluginCallError.Encoded }

/** A {@link ModelCatalogSnapshot} as plain data, with dates as ISO strings, as `window.dia.models` delivers it. */
export type ModelCatalogSnapshotJson = typeof ModelCatalogSnapshot.Encoded

/** An `ActivityInfo` as plain data, with dates as ISO strings, as `window.dia.activities` delivers it. */
export type ActivityInfoJson = typeof ActivityInfo.Encoded

/** An `ActivityNotFound` refusal as plain data, as `window.dia.activities.run` resolves it. */
export type ActivityNotFoundJson = typeof ActivityNotFound.Encoded

/** The model list calls of `window.dia.models`, served by the Host. */
export interface ModelApi {
  /** The current model list. Keep it only if its `revision` is higher than the one you hold. */
  get(): Promise<ModelCatalogSnapshotJson>
  /** Re-reads the model list from the agent; resolves when the read ends, whatever its outcome, which arrives through `onChanged`. */
  refresh(): Promise<void>
  /**
   * Subscribes to model list changes, including the state read again after a reconnect. Subscribe
   * before calling `get`, and keep the snapshot with the highest `revision`. Returns a function
   * that stops listening.
   */
  onChanged(listener: (snapshot: ModelCatalogSnapshotJson) => void): () => void
}

/** An {@link AdapterStatusSnapshot} as plain data, with dates as ISO strings, as `window.dia.adapter` delivers it. */
export type AdapterStatusSnapshotJson = typeof AdapterStatusSnapshot.Encoded

/** A `LastVisibleModel` refusal as plain data, as `window.dia.adapter.setModelPreference` resolves it. */
export type LastVisibleModelJson = typeof LastVisibleModel.Encoded

/** The agent adapter calls of `window.dia.adapter`, served by the Host. */
export interface AdapterApi {
  /** The adapter's current install status. Keep it only if its `revision` is higher than the one you hold. */
  getStatus(): Promise<AdapterStatusSnapshotJson>
  /** Re-checks the install; resolves when the check ends, whose outcome arrives through `onStatusChanged`. */
  checkHealth(): Promise<void>
  /** Sets where the adapter finds its install, or clears it with `null`, then re-checks. Sessions started afterwards use it. */
  setInstallPath(path: string | null): Promise<void>
  /** Subscribes to install status changes, including after a reconnect. Subscribe before calling `getStatus`. Returns a function that stops listening. */
  onStatusChanged(listener: (snapshot: AdapterStatusSnapshotJson) => void): () => void
  /** The adapter's model preferences and defaults. Keep them only if their `revision` is higher than the one you hold. */
  getPreferences(): Promise<ModelPreferencesSnapshot>
  /** Marks `model` favourite or hidden, or clears it with `null`. Resolves `null` once applied, or the refusal when hiding would leave no model visible. */
  setModelPreference(
    model: string,
    preference: ModelPreference | null
  ): Promise<LastVisibleModelJson | null>
  /** Replaces the defaults new agents start with. */
  setDefaults(defaults: AgentDefaults): Promise<void>
  /** Subscribes to preference changes, including after a reconnect. Subscribe before calling `getPreferences`. Returns a function that stops listening. */
  onPreferencesChanged(listener: (snapshot: ModelPreferencesSnapshot) => void): () => void
  /** The permission modes the adapter's own settings turn off for an agent working in `cwd`; read it again to see a settings change. */
  getDisabledPermissionModes(cwd: string): Promise<ReadonlyArray<PermissionMode>>
  /** The file types the adapter accepts as content blocks; any other attached file is sent as its path. */
  getAttachmentTypes(): Promise<ReadonlyArray<AttachmentType>>
}

/** The background activity calls of `window.dia.activities`, served by the Host. */
export interface ActivityApi {
  /** Every registered background activity of every loaded plugin. */
  list(): Promise<ReadonlyArray<ActivityInfoJson>>
  /**
   * Runs activity `id` of `plugin` now, or waits for its run in progress. Resolves `null` when the
   * run has ended, or the refusal when no loaded plugin registered that activity.
   */
  run(plugin: string, id: string): Promise<ActivityNotFoundJson | null>
  /**
   * Subscribes to activity changes (registered, removed, started, finished), including after a
   * reconnect. The listener receives nothing; call `list` for the new state. Returns a function
   * that stops listening.
   */
  onChanged(listener: () => void): () => void
}

/** The meta repo push calls of `window.dia.metaRepo`, served by the Host. None of them rejects except on a lost connection. */
export interface MetaRepoApi {
  /** The meta repo's remote and branch, or why they cannot be read. */
  getState(): Promise<MetaRepoStateResult>
  /** Sets the meta repo's remote to `url` and resolves the new state, or why it was not set. */
  setRemote(url: string): Promise<MetaRepoStateResult>
  /** Scans the commits the remote does not have and pushes the current branch when they hold no secret; resolves the outcome. */
  push(): Promise<MetaRepoPushResult>
}

/**
 * The workspace problem calls of `window.dia.workspaceProblems`, served by the Host: stored rows
 * the Host could not load, and tabs the legacy workspace import skipped. They reject only on a
 * lost connection.
 */
export interface WorkspaceProblemsApi {
  /** Every open problem; empty when the Host could not read them (the failure is logged). */
  list(): Promise<ReadonlyArray<WorkspaceProblem>>
  /** Deletes an unreadable stored row. Resolves `null` once done, else the reason it failed. */
  deleteRow(row: UnreadableRow): Promise<string | null>
  /**
   * Imports or discards the skipped import tab `agentId`, for good. Resolves `null` once done,
   * else the reason it failed.
   */
  resolveImportConflict(agentId: string, resolution: ImportResolution): Promise<string | null>
}

/**
 * Shape of the `window.dia` bridge the preload script exposes to the renderer.
 * The single source of truth for that surface: preload's implementation is
 * checked against this interface, and the renderer's ambient `Window.dia`
 * declaration imports it directly, so the two can't drift apart.
 */
export interface DiaApi {
  readonly plugins: PluginApi
  readonly models: ModelApi
  readonly activities: ActivityApi
  readonly adapter: AdapterApi
  readonly metaRepo: MetaRepoApi
  readonly workspaceProblems: WorkspaceProblemsApi
  sendMessage(
    paneId: string,
    text: string,
    mode: SendMode,
    attachments?: ReadonlyArray<Attachment>
  ): void
  /** Replaces queued message `messageId`'s text, and its attachments when `attachments` is given. */
  editQueuedMessage(
    paneId: string,
    messageId: string,
    text: string,
    attachments?: ReadonlyArray<Attachment>
  ): void
  /** The files and directories under `cwd` the `@` path menu offers; empty when they cannot be read. */
  listProjectEntries(cwd: string): Promise<ReadonlyArray<ProjectEntry>>
  /** The absolute path of a `File` from a drop, paste or file input; empty for a file with no path, such as a pasted screenshot. */
  pathForFile(file: object): string
  removeQueuedMessage(paneId: string, messageId: string): void
  /** Sends queued message `messageId` now, steering the running turn; see {@link SendQueuedMessageNow}. */
  sendQueuedMessageNow(paneId: string, messageId: string): void
  resolvePermission(paneId: string, requestId: string, response: PermissionResponse): void
  resolveQuestion(paneId: string, requestId: string, response: QuestionResponse): void
  setThinkingLevel(paneId: string, level: ThinkingLevel): void
  setPermissionMode(paneId: string, mode: PermissionMode): void
  setModel(paneId: string, model: string): void
  resolvePlanReview(paneId: string, requestId: string, approved: boolean): void
  interrupt(paneId: string): void
  /** Resumes the parked agent in pane `paneId`; does nothing when it is not parked. */
  resumeParkedAgent(paneId: string): void
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
  /**
   * Archives tab `paneId`: stops its agent and removes its worktree; its branch and transcripts
   * stay. Resolves `null` once archived, also when the tab is already gone, or the reason the
   * worktree could not be removed, in which case the tab is left unarchived.
   */
  archiveTab(paneId: string): Promise<string | null>
  /**
   * Deletes tab `paneId`: stops its agent, removes its worktree and dia's records of it; its
   * branch and transcripts stay. Resolves as {@link DiaApi.archiveTab} does.
   */
  deleteTab(paneId: string): Promise<string | null>
  /**
   * Unarchives tab `paneId`: restores its worktree from its kept branch and marks it not
   * archived; starts no session. Resolves `null` once unarchived, also when the tab is already
   * gone or not archived, or the reason its working directory could not be restored, in which
   * case the tab stays archived.
   */
  unarchiveTab(paneId: string): Promise<string | null>
  selectTab(paneId: string | null): void
  getAgentSummaries(): Promise<ReadonlyArray<AgentSummary>>
  /** Every session a plugin has attached (ADR-0070). */
  getAttachedSessions(): Promise<ReadonlyArray<AttachedSession>>
  getTranscriptWidth(): Promise<TranscriptWidth>
  setTranscriptWidth(width: TranscriptWidth): void
  /** Shows `directory` in the system file manager; does nothing when it is not a directory. */
  revealPath(directory: string): Promise<void>
  /**
   * The Host's chat state for pane `paneId` and the sequence number of the last event in it.
   * Fold only events from {@link DiaApi.onPaneEvent} with a higher `seq` onto it.
   */
  getPaneChat(paneId: string): Promise<PaneChatSnapshot>
  /** Opens the native folder picker and resolves the chosen path, or `null` when the user cancels. */
  pickDirectory(): Promise<string | null>
  /** Opens the native file picker and resolves the chosen path, or `null` when the user cancels. */
  pickFile(): Promise<string | null>
  getTheme(): Promise<ThemePreference>
  setTheme(theme: ThemePreference): Promise<void>
  getSendMode(): Promise<SendMode>
  setSendMode(mode: SendMode): Promise<void>
  /** What dia does when a usage limit resets: `automatic` sends `continue` itself, `manual` waits for the user. */
  getUsageLimitResume(): Promise<UsageLimitResume>
  /** Stores what dia does when a usage limit resets and applies it to every parked agent. */
  setUsageLimitResume(mode: UsageLimitResume): Promise<void>
  setTitleBarOverlay(colors: TitleBarOverlayColors): void
  getAppVersion(): Promise<string>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): void
  installUpdate(): void
  toggleDevTools(): void
  onUpdateStatusChanged(listener: (event: UpdateStatusChanged) => void): () => void
  /**
   * Subscribes to the Host telling the renderer it no longer holds the events the renderer
   * missed for `paneId` while disconnected. The listener should read the pane's state again with
   * `getPaneChat` and replace the state it holds.
   */
  onHistoryReloadRequested(listener: (paneId: string) => void): () => void
  /** Subscribes to every pane event with its pane's sequence number. */
  onPaneEvent(listener: (frame: PaneEventFrame) => void): () => void
  onWorkspaceChanged(listener: (event: WorkspaceChanged) => void): () => void
  onAttachedSessionsChanged(listener: (event: AttachedSessionsChanged) => void): () => void
  onAgentSummaryChanged(listener: (event: AgentSummaryChanged) => void): () => void
  onAgentSummariesReplaced(listener: (event: AgentSummariesReplaced) => void): () => void
  onPaneCreateFailed(listener: (event: PaneCreateFailed) => void): () => void
  onAttentionChanged(listener: (event: PaneAttentionChanged) => void): () => void
  onRewoundToCheckpoint(listener: (event: PaneRewoundToCheckpoint) => void): () => void
  onRewindFailed(listener: (event: PaneRewindFailed) => void): () => void
}
