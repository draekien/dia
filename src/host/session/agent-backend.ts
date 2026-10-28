import { type AdapterStatus, HealthError } from '@shared/domain/adapter-status'
import type { PermissionResponse, QuestionResponse } from '@shared/domain/attention'
import {
  EMPTY_MESSAGE_QUEUE,
  type MessageQueueSnapshot,
  type SendMode
} from '@shared/domain/message-queue'
import { type ModelCatalogState, ModelsUnavailable } from '@shared/domain/model'
import type {
  ConversationMessage,
  PaneConfig,
  PermissionMode,
  SessionId,
  ThinkingLevel
} from '@shared/domain/pane'
import type { AdapterContract, PluginRegistry } from '@shared/plugin/plugin-registry'
import { Data, DateTime, Effect, Option, Predicate, type Scope, Stream } from 'effect'
import type { DiaTool } from './dia-tools'
import type { OutboundMessage } from './protocol'

/** Service key under which the agent adapter plugin provides its {@link AgentBackend}. */
export const AGENT_BACKEND_KEY = 'agentBackend'

/**
 * Live control surface of one pane's agent session, returned by {@link AgentBackend.openSession}.
 * Every method returns once the command has been applied to the session; none waits for the
 * agent's reply, which arrives through the `emit` callback given when the session opened.
 */
export interface AgentSession {
  /**
   * Sends a user message. With no turn running it is sent at once in either mode; during a turn
   * `queue` holds it until the turn ends and `steer` interrupts the turn so it runs next.
   */
  readonly sendText: (text: string, mode: SendMode) => Effect.Effect<void>
  /** Replaces the text of queued message `messageId`; a message already sent is left alone. */
  readonly editQueuedText: (messageId: string, text: string) => Effect.Effect<void>
  /** Removes queued message `messageId`; a message already sent is left alone. */
  readonly removeQueuedText: (messageId: string) => Effect.Effect<void>
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
   * Completes with a description of why the session ended on its own: its event stream failed
   * or finished without the pane being closed. Never completes for a restart the session
   * performs itself (thinking-level change, rewind) or for closing the scope it was opened in.
   */
  readonly ended: Effect.Effect<string>
}

/**
 * What a session opens with. `config` chooses the working directory, model and modes; `resume`
 * names the conversation to continue, or is none for a new one; `emit` receives every event the
 * session produces, in order; `tools` are the dia tools offered to the agent, each asked about
 * before it runs.
 */
export interface AgentSessionOptions {
  readonly config: PaneConfig
  readonly resume: Option.Option<SessionId>
  readonly emit: (message: OutboundMessage) => Effect.Effect<void>
  readonly tools: ReadonlyArray<DiaTool>
}

/**
 * The agent dia drives, as the adapter plugin provides it under {@link AGENT_BACKEND_KEY}.
 * `openSession` starts one pane's session; the session and every process it starts live in the
 * surrounding scope, and closing that scope ends them. `readHistory` reads a past conversation
 * without starting a session and returns an empty list when it cannot be read. `deleteSession`
 * deletes a past conversation's transcript; it succeeds when the transcript does not exist, so
 * calling it again after a success or a failure is safe. `models` streams the models a new
 * session can use, starting with the current state; `refreshModels` re-reads that list from the
 * agent and completes when the read ends, whatever its outcome, which arrives through `models`.
 * `status` streams whether the agent install works, starting with the current status;
 * `checkHealth` re-checks it and completes when the check ends; `setInstallPath` stores (`Some`)
 * or clears (`None`) where the adapter finds its agent install, then re-checks, and sessions
 * started afterwards use it.
 */
export interface AgentBackend {
  readonly openSession: (
    options: AgentSessionOptions
  ) => Effect.Effect<AgentSession, never, Scope.Scope>
  readonly readHistory: (
    sessionId: SessionId,
    cwd: string
  ) => Effect.Effect<ReadonlyArray<ConversationMessage>>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, SessionDeleteError>
  readonly models: () => Stream.Stream<ModelCatalogState>
  readonly refreshModels: () => Effect.Effect<void>
  readonly status: () => Stream.Stream<AdapterStatus>
  readonly checkHealth: () => Effect.Effect<void>
  readonly setInstallPath: (path: Option.Option<string>) => Effect.Effect<void>
}

/** {@link AgentBackend.deleteSession} could not delete the transcript of `sessionId`; `reason` says why. */
export class SessionDeleteError extends Data.TaggedError('SessionDeleteError')<{
  readonly sessionId: SessionId
  readonly reason: string
}> {}

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
  messageQueue: Effect.succeed(EMPTY_MESSAGE_QUEUE),
  setThinkingLevel: ignored('setThinkingLevel'),
  setPermissionMode: ignored('setPermissionMode'),
  setModel: ignored('setModel'),
  resolvePermission: ignored('resolvePermission'),
  resolveQuestion: ignored('resolveQuestion'),
  resolvePlanReview: ignored('resolvePlanReview'),
  interrupt: ignored('interrupt'),
  rewindToCheckpoint: ignored('rewindToCheckpoint'),
  ended: Effect.succeed(ADAPTER_NOT_LOADED)
}

const unavailableBackend: AgentBackend = {
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
  deleteSession: (sessionId) =>
    Effect.fail(new SessionDeleteError({ sessionId, reason: ADAPTER_NOT_LOADED })),
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
  setInstallPath: ignored('setInstallPath')
}

const backendMethods = [
  'openSession',
  'readHistory',
  'deleteSession',
  'models',
  'refreshModels',
  'status',
  'checkHealth',
  'setInstallPath'
] as const

/**
 * Lists what keeps `provided`, a value read under {@link AGENT_BACKEND_KEY}, from being an
 * {@link AgentBackend}, one sentence per problem. Returns an empty list when it is one.
 */
export const agentBackendProblems = (provided: Option.Option<unknown>): ReadonlyArray<string> => {
  if (Option.isNone(provided)) return [`setup did not provide "${AGENT_BACKEND_KEY}"`]
  const value = provided.value
  return backendMethods
    .filter(
      (method) => !(Predicate.hasProperty(value, method) && Predicate.isFunction(value[method]))
    )
    .map((method) => `"${AGENT_BACKEND_KEY}.${method}" is not a function`)
}

const isAgentBackend = (provided: Option.Option<unknown>): provided is Option.Some<AgentBackend> =>
  agentBackendProblems(provided).length === 0

/**
 * The Host's {@link AdapterContract}: only an adapter plugin may provide
 * {@link AGENT_BACKEND_KEY}, and an adapter must provide a valid {@link AgentBackend} under it.
 * Pass it to the Host plugin registry.
 */
export const adapterContract: AdapterContract = {
  keys: [AGENT_BACKEND_KEY],
  problems: (provided) => agentBackendProblems(provided(AGENT_BACKEND_KEY))
}

/**
 * Reads the {@link AgentBackend} the adapter plugin provides under {@link AGENT_BACKEND_KEY}.
 * It never fails: when no plugin provides one, or the value is not a backend, it logs the
 * problems and returns a backend whose sessions end at once with
 * `The claude-code adapter is not loaded`, whose `readHistory` returns an empty list and whose
 * `deleteSession` fails. Call it each time a session starts or a transcript is read or deleted; a plugin reload applies from the next call.
 */
export const resolveAgentBackend = Effect.fn('AgentBackend.resolve')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const provided = yield* registry.inject(AGENT_BACKEND_KEY)
  if (isAgentBackend(provided)) {
    yield* Effect.logDebug('Resolved the agent backend')
    return provided.value
  }
  yield* Effect.logError('No valid agent backend is provided', {
    problems: agentBackendProblems(provided),
    reason: ADAPTER_NOT_LOADED
  })
  return unavailableBackend
})
