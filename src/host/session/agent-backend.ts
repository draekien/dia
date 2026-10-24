import type { PermissionResponse, QuestionResponse } from '@shared/domain/attention'
import type {
  ConversationMessage,
  PaneConfig,
  PermissionMode,
  SessionId,
  ThinkingLevel
} from '@shared/domain/pane'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Data, Effect, Option, Predicate, type Scope } from 'effect'
import type { DiaTool } from './dia-tools'
import type { PendingUserInput } from './pending-user-input-resolver'
import type { OutboundMessage } from './protocol'

/** Service key under which the agent adapter plugin provides its {@link AgentBackend}. */
export const AGENT_BACKEND_KEY = 'agentBackend'

/**
 * Live control surface of one pane's agent session, returned by {@link AgentBackend.openSession}.
 * Every method returns once the command has been applied to the session; none waits for the
 * agent's reply, which arrives through the `emit` callback given when the session opened.
 */
export interface AgentSession {
  readonly sendText: (text: string) => Effect.Effect<void>
  readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void>
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>
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
 * How a session gates the agent's tool calls. `AskUser` asks the user through `userInput` and
 * offers the agent `tools`, each asked about before it runs. `DenyAll` is used when nobody can
 * answer: every tool call is denied and no dia tool is offered. Construct with
 * `ToolGate.AskUser({...})` or `ToolGate.DenyAll()`.
 */
export type ToolGate = Data.TaggedEnum<{
  AskUser: { readonly userInput: PendingUserInput; readonly tools: ReadonlyArray<DiaTool> }
  DenyAll: Record<never, never>
}>

/** Constructors and matchers for {@link ToolGate}. */
export const ToolGate = Data.taggedEnum<ToolGate>()

/**
 * What a session opens with. `config` chooses the working directory, model and modes; `resume`
 * names the conversation to continue, or is none for a new one; `emit` receives every event the
 * session produces, in order; `toolGate` decides how tool calls are answered.
 */
export interface AgentSessionOptions {
  readonly config: PaneConfig
  readonly resume: Option.Option<SessionId>
  readonly emit: (message: OutboundMessage) => Effect.Effect<void>
  readonly toolGate: ToolGate
}

/**
 * The agent dia drives, as the adapter plugin provides it under {@link AGENT_BACKEND_KEY}.
 * `openSession` starts one pane's session; the session and every process it starts live in the
 * surrounding scope, and closing that scope ends them. `readHistory` reads a past conversation
 * without starting a session and returns an empty list when it cannot be read.
 */
export interface AgentBackend {
  readonly openSession: (
    options: AgentSessionOptions
  ) => Effect.Effect<AgentSession, never, Scope.Scope>
  readonly readHistory: (
    sessionId: SessionId,
    cwd: string
  ) => Effect.Effect<ReadonlyArray<ConversationMessage>>
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
  setThinkingLevel: ignored('setThinkingLevel'),
  setPermissionMode: ignored('setPermissionMode'),
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
    }).pipe(Effect.as([]))
}

const isAgentBackend = (value: unknown): value is AgentBackend =>
  Predicate.hasProperty(value, 'openSession') &&
  Predicate.isFunction(value.openSession) &&
  Predicate.hasProperty(value, 'readHistory') &&
  Predicate.isFunction(value.readHistory)

/**
 * Reads the {@link AgentBackend} the adapter plugin provides under {@link AGENT_BACKEND_KEY}.
 * It never fails: when no plugin provides one, or the value is not a backend, it logs an error
 * and returns a backend whose sessions end at once with `The claude-code adapter is not loaded`
 * and whose `readHistory` returns an empty list. Call it each time a session starts or a
 * transcript is read; a plugin reload applies from the next call.
 */
export const resolveAgentBackend = Effect.fn('AgentBackend.resolve')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const provided = yield* registry.inject(AGENT_BACKEND_KEY)
  if (Option.isSome(provided) && isAgentBackend(provided.value)) {
    yield* Effect.logDebug('Resolved the agent backend')
    return provided.value
  }
  yield* Effect.logError('No valid agent backend is provided', {
    provided: Option.isSome(provided),
    reason: ADAPTER_NOT_LOADED
  })
  return unavailableBackend
})
