import {
  type AdapterStatus,
  type AgentEvents,
  type AttachmentType,
  type ContentAttachment,
  type ConversationMessage,
  type DiaTool,
  type DiscoveredSession,
  HealthError,
  type MessageQueueSnapshot,
  type ModelCatalogState,
  ModelsUnavailable,
  type OutboundMessage,
  type PaneConfig,
  type PathAttachment,
  type PermissionMode,
  type PermissionResponse,
  type QuestionResponse,
  type SendMode,
  ServiceKey,
  type SessionAdditions,
  SessionId,
  type SessionToolOptions,
  type ThinkingLevel
} from '@dia/plugin'
import { DateTime, Effect, Option, Predicate, Schema, type Scope, Stream } from 'effect'

type Attachment = ContentAttachment | PathAttachment

/** The session ended for a reason other than a missing conversation; `reason` describes it for the user. */
export const SessionFailed = Schema.TaggedStruct('SessionFailed', { reason: Schema.String })

/** The session ended because the conversation it was asked to resume, `sessionId`, no longer exists. */
export const SessionNotFound = Schema.TaggedStruct('SessionNotFound', { sessionId: SessionId })

/** Why an agent session ended on its own, as {@link AgentSession.ended} reports it; match on `_tag`. */
export const SessionEnd = Schema.Union([SessionFailed, SessionNotFound])
export type SessionEnd = typeof SessionEnd.Type

const BACKEND_KEY_NAME = 'agentBackend'

/**
 * Live control surface of one pane's agent session, returned by {@link AgentBackend.openSession}.
 * Every method returns once the command has been applied to the session; none waits for the
 * agent's reply, which arrives through the `emit` callback given when the session opened.
 */
export interface AgentSession {
  /**
   * Sends a user message of `text` and `attachments` (none when omitted). With no turn running it
   * is sent at once in either mode; during a turn `queue` holds it until the turn ends and `steer`
   * interrupts the turn so it runs next. A path attachment outside the session's working directory
   * becomes readable by the agent.
   */
  readonly sendText: (
    text: string,
    mode: SendMode,
    attachments?: ReadonlyArray<Attachment>
  ) => Effect.Effect<void>
  /**
   * Replaces the text of queued message `messageId`, and its attachments when `attachments` is
   * given; a message already sent is left alone.
   */
  readonly editQueuedText: (
    messageId: string,
    text: string,
    attachments?: ReadonlyArray<Attachment>
  ) => Effect.Effect<void>
  /** Removes queued message `messageId`; a message already sent is left alone. */
  readonly removeQueuedText: (messageId: string) => Effect.Effect<void>
  /**
   * Sends queued message `messageId` now: during a turn it interrupts the turn and runs next, and
   * the rest of the queue keeps waiting. A message already sent is left alone.
   */
  readonly sendQueuedNow: (messageId: string) => Effect.Effect<void>
  /** The messages waiting to be sent, in send order. */
  readonly messageQueue: Effect.Effect<MessageQueueSnapshot>
  readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void>
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>
  /**
   * Makes the turns dispatched from now on use `model`; a running turn finishes on its model.
   * Choosing the model in use does nothing. The first turn on a new model is preceded by a
   * `ModelChanged` event.
   */
  readonly setModel: (model: string) => Effect.Effect<void>
  readonly resolvePermission: (
    requestId: string,
    response: PermissionResponse
  ) => Effect.Effect<void>
  readonly resolveQuestion: (requestId: string, response: QuestionResponse) => Effect.Effect<void>
  readonly resolvePlanReview: (requestId: string, approved: boolean) => Effect.Effect<void>
  readonly interrupt: () => Effect.Effect<void>
  readonly rewindToCheckpoint: (
    messageUuid: string,
    resumeAnchorUuid: string | undefined
  ) => Effect.Effect<void>
  /**
   * Sends `continue` to a session whose last turn was parked (`TurnParked`), ahead of any held
   * queue; the held messages run after it, in order. Does nothing while a turn is running.
   */
  readonly resume: Effect.Effect<void>
  /**
   * Completes with why the session ended on its own: `SessionNotFound` when the conversation it
   * resumes does not exist, `SessionFailed` for any other end. Does not complete because of a
   * restart or rewind the session performs itself; it completes if the conversation that restart
   * resumes does not exist. Does not complete when the scope it was opened in is closed.
   */
  readonly ended: Effect.Effect<SessionEnd>
}

/**
 * One event read from a session's transcript, as {@link AgentBackend.readTranscriptAfter} returns
 * it. `sourceUuid` is the uuid of the transcript entry the event came from. Pass it to
 * `RunEvents.append` unchanged.
 */
export interface TranscriptEntry {
  readonly event: AgentEvents.AgentEvent
  readonly sourceUuid: string
}

/**
 * The size (`fileSize`, bytes) and modification time (`mtimeMs`, epoch milliseconds) of a
 * session's transcript file, as {@link AgentBackend.transcriptInfo} returns them. Compare them with
 * a stored cursor to tell whether the transcript changed since it was last read.
 */
export interface TranscriptInfo {
  readonly fileSize: number
  readonly mtimeMs: number
}

/**
 * The events of a session's transcript after a cursor, as {@link AgentBackend.readTranscriptAfter}
 * returns them, in transcript order. `fileSize` and `mtimeMs` describe the transcript file as it
 * was before the events were read, so a file that grew during the read differs from them at the
 * next comparison.
 */
export interface TranscriptTail extends TranscriptInfo {
  readonly entries: ReadonlyArray<TranscriptEntry>
}

/**
 * What a session opens with. `config` chooses the working directory, model and modes; `resume`
 * names the conversation to continue, or is none for a new one; `emit` receives every event the
 * session produces, in order; `diaTools` are the dia tools offered to the agent, whose calls follow
 * the session's permission rules and mode; `tools` are the permission rules and MCP servers of the hired agent's job title,
 * or none for an ad-hoc tab. The {@link SessionAdditions} and `tools` apply for the session's whole
 * life, including every restart it performs itself.
 */
export interface AgentSessionOptions extends SessionAdditions {
  readonly config: PaneConfig
  readonly resume: Option.Option<SessionId>
  readonly emit: (message: OutboundMessage) => Effect.Effect<void>
  readonly diaTools: ReadonlyArray<DiaTool>
  readonly tools: Option.Option<SessionToolOptions>
}

/**
 * The agent dia drives, as the adapter plugin provides it under {@link AgentBackendKey}.
 * `openSession` starts one pane's session; the session and every process it starts live in the
 * surrounding scope, and closing that scope ends them. `readHistory` reads a past conversation
 * without starting a session and returns an empty list when it cannot be read. `models` streams
 * the models a new session can use, starting with the current state; `refreshModels` re-reads
 * that list from the agent and completes when the read ends, whatever its outcome, which arrives
 * through `models`.
 * `status` streams whether the agent install works, starting with the current status;
 * `checkHealth` re-checks it and completes when the check ends; `setInstallPath` stores (`Some`)
 * or clears (`None`) where the adapter finds its agent install, then re-checks, and sessions
 * started afterwards use it. `disabledPermissionModes` lists the permission modes the agent's own
 * settings turn off for a session started in `cwd`; it is empty when the settings cannot be read.
 * `attachmentTypes` lists the file types a session accepts as content blocks; any other attached
 * file is sent as its path. `discoverSessions` is optional: an adapter without it imports nothing
 * when a project is added. `transcriptInfo` and `readTranscriptAfter` read a session's transcript
 * without starting a session; see their own documentation.
 */
export interface AgentBackend {
  readonly openSession: (
    options: AgentSessionOptions
  ) => Effect.Effect<AgentSession, never, Scope.Scope>
  readonly readHistory: (
    sessionId: SessionId,
    cwd: string
  ) => Effect.Effect<ReadonlyArray<ConversationMessage>>
  /**
   * The size and modification time of session `sessionId`'s transcript under `cwd`, without
   * reading its entries. None, logged, when there is no readable transcript file. Never fails.
   */
  readonly transcriptInfo: (
    sessionId: SessionId,
    cwd: string
  ) => Effect.Effect<Option.Option<TranscriptInfo>>
  /**
   * The events of session `sessionId`'s transcript under `cwd` from the entries after `afterUuid`,
   * or from every entry when `afterUuid` is none or no longer in the transcript (an already stored
   * entry is skipped by the `dia-run-events` store's `appendTranscript`). None when the transcript cannot be
   * read; the caller then leaves its stored cursor unchanged. Never fails.
   */
  readonly readTranscriptAfter: (
    sessionId: SessionId,
    cwd: string,
    afterUuid: Option.Option<string>
  ) => Effect.Effect<Option.Option<TranscriptTail>>
  readonly models: () => Stream.Stream<ModelCatalogState>
  readonly refreshModels: () => Effect.Effect<void>
  readonly status: () => Stream.Stream<AdapterStatus>
  readonly checkHealth: () => Effect.Effect<void>
  readonly setInstallPath: (path: Option.Option<string>) => Effect.Effect<void>
  readonly disabledPermissionModes: (cwd: string) => Effect.Effect<ReadonlyArray<PermissionMode>>
  readonly attachmentTypes: () => Effect.Effect<ReadonlyArray<AttachmentType>>
  /**
   * The conversations the harness holds whose working directory is `directory`, in any order.
   * Never fails: empty when there are none or they cannot be read.
   */
  readonly discoverSessions?: (directory: string) => Effect.Effect<ReadonlyArray<DiscoveredSession>>
}

const ADAPTER_NOT_LOADED = 'The claude-code adapter is not loaded'

const ignored =
  (command: string) =>
  (..._args: ReadonlyArray<unknown>): Effect.Effect<void> =>
    Effect.logWarning('Ignored a command; the agent session never started', {
      command,
      reason: ADAPTER_NOT_LOADED
    })

const unavailableSession: AgentSession = {
  sendText: ignored('sendText'),
  editQueuedText: ignored('editQueuedText'),
  removeQueuedText: ignored('removeQueuedText'),
  sendQueuedNow: ignored('sendQueuedNow'),
  messageQueue: Effect.succeed({ queued: [], held: false }),
  setThinkingLevel: ignored('setThinkingLevel'),
  setPermissionMode: ignored('setPermissionMode'),
  setModel: ignored('setModel'),
  resolvePermission: ignored('resolvePermission'),
  resolveQuestion: ignored('resolveQuestion'),
  resolvePlanReview: ignored('resolvePlanReview'),
  interrupt: ignored('interrupt'),
  rewindToCheckpoint: ignored('rewindToCheckpoint'),
  resume: ignored('resume')(),
  ended: Effect.succeed(SessionFailed.make({ reason: ADAPTER_NOT_LOADED }))
}

/**
 * The backend to use while no adapter provides {@link AgentBackendKey}: its sessions end at once with
 * `The claude-code adapter is not loaded`, its `readHistory` returns an empty list, and its
 * `transcriptInfo` and `readTranscriptAfter` return none.
 */
export const unavailableBackend: AgentBackend = {
  openSession: (options) =>
    Effect.logError('Cannot start an agent session', {
      paneId: options.config.paneId,
      reason: ADAPTER_NOT_LOADED
    }).pipe(Effect.as(unavailableSession)),
  readHistory: (sessionId) =>
    Effect.logWarning('Cannot read a session transcript', {
      sessionId,
      reason: ADAPTER_NOT_LOADED
    }).pipe(Effect.as([])),
  transcriptInfo: (sessionId) =>
    Effect.logWarning('Cannot read a session transcript', {
      sessionId,
      reason: ADAPTER_NOT_LOADED
    }).pipe(Effect.as(Option.none())),
  readTranscriptAfter: (sessionId) =>
    Effect.logWarning('Cannot read a session transcript', {
      sessionId,
      reason: ADAPTER_NOT_LOADED
    }).pipe(Effect.as(Option.none())),
  models: () =>
    Stream.make(ModelsUnavailable.make({ message: ADAPTER_NOT_LOADED, refreshing: false })),
  refreshModels: ignored('refreshModels'),
  status: () =>
    Stream.fromEffect(
      DateTime.now.pipe(
        Effect.map(
          (checkedAt): AdapterStatus => ({
            health: HealthError.make({ message: ADAPTER_NOT_LOADED, checkedAt }),
            checking: false,
            installPathOverride: null
          })
        )
      )
    ),
  checkHealth: ignored('checkHealth'),
  setInstallPath: ignored('setInstallPath'),
  disabledPermissionModes: () => Effect.succeed([]),
  attachmentTypes: () => Effect.succeed([])
}

const backendMethods = [
  'openSession',
  'readHistory',
  'transcriptInfo',
  'readTranscriptAfter',
  'models',
  'refreshModels',
  'status',
  'checkHealth',
  'setInstallPath',
  'disabledPermissionModes',
  'attachmentTypes'
] as const

/**
 * Lists what keeps `provided`, a value read under {@link AgentBackendKey}, from being an
 * {@link AgentBackend}, one sentence per problem. Returns an empty list when it is one.
 */
export const agentBackendProblems = (provided: Option.Option<unknown>): ReadonlyArray<string> => {
  if (Option.isNone(provided)) return [`setup did not provide "${BACKEND_KEY_NAME}"`]
  const value = provided.value
  const methods =
    Predicate.hasProperty(value, 'discoverSessions') && value.discoverSessions !== undefined
      ? [...backendMethods, 'discoverSessions']
      : backendMethods
  return methods
    .filter(
      (method) => !(Predicate.hasProperty(value, method) && Predicate.isFunction(value[method]))
    )
    .map((method) => `"${BACKEND_KEY_NAME}.${method}" is not a function`)
}

const isAgentBackend = (value: unknown): value is AgentBackend =>
  agentBackendProblems(Option.some(value)).length === 0

/**
 * The key an adapter plugin provides its {@link AgentBackend} under. It reads as `AgentBackend` and
 * accepts a value {@link agentBackendProblems} finds no problem with; any other value reads as not
 * provided. Read it with `ctx.whenProvided`, so a reload of the adapter does not close the reader.
 */
export const AgentBackendKey = ServiceKey.make(BACKEND_KEY_NAME, isAgentBackend)
