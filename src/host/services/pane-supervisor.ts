import {
  type AttentionState,
  AwaitingPermission,
  ClarifyingQuestion,
  Completed,
  Crashed,
  Errored,
  Idle,
  isParkedState,
  type PaneError,
  ParkedForUser,
  type ParkedState,
  ParkedToResume,
  ParkedUntilReset,
  PermissionRequest,
  type PermissionResponse,
  PlanReview,
  type QuestionResponse,
  transitionAttention
} from '@shared/domain/attention'
import type { MessageQueueSnapshot, SendMode } from '@shared/domain/message-queue'
import type {
  PaneConfig,
  PaneId,
  PaneRecord,
  PermissionMode,
  SessionId,
  ThinkingLevel,
  WorktreeInfo
} from '@shared/domain/pane'
import {
  DEFAULT_USAGE_LIMIT_RESUME,
  type ParkCause,
  resumesAtFor,
  type UsageLimitResume
} from '@shared/domain/parking'
import {
  type IpcEvent,
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneAttentionChanged,
  PaneCheckpointAvailable,
  PaneConversationCompacted,
  PaneConversationReset,
  PaneMessageAppended,
  PaneMessageQueueChanged,
  PaneModelChanged,
  PanePermissionRequested,
  PanePlanReviewRequested,
  PaneQuestionRequested,
  PaneRewoundToCheckpoint,
  PaneSessionNotice,
  PaneSlashCommandsAvailable,
  PaneSlashCommandsWarming,
  PaneToolCallCompleted,
  PaneToolCallStarted,
  PaneToolCallUpdated,
  PaneTurnStatusChanged,
  PaneUserMessagesSent
} from '@shared/ipc/contract'
import {
  type Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashMap,
  Layer,
  Match,
  Option,
  Queue,
  Ref,
  Result,
  Scope,
  Stream
} from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { applyOverride, PluginSources } from '../plugins/plugin-sources'
import { type AgentSession, resolveAgentBackend, type SessionEnd } from '../session/agent-backend'
import { makePluginTools } from '../session/dia-tools'
import type { OutboundMessage } from '../session/protocol'
import { SettingsStore } from './settings-store'
import { resolveGitOps, type WorktreeCreateError, WorktreeReattachError } from './worktrees-seam'

/**
 * How a pane's worktree should be obtained. `Create` provisions a brand-new worktree
 * (friendly `dia/<slug>` branch + directory under `worktreesRoot`, collision-checked);
 * `Reattach` re-adds the pane's already-created worktree from its persisted {@link WorktreeInfo}
 * (checking out the existing branch), used on resume after the directory was removed on the
 * prior graceful shutdown. Absent from a {@link PaneCreationRequest} means a non-worktree pane.
 */
export type WorktreeRequest =
  | { readonly _tag: 'Create'; readonly worktreesRoot: string }
  | { readonly _tag: 'Reattach'; readonly info: WorktreeInfo }

/**
 * A pending pane's request to start running: the source directory and model the user chose,
 * plus how to obtain its worktree ({@link WorktreeRequest}) when it is a worktree pane. When
 * `resume` is set, the pane continues the prior Agent SDK session with that id; a worktree pane
 * pairs `resume` with a `Reattach` worktree so its existing branch is checked out rather than
 * created afresh. Pass to {@link PaneSupervisor.openPane} to start and register a new pane.
 */
export interface PaneCreationRequest {
  readonly paneId: PaneId
  readonly sourceCwd: string
  readonly model: string
  readonly thinkingLevel: ThinkingLevel
  readonly permissionMode: PermissionMode
  readonly worktree: WorktreeRequest | undefined
  readonly resume?: SessionId
}

const SESSION_NOT_FOUND_NOTICE =
  "This tab's conversation could not be found. Send your message again to start a new conversation."

/** Failure logged when a pane's agent session ends on its own (not as part of a requested teardown). */
export class SessionEndedError extends Data.TaggedError('SessionEndedError')<{
  readonly paneId: string
  readonly reason: string
}> {}

/** Live control surface for an open pane, returned by {@link PaneSupervisor.openPane} and {@link PaneSupervisor.getHandle}. */
export interface PaneHandle {
  readonly sendMessage: (text: string, mode: SendMode) => Effect.Effect<void>
  readonly editQueuedMessage: (messageId: string, text: string) => Effect.Effect<void>
  readonly removeQueuedMessage: (messageId: string) => Effect.Effect<void>
  readonly messageQueue: Effect.Effect<MessageQueueSnapshot>
  readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void>
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>
  readonly setModel: (model: string) => Effect.Effect<void>
  readonly resolvePermission: (
    requestId: string,
    response: PermissionResponse
  ) => Effect.Effect<void>
  readonly resolveQuestion: (requestId: string, response: QuestionResponse) => Effect.Effect<void>
  readonly resolvePlanReview: (requestId: string, approved: boolean) => Effect.Effect<void>
  readonly rewindToCheckpoint: (
    messageUuid: string,
    resumeAnchorUuid: string | undefined
  ) => Effect.Effect<void>
  readonly interrupt: () => Effect.Effect<void>
  readonly markCrashed: (error: PaneError) => Effect.Effect<void>
  /**
   * Moves the pane to `Errored` with `error`. Refused with a logged warning when the pane's
   * attention cannot move to `Errored`: a parked pane, or one already `Errored`.
   */
  readonly markErrored: (error: PaneError) => Effect.Effect<void>
  /** Resumes a parked pane (see {@link AgentSession.resume}). Does nothing unless the pane is parked. */
  readonly resume: Effect.Effect<void>
}

/**
 * Service that starts a pane's {@link AgentSession} inside the scope it is called in. The live
 * layer starts a session on the loaded agent backend; tests substitute a fake session.
 */
export class SessionFactory extends Context.Service<
  SessionFactory,
  {
    readonly start: (options: {
      readonly config: PaneConfig
      readonly resume: Option.Option<SessionId>
      readonly emit: (message: OutboundMessage) => Effect.Effect<void>
    }) => Effect.Effect<AgentSession, never, Scope.Scope>
  }
>()('SessionFactory') {}

/**
 * Production {@link SessionFactory}. Each start resolves the agent backend and the
 * pending-user-input registry from the loaded plugins, so a plugin reload applies from the next
 * session. When the registry is available the agent gets the plugin tools, backed by
 * `HostPlugins` and `PluginSources`, so it can point a plugin at a source folder and reload it
 * after the user approves; otherwise every tool call is denied.
 */
export const SessionFactoryLive = Layer.effect(
  SessionFactory,
  Effect.gen(function* () {
    const plugins = yield* HostPlugins
    const sources = yield* PluginSources
    const pluginTools = makePluginTools({
      reload: (name) => plugins.load(name),
      setOverride: (name, directory) => applyOverride(sources, name, directory),
      clearOverride: (name) => sources.clearOverride(name)
    })
    const start = Effect.fn('SessionFactory.start')(function* (
      options: Parameters<SessionFactory['Service']['start']>[0]
    ) {
      const backend = yield* resolveAgentBackend(plugins)
      return yield* backend.openSession({ ...options, tools: pluginTools })
    })
    return { start }
  })
)

function toIpcEvent(paneId: string, message: OutboundMessage): Option.Option<IpcEvent> {
  return Match.value(message).pipe(
    Match.tag('AssistantMessageReceived', (m) =>
      Option.some<IpcEvent>(PaneMessageAppended.make({ paneId, message: m.message }))
    ),
    Match.tag('AssistantTextDelta', (m) =>
      Option.some<IpcEvent>(PaneAssistantTextDelta.make({ paneId, text: m.text }))
    ),
    Match.tag('AssistantThinkingDelta', (m) =>
      Option.some<IpcEvent>(PaneAssistantThinkingDelta.make({ paneId, text: m.text }))
    ),
    Match.tag('ToolCallStarted', (m) =>
      Option.some<IpcEvent>(
        PaneToolCallStarted.make({
          paneId,
          toolCallId: m.toolCallId,
          toolName: m.toolName
        })
      )
    ),
    Match.tag('ToolCallCompleted', (m) =>
      Option.some<IpcEvent>(
        PaneToolCallCompleted.make({
          paneId,
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          input: m.input,
          output: m.output,
          isError: m.isError
        })
      )
    ),
    Match.tag('ToolCallUpdated', 'TurnStatusChanged', 'SessionNotice', (m) =>
      Option.some(turnProgressEvent(paneId, m))
    ),
    Match.tag('PermissionRequested', (m) =>
      Option.some<IpcEvent>(
        PanePermissionRequested.make({
          paneId,
          requestId: m.requestId,
          toolName: m.toolName,
          input: m.input,
          ...(m.suggestions !== undefined ? { suggestions: m.suggestions } : {})
        })
      )
    ),
    Match.tag('QuestionRequested', (m) =>
      Option.some<IpcEvent>(
        PaneQuestionRequested.make({
          paneId,
          requestId: m.requestId,
          questions: m.questions
        })
      )
    ),
    Match.tag('PlanReviewRequested', (m) =>
      Option.some<IpcEvent>(
        PanePlanReviewRequested.make({
          paneId,
          requestId: m.requestId,
          plan: m.plan
        })
      )
    ),
    Match.tag('SlashCommandsWarming', (m) =>
      Option.some<IpcEvent>(PaneSlashCommandsWarming.make({ paneId, active: m.active }))
    ),
    Match.tag('SlashCommandsAvailable', (m) =>
      Option.some<IpcEvent>(PaneSlashCommandsAvailable.make({ paneId, commands: m.commands }))
    ),
    Match.tag('ConversationCompacted', (m) =>
      Option.some<IpcEvent>(
        PaneConversationCompacted.make({
          paneId,
          trigger: m.trigger,
          preTokens: m.preTokens,
          ...(m.postTokens !== undefined ? { postTokens: m.postTokens } : {})
        })
      )
    ),
    Match.tag('ConversationReset', () =>
      Option.some<IpcEvent>(PaneConversationReset.make({ paneId }))
    ),
    Match.tag('CheckpointAvailable', (m) =>
      Option.some<IpcEvent>(
        PaneCheckpointAvailable.make({
          paneId,
          messageUuid: m.messageUuid,
          ...(m.resumeAnchorUuid !== undefined ? { resumeAnchorUuid: m.resumeAnchorUuid } : {})
        })
      )
    ),
    Match.tag('RewoundToCheckpoint', (m) =>
      Option.some<IpcEvent>(PaneRewoundToCheckpoint.make({ paneId, messageUuid: m.messageUuid }))
    ),
    Match.tag('MessageQueueChanged', (m) =>
      Option.some<IpcEvent>(
        PaneMessageQueueChanged.make({ paneId, queued: m.queued, held: m.held })
      )
    ),
    Match.tag('UserMessagesSent', (m) =>
      Option.some<IpcEvent>(PaneUserMessagesSent.make({ paneId, messages: m.messages }))
    ),
    Match.tag('ModelChanged', (m) =>
      Option.some<IpcEvent>(PaneModelChanged.make({ paneId, model: m.model }))
    ),
    // TurnCompleted/TurnErrored/SessionStarted carry no renderer-facing content of their own --
    // they only drive AttentionState (see toAttentionTarget below) -- so they have no IpcEvent.
    // PermissionModeChanged is handled out of band by onPermissionModeChanged (it updates the
    // persisted config and layout tree), not surfaced as a standalone renderer event here.
    Match.tag(
      'TurnCompleted',
      'TurnErrored',
      'TurnParked',
      'SessionStarted',
      'PermissionModeChanged',
      () => Option.none<IpcEvent>()
    ),
    Match.exhaustive
  )
}

function turnProgressEvent(
  paneId: string,
  message: Extract<
    OutboundMessage,
    { _tag: 'ToolCallUpdated' | 'TurnStatusChanged' | 'SessionNotice' }
  >
): IpcEvent {
  switch (message._tag) {
    case 'ToolCallUpdated':
      return PaneToolCallUpdated.make({
        paneId,
        toolCallId: message.toolCallId,
        ...(message.input !== undefined ? { input: message.input } : {}),
        ...(message.elapsedSeconds !== undefined ? { elapsedSeconds: message.elapsedSeconds } : {}),
        ...(message.detail !== undefined ? { detail: message.detail } : {})
      })
    case 'TurnStatusChanged':
      return PaneTurnStatusChanged.make({ paneId, label: message.label })
    case 'SessionNotice':
      return PaneSessionNotice.make({ paneId, text: message.text })
  }
}

function toAttentionTarget(message: OutboundMessage): Option.Option<AttentionState> {
  return Match.value(message).pipe(
    Match.tag('PermissionRequested', (m) =>
      Option.some<AttentionState>(
        AwaitingPermission.make({
          request: PermissionRequest.make({
            requestId: m.requestId,
            toolName: m.toolName,
            input: m.input
          })
        })
      )
    ),
    Match.tag('QuestionRequested', (m) =>
      Option.some<AttentionState>(
        AwaitingPermission.make({
          request: ClarifyingQuestion.make({
            requestId: m.requestId,
            questions: m.questions
          })
        })
      )
    ),
    Match.tag('PlanReviewRequested', (m) =>
      Option.some<AttentionState>(
        AwaitingPermission.make({
          request: PlanReview.make({
            requestId: m.requestId,
            plan: m.plan
          })
        })
      )
    ),
    Match.tag('TurnCompleted', () => Option.some<AttentionState>(Completed.make({}))),
    Match.tag('UserMessagesSent', () => Option.some<AttentionState>(Idle.make({}))),
    Match.tag('TurnErrored', (m) => Option.some<AttentionState>(Errored.make({ error: m.error }))),
    Match.orElse(() => Option.none<AttentionState>())
  )
}

const parkedState = (cause: ParkCause, mode: UsageLimitResume, nowMs: number): ParkedState => {
  if (cause._tag === 'SignedOut' || cause.resetsAt === null || cause.resetsAt <= nowMs) {
    return ParkedForUser.make({ cause })
  }
  const resumesAt = resumesAtFor(cause, mode, nowMs)
  return resumesAt === null
    ? ParkedUntilReset.make({ cause, resetsAt: cause.resetsAt })
    : ParkedToResume.make({ cause, resumesAt })
}

const startPane = Effect.fn('PaneSupervisor.startPane')(function* (
  config: PaneConfig,
  factory: SessionFactory['Service'],
  settings: SettingsStore['Service'],
  onSessionChanged: (sessionId: Option.Option<SessionId>) => Effect.Effect<void>,
  onPermissionModeChanged: (mode: PermissionMode) => Effect.Effect<void>,
  resume: Option.Option<SessionId>
) {
  const paneScope = yield* Scope.Scope
  const outbound = yield* Queue.unbounded<IpcEvent, Cause.Done>()
  const recordRef = yield* Ref.make<PaneRecord>({
    config,
    history: [],
    attention: Idle.make({})
  })
  const timerFiberRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none())
  const sessionReady = yield* Deferred.make<AgentSession>()

  const resumeSession = Effect.gen(function* () {
    yield* Ref.set(timerFiberRef, Option.none())
    yield* Effect.logInfo('Usage limit reset; resuming the parked pane', { paneId: config.paneId })
    const session = yield* Deferred.await(sessionReady)
    yield* session.resume
  })

  const applyAttention: (next: AttentionState) => Effect.Effect<void> = Effect.fn(
    'PaneSupervisor.applyAttention'
  )(function* (next: AttentionState) {
    const record = yield* Ref.get(recordRef)
    const result = transitionAttention(record.attention, next)
    if (Result.isFailure(result)) {
      yield* Effect.logWarning('Rejected invalid attention transition', {
        paneId: config.paneId,
        from: record.attention._tag,
        to: next._tag
      })
      return
    }

    const pending = yield* Ref.get(timerFiberRef)
    if (Option.isSome(pending)) {
      yield* Fiber.interrupt(pending.value)
      yield* Ref.set(timerFiberRef, Option.none())
    }

    yield* Ref.update(recordRef, (r) => ({ ...r, attention: result.success }))
    yield* Queue.offer(
      outbound,
      PaneAttentionChanged.make({ paneId: config.paneId, attention: result.success })
    )

    if (result.success._tag === 'Completed') {
      const fiber = yield* Effect.sleep(Duration.seconds(3)).pipe(
        Effect.andThen(Ref.set(timerFiberRef, Option.none())),
        Effect.andThen(applyAttention(Idle.make({}))),
        Effect.forkIn(paneScope)
      )
      yield* Ref.set(timerFiberRef, Option.some(fiber))
    }

    if (result.success._tag === 'ParkedToResume') {
      const nowMs = yield* Clock.currentTimeMillis
      const fiber = yield* Effect.sleep(Duration.millis(result.success.resumesAt - nowMs)).pipe(
        Effect.andThen(resumeSession),
        Effect.forkIn(paneScope)
      )
      yield* Ref.set(timerFiberRef, Option.some(fiber))
    }

    if (result.success._tag === 'ParkedUntilReset') {
      const nowMs = yield* Clock.currentTimeMillis
      const forUser = ParkedForUser.make({ cause: result.success.cause })
      const fiber = yield* Effect.sleep(Duration.millis(result.success.resetsAt - nowMs)).pipe(
        Effect.andThen(Ref.set(timerFiberRef, Option.none())),
        Effect.andThen(
          Effect.logInfo('Usage limit reset; the parked pane waits for the user', {
            paneId: config.paneId
          })
        ),
        Effect.andThen(applyAttention(forUser)),
        Effect.forkIn(paneScope)
      )
      yield* Ref.set(timerFiberRef, Option.some(fiber))
    }
  })

  const currentMode = settings
    .getUsageLimitResume()
    .pipe(Effect.map(Option.getOrElse(() => DEFAULT_USAGE_LIMIT_RESUME)))

  const park = Effect.fn('PaneSupervisor.park')(function* (
    cause: ParkCause,
    mode: UsageLimitResume
  ) {
    const nowMs = yield* Clock.currentTimeMillis
    const next = parkedState(cause, mode, nowMs)
    yield* Effect.logInfo('Parked the pane', {
      paneId: config.paneId,
      cause: cause._tag,
      mode,
      state: next._tag,
      resumesAt: next._tag === 'ParkedToResume' ? next.resumesAt : null
    })
    yield* applyAttention(next)
  })

  const repark = Effect.fn('PaneSupervisor.repark')(function* (mode: UsageLimitResume) {
    const { attention } = yield* Ref.get(recordRef)
    if (!isParkedState(attention)) return
    yield* Effect.logInfo('Re-parking the pane under a new resume mode', {
      paneId: config.paneId,
      mode
    })
    yield* park(attention.cause, mode)
  })

  const leaveParked = Ref.get(recordRef).pipe(
    Effect.flatMap(({ attention }) =>
      isParkedState(attention) ? applyAttention(Idle.make({})) : Effect.void
    )
  )

  const handleSessionEvent = (message: OutboundMessage): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (message._tag === 'AssistantMessageReceived') {
        yield* Ref.update(recordRef, (record) => ({
          ...record,
          history: [...record.history, message.message]
        }))
        yield* Effect.logInfo('Appended message to pane history', {
          paneId: config.paneId,
          role: message.message.role
        })
      }

      if (message._tag === 'SessionStarted') {
        yield* Effect.logInfo('Pane session started', {
          paneId: config.paneId,
          sessionId: message.sessionId
        })
        yield* onSessionChanged(Option.some(message.sessionId))
      }

      if (message._tag === 'ConversationReset') {
        yield* Effect.logInfo('Pane conversation reset; persisting new session id', {
          paneId: config.paneId,
          newSessionId: message.newSessionId
        })
        yield* onSessionChanged(Option.some(message.newSessionId))
      }

      if (message._tag === 'PermissionModeChanged') {
        yield* Effect.logInfo('Pane permission mode changed by the session', {
          paneId: config.paneId,
          mode: message.mode
        })
        yield* onPermissionModeChanged(message.mode)
      }

      const event = toIpcEvent(config.paneId, message)
      if (Option.isSome(event)) yield* Queue.offer(outbound, event.value)

      if (message._tag === 'TurnParked') {
        yield* park(message.cause, yield* currentMode)
        return
      }

      const attentionTarget = toAttentionTarget(message)
      if (Option.isSome(attentionTarget)) yield* applyAttention(attentionTarget.value)
    })

  const session = yield* factory.start({ config, resume, emit: handleSessionEvent })
  yield* Deferred.succeed(sessionReady, session)
  yield* Effect.logInfo('Pane agent session created', { paneId: config.paneId, resume })

  const handle: PaneHandle = {
    sendMessage: (text, mode) =>
      Effect.logDebug('Sending text to pane session', { paneId: config.paneId, text, mode }).pipe(
        Effect.andThen(mode === 'steer' ? applyAttention(Idle.make({})) : Effect.void),
        Effect.andThen(session.sendText(text, mode))
      ),
    editQueuedMessage: (messageId, text) =>
      Effect.logDebug('Editing a queued message', { paneId: config.paneId, messageId }).pipe(
        Effect.andThen(session.editQueuedText(messageId, text))
      ),
    removeQueuedMessage: (messageId) =>
      Effect.logDebug('Removing a queued message', { paneId: config.paneId, messageId }).pipe(
        Effect.andThen(session.removeQueuedText(messageId))
      ),
    messageQueue: session.messageQueue,
    setThinkingLevel: (level) =>
      Effect.logDebug('Setting pane thinking level', { paneId: config.paneId, level }).pipe(
        Effect.andThen(session.setThinkingLevel(level))
      ),
    setPermissionMode: (mode) =>
      Effect.logDebug('Setting pane permission mode', { paneId: config.paneId, mode }).pipe(
        Effect.andThen(session.setPermissionMode(mode))
      ),
    setModel: (model) =>
      Effect.logDebug('Setting pane model', { paneId: config.paneId, model }).pipe(
        Effect.andThen(session.setModel(model))
      ),
    resolvePermission: (requestId, response) =>
      Effect.logDebug('Resolving pane permission request', {
        paneId: config.paneId,
        requestId,
        decision: response._tag
      }).pipe(
        Effect.andThen(session.resolvePermission(requestId, response)),
        Effect.andThen(applyAttention(Idle.make({})))
      ),
    resolveQuestion: (requestId, response) =>
      Effect.logDebug('Resolving pane question', {
        paneId: config.paneId,
        requestId,
        kind: response._tag
      }).pipe(
        Effect.andThen(session.resolveQuestion(requestId, response)),
        Effect.andThen(applyAttention(Idle.make({})))
      ),
    resolvePlanReview: (requestId, approved) =>
      Effect.logDebug('Resolving pane plan review', {
        paneId: config.paneId,
        requestId,
        approved
      }).pipe(
        Effect.andThen(session.resolvePlanReview(requestId, approved)),
        Effect.andThen(applyAttention(Idle.make({})))
      ),
    rewindToCheckpoint: (messageUuid, resumeAnchorUuid) =>
      Effect.logDebug('Rewinding pane to checkpoint', {
        paneId: config.paneId,
        messageUuid,
        resumeAnchorUuid
      }).pipe(
        Effect.andThen(session.rewindToCheckpoint(messageUuid, resumeAnchorUuid)),
        Effect.andThen(leaveParked)
      ),
    interrupt: () =>
      Effect.logDebug('Interrupting pane session', { paneId: config.paneId }).pipe(
        Effect.andThen(session.interrupt()),
        Effect.andThen(applyAttention(Idle.make({})))
      ),
    markCrashed: (error) => applyAttention(Crashed.make({ error })),
    markErrored: (error) => applyAttention(Errored.make({ error })),
    resume: Ref.get(recordRef).pipe(
      Effect.flatMap(({ attention }) =>
        isParkedState(attention)
          ? Effect.logInfo('Resuming the parked pane', { paneId: config.paneId }).pipe(
              Effect.andThen(session.resume)
            )
          : Effect.logInfo('Skipped a resume; the pane is not parked', {
              paneId: config.paneId,
              attention: attention._tag
            })
      )
    )
  }

  return { handle, session, outbound, repark }
})

interface PaneEntry {
  readonly handle: PaneHandle
  readonly repark: (mode: UsageLimitResume) => Effect.Effect<void>
  readonly scope: Scope.Closeable
  readonly outbound: Queue.Queue<IpcEvent, Cause.Done>
  readonly subscriber: Fiber.Fiber<void>
  readonly closed: Deferred.Deferred<void>
}

/** Manages the lifecycle of all open panes: starting sessions, routing events, and teardown. */
export class PaneSupervisor extends Context.Service<
  PaneSupervisor,
  {
    /**
     * Provisions a pane's worktree (creating it, or reattaching the existing branch when
     * `request.resume` is set), starts its agent session in a scope of its own, and registers it
     * for lookup and teardown. `onEvent` receives every renderer-facing event the pane produces,
     * in order. `onSessionChanged` receives the session the pane resumes from, for the caller to
     * persist: `Some(id)` when the Agent SDK session starts or its conversation resets, and `None`
     * when the session ended because the conversation it resumed does not exist. `onPermissionModeChanged` is
     * invoked when the pane changes its own permission mode (a plan was approved, restoring the
     * pre-plan mode), carrying the mode the caller should persist and reflect in the layout.
     * When the pane's session later ends on its own, every event produced before that reaches
     * `onEvent` and the pane is removed. A missing conversation marks the pane `Errored` with a
     * notice that the next message starts a new conversation; any other end marks it `Crashed`.
     */
    readonly openPane: (
      request: PaneCreationRequest,
      onEvent: (event: IpcEvent) => Effect.Effect<void>,
      onSessionChanged: (sessionId: Option.Option<SessionId>) => Effect.Effect<void>,
      onPermissionModeChanged: (mode: PermissionMode) => Effect.Effect<void>
    ) => Effect.Effect<
      { readonly handle: PaneHandle; readonly config: PaneConfig },
      WorktreeCreateError | WorktreeReattachError
    >
    /** Ends the given pane's session and removes its worktree, delivering its pending events first. */
    readonly closePane: (paneId: PaneId) => Effect.Effect<void>
    /** Looks up the live {@link PaneHandle} for an open pane, if any. */
    readonly getHandle: (paneId: PaneId) => Effect.Effect<Option.Option<PaneHandle>>
    /**
     * Gracefully tears down every open pane (ending its session and removing its worktree, if
     * any) -- for Host shutdown, so panes are never left to be killed out-of-band and misreported
     * as crashes.
     */
    readonly closeAll: () => Effect.Effect<void>
    /**
     * Stores what dia does when a usage limit resets, and applies it to every parked pane: a pane
     * waiting for its reset under `automatic` waits for the user under `manual`, and the reverse.
     */
    readonly setUsageLimitResume: (mode: UsageLimitResume) => Effect.Effect<void>
  }
>()('PaneSupervisor') {}

/** Production {@link PaneSupervisor} layer backed by {@link SessionFactory} sessions and git worktrees. */
export const PaneSupervisorLive = Layer.effect(
  PaneSupervisor,
  Effect.gen(function* () {
    const factory = yield* SessionFactory
    const plugins = yield* HostPlugins
    const settings = yield* SettingsStore
    const entriesRef = yield* Ref.make(HashMap.empty<PaneId, PaneEntry>())

    const teardown = Effect.fn('PaneSupervisor.teardown')(function* (paneId: PaneId) {
      const entries = yield* Ref.get(entriesRef)
      const entry = HashMap.get(entries, paneId)
      if (Option.isNone(entry)) return
      yield* Ref.update(entriesRef, HashMap.remove(paneId))
      yield* Deferred.succeed(entry.value.closed, undefined)
      yield* Queue.end(entry.value.outbound)
      yield* Fiber.join(entry.value.subscriber)
      yield* Scope.close(entry.value.scope, Exit.succeed(undefined))
    })

    const openPane = Effect.fn('PaneSupervisor.openPane')(function* (
      request: PaneCreationRequest,
      onEvent: (event: IpcEvent) => Effect.Effect<void>,
      onSessionChanged: (sessionId: Option.Option<SessionId>) => Effect.Effect<void>,
      onPermissionModeChanged: (mode: PermissionMode) => Effect.Effect<void>
    ) {
      const scope = yield* Scope.make()

      const prepared = yield* Effect.gen(function* () {
        const projectConfig: PaneConfig = {
          paneId: request.paneId,
          cwd: request.sourceCwd,
          model: request.model,
          thinkingLevel: request.thinkingLevel,
          permissionMode: request.permissionMode
        }
        const worktreeRequest = request.worktree
        if (worktreeRequest === undefined) return projectConfig

        const resolved = yield* resolveGitOps(plugins)
        if (Option.isNone(resolved)) {
          if (worktreeRequest._tag === 'Reattach') {
            return yield* new WorktreeReattachError({
              paneId: request.paneId,
              path: worktreeRequest.info.path,
              cause: 'Load the worktrees plugin to resume this pane'
            })
          }
          yield* Effect.logWarning(
            'Opening the pane in the project directory because the worktrees plugin is not loaded',
            { paneId: request.paneId, cwd: request.sourceCwd }
          )
          return projectConfig
        }
        const gitOps = resolved.value

        const acquire: Effect.Effect<WorktreeInfo, WorktreeCreateError | WorktreeReattachError> =
          worktreeRequest._tag === 'Create'
            ? gitOps.createWorktree(
                request.sourceCwd,
                request.paneId,
                worktreeRequest.worktreesRoot
              )
            : gitOps.reattachWorktree(worktreeRequest.info, request.paneId)

        const worktree = yield* Effect.acquireRelease(acquire, (info) =>
          gitOps.removeWorktree(info, request.paneId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError('Failed to remove pane worktree', {
                paneId: request.paneId,
                cause
              })
            )
          )
        )

        const config: PaneConfig = { ...projectConfig, cwd: worktree.path, worktree }
        return config
      }).pipe(Effect.provideService(Scope.Scope, scope), Effect.result)

      if (Result.isFailure(prepared)) {
        yield* Scope.close(scope, Exit.fail(prepared.failure))
        return yield* prepared.failure
      }

      const config = prepared.success

      const { handle, session, outbound, repark } = yield* startPane(
        config,
        factory,
        settings,
        onSessionChanged,
        onPermissionModeChanged,
        Option.fromUndefinedOr(request.resume)
      ).pipe(Effect.provideService(Scope.Scope, scope))

      const subscriber = yield* Effect.forkDetach(
        Stream.runForEach(Stream.fromQueue(outbound), onEvent)
      )
      const closed = yield* Deferred.make<void>()

      yield* Ref.update(
        entriesRef,
        HashMap.set(config.paneId, { handle, repark, scope, outbound, subscriber, closed })
      )

      const clearMissingSession = Effect.fnUntraced(function* (sessionId: SessionId) {
        yield* Effect.logWarning('Pane session not found; cleared the tab session', {
          paneId: config.paneId,
          sessionId
        })
        yield* onSessionChanged(Option.none())
        yield* Queue.offer(
          outbound,
          PaneMessageQueueChanged.make({ paneId: config.paneId, queued: [], held: false })
        )
        yield* handle.markErrored({ message: SESSION_NOT_FOUND_NOTICE })
      })

      const ended = (end: SessionEnd) =>
        (end._tag === 'SessionNotFound'
          ? clearMissingSession(end.sessionId)
          : Effect.logError(
              new SessionEndedError({ paneId: config.paneId, reason: end.reason })
            ).pipe(
              Effect.andThen(
                handle.markCrashed({ message: `Pane session ended unexpectedly: ${end.reason}` })
              )
            )
        ).pipe(Effect.andThen(teardown(config.paneId)))

      const crashed = session.ended.pipe(
        Effect.map(Option.some),
        Effect.raceFirst(Deferred.await(closed).pipe(Effect.as(Option.none<SessionEnd>()))),
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: ended }))
      )
      yield* Effect.forkDetach(crashed)

      return { handle, config }
    })

    const closePane = (paneId: PaneId) => teardown(paneId)

    const getHandle = (paneId: PaneId) =>
      Ref.get(entriesRef).pipe(
        Effect.map((entries) => Option.map(HashMap.get(entries, paneId), (entry) => entry.handle))
      )

    const closeAll = () =>
      Ref.get(entriesRef).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(Array.from(HashMap.keys(entries)), teardown, { discard: true })
        )
      )

    const setUsageLimitResume = Effect.fn('PaneSupervisor.setUsageLimitResume')(function* (
      mode: UsageLimitResume
    ) {
      yield* settings.setUsageLimitResume(mode)
      const entries = yield* Ref.get(entriesRef)
      yield* Effect.forEach(HashMap.values(entries), (entry) => entry.repark(mode), {
        discard: true
      })
    })

    return { openPane, closePane, getHandle, closeAll, setUsageLimitResume }
  })
)
