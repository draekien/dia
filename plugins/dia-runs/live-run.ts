import {
  type Attachment,
  Attention,
  type OutboundMessage,
  type PaneConfig,
  PaneEvents,
  Parking,
  type PermissionMode,
  type QuestionResponse,
  type RunStatus,
  type SendMode,
  type SessionId,
  type ThinkingLevel
} from '@dia/plugin'
import {
  type Cause,
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Match,
  Option,
  Queue,
  Ref,
  Result,
  Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import type { AgentSession } from './backend'

type AttentionState = Attention.AttentionState
type IpcEvent = PaneEvents.IpcEvent
type PermissionResponse = Attention.PermissionResponse
type UserInputRequest = Attention.UserInputRequest

/** Live control surface of one open run, returned by {@link startLiveRun}. */
export interface LiveRunHandle {
  readonly sendMessage: (
    text: string,
    mode: SendMode,
    attachments?: ReadonlyArray<Attachment>
  ) => Effect.Effect<void>
  readonly editQueuedMessage: (
    messageId: string,
    text: string,
    attachments?: ReadonlyArray<Attachment>
  ) => Effect.Effect<void>
  readonly removeQueuedMessage: (messageId: string) => Effect.Effect<void>
  readonly sendQueuedMessageNow: (messageId: string) => Effect.Effect<void>
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
  readonly markCrashed: (error: Attention.PaneError) => Effect.Effect<void>
  /**
   * Moves the run to `Errored` with `error`. Refused with a logged warning when its attention
   * cannot move to `Errored`: a parked run, or one already `Errored`.
   */
  readonly markErrored: (error: Attention.PaneError) => Effect.Effect<void>
  /** Resumes a parked run (see {@link AgentSession.resume}). Does nothing unless it is parked. */
  readonly resumeParked: Effect.Effect<void>
  /** Sends `continue` to resume a turn a reload or restart cut off. */
  readonly continueTurn: Effect.Effect<void>
}

/**
 * What a live run reports to its owner: a new conversation id (`None` when the one it resumed
 * does not exist), a permission mode the session chose itself, and each status change.
 */
export interface LiveRunCallbacks {
  readonly onSessionChanged: (sessionId: Option.Option<SessionId>) => Effect.Effect<void>
  readonly onPermissionModeChanged: (mode: PermissionMode) => Effect.Effect<void>
  readonly onStatus: (status: Exclude<RunStatus, 'archived'>) => Effect.Effect<void>
}

/** What {@link startLiveRun} needs besides the run's config and callbacks. */
export interface LiveRunOptions extends LiveRunCallbacks {
  readonly config: PaneConfig
  readonly resume: Option.Option<SessionId>
  readonly open: (
    emit: (message: OutboundMessage) => Effect.Effect<void>,
    turnEnded: Effect.Effect<void>
  ) => Effect.Effect<AgentSession, never, Scope.Scope>
  readonly record: (message: OutboundMessage) => Effect.Effect<void>
  readonly usageLimitResume: Effect.Effect<Parking.UsageLimitResume>
}

type RunOutput = Data.TaggedEnum<{
  Publish: { readonly event: IpcEvent }
  Record: { readonly message: OutboundMessage }
}>
const RunOutput = Data.taggedEnum<RunOutput>()

function toIpcEvent(paneId: string, message: OutboundMessage): Option.Option<IpcEvent> {
  return Match.value(message)
    .pipe(
      Match.tag('ToolCallUpdated', 'TurnStatusChanged', 'SessionNotice', (m) =>
        Option.some(turnProgressEvent(paneId, m))
      ),
      Match.tag('BackgroundTasksChanged', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PaneBackgroundTasksChanged.make({ paneId, tasks: m.tasks })
        )
      ),
      Match.tag('PermissionRequested', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PanePermissionRequested.make({
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
          PaneEvents.PaneQuestionRequested.make({
            paneId,
            requestId: m.requestId,
            questions: m.questions
          })
        )
      ),
      Match.tag('PlanReviewRequested', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PanePlanReviewRequested.make({ paneId, requestId: m.requestId, plan: m.plan })
        )
      ),
      Match.tag('SlashCommandsWarming', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PaneSlashCommandsWarming.make({ paneId, active: m.active })
        )
      ),
      Match.tag('SlashCommandsAvailable', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PaneSlashCommandsAvailable.make({ paneId, commands: m.commands })
        )
      ),
      Match.tag('ConversationCompacted', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PaneConversationCompacted.make({
            paneId,
            trigger: m.trigger,
            preTokens: m.preTokens,
            ...(m.postTokens !== undefined ? { postTokens: m.postTokens } : {})
          })
        )
      ),
      Match.tag('ConversationReset', () =>
        Option.some<IpcEvent>(PaneEvents.PaneConversationReset.make({ paneId }))
      )
    )
    .pipe(
      Match.tag('RewoundToCheckpoint', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PaneRewoundToCheckpoint.make({ paneId, messageUuid: m.messageUuid })
        )
      ),
      Match.tag('RewindFailed', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PaneRewindFailed.make({
            paneId,
            messageUuid: m.messageUuid,
            cause: m.cause,
            ...(m.detail !== undefined ? { detail: m.detail } : {})
          })
        )
      ),
      Match.tag('MessageQueueChanged', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PaneMessageQueueChanged.make({ paneId, queued: m.queued, held: m.held })
        )
      ),
      Match.tag('UserMessagesSent', (m) =>
        Option.some<IpcEvent>(
          PaneEvents.PaneUserMessagesSent.make({ paneId, messages: m.messages })
        )
      ),
      Match.tag('ModelChanged', (m) =>
        Option.some<IpcEvent>(PaneEvents.PaneModelChanged.make({ paneId, model: m.model }))
      ),
      Match.tag('ContextUsageChanged', (m) =>
        Option.some<IpcEvent>(PaneEvents.PaneContextUsageChanged.make({ paneId, usage: m.usage }))
      ),
      Match.tag('CompactionFailed', (m) =>
        Option.some<IpcEvent>(PaneEvents.PaneCompactionFailed.make({ paneId, failure: m.failure }))
      ),
      // TurnCompleted/TurnErrored/SessionStarted only drive AttentionState (see toAttentionTarget);
      // PermissionModeChanged is reported through onPermissionModeChanged.
      Match.tag(
        'TurnCompleted',
        'TurnErrored',
        'TurnParked',
        'SessionStarted',
        'PermissionModeChanged',
        () => Option.none<IpcEvent>()
      ),
      Match.tag(
        'AssistantMessageReceived',
        'AssistantTextDelta',
        'AssistantThinkingDelta',
        'ToolCallStarted',
        'ToolCallCompleted',
        'CheckpointAvailable',
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
      return PaneEvents.PaneToolCallUpdated.make({
        paneId,
        toolCallId: message.toolCallId,
        ...(message.input !== undefined ? { input: message.input } : {}),
        ...(message.elapsedSeconds !== undefined ? { elapsedSeconds: message.elapsedSeconds } : {}),
        ...(message.detail !== undefined ? { detail: message.detail } : {})
      })
    case 'TurnStatusChanged':
      return PaneEvents.PaneTurnStatusChanged.make({ paneId, label: message.label })
    case 'SessionNotice':
      return PaneEvents.PaneSessionNotice.make({
        paneId,
        text: message.text,
        ...(message.link !== undefined ? { link: message.link } : {})
      })
  }
}

function toAttentionTarget(message: OutboundMessage): Option.Option<AttentionState> {
  return Match.value(message).pipe(
    Match.tag('PermissionRequested', (m) =>
      Option.some<AttentionState>(
        Attention.AwaitingPermission.make({
          request: Attention.PermissionRequest.make({
            requestId: m.requestId,
            toolName: m.toolName,
            input: m.input,
            ...(m.suggestions !== undefined ? { suggestions: m.suggestions } : {})
          })
        })
      )
    ),
    Match.tag('QuestionRequested', (m) =>
      Option.some<AttentionState>(
        Attention.AwaitingPermission.make({
          request: Attention.ClarifyingQuestion.make({
            requestId: m.requestId,
            questions: m.questions
          })
        })
      )
    ),
    Match.tag('PlanReviewRequested', (m) =>
      Option.some<AttentionState>(
        Attention.AwaitingPermission.make({
          request: Attention.PlanReview.make({ requestId: m.requestId, plan: m.plan })
        })
      )
    ),
    Match.tag('TurnCompleted', () => Option.some<AttentionState>(Attention.Completed.make({}))),
    Match.tag('UserMessagesSent', () => Option.some<AttentionState>(Attention.Idle.make({}))),
    Match.tag('TurnErrored', (m) =>
      Option.some<AttentionState>(Attention.Errored.make({ error: m.error }))
    ),
    Match.orElse(() => Option.none<AttentionState>())
  )
}

function statusAfter(message: OutboundMessage): Option.Option<'idle' | 'running' | 'waiting'> {
  switch (message._tag) {
    case 'UserMessagesSent':
      return Option.some('running')
    case 'PermissionRequested':
    case 'QuestionRequested':
    case 'PlanReviewRequested':
      return Option.some('waiting')
    case 'TurnCompleted':
    case 'TurnErrored':
    case 'TurnParked':
      return Option.some('idle')
    default:
      return Option.none()
  }
}

const parkedState = (
  cause: Parking.ParkCause,
  mode: Parking.UsageLimitResume,
  nowMs: number
): Attention.ParkedState => {
  if (cause._tag === 'SignedOut' || cause.resetsAt === null || cause.resetsAt <= nowMs) {
    return Attention.ParkedForUser.make({ cause })
  }
  const resumesAt = Parking.resumesAtFor(cause, mode, nowMs)
  return resumesAt === null
    ? Attention.ParkedUntilReset.make({ cause, resetsAt: cause.resetsAt })
    : Attention.ParkedToResume.make({ cause, resumesAt })
}

/**
 * Starts one run's agent session in the scope it is called in and tracks its attention: pending
 * requests, completion, parking for a usage limit and its timed resume. Every renderer-facing
 * event and every message to record leaves through `outbound` in order; consume it with `drain`.
 * `request` holds the run's open request; `idle` completes the effect it is given when no turn
 * is in progress. Status changes and session ids reach `options`' callbacks unless `stopped`.
 */
export const startLiveRun = Effect.fn('LiveRun.start')(function* (options: LiveRunOptions) {
  const { config } = options
  const runScope = yield* Scope.Scope
  const outbound = yield* Queue.unbounded<RunOutput, Cause.Done>()
  const publish = (event: IpcEvent) => Queue.offer(outbound, RunOutput.Publish({ event }))
  const attentionRef = yield* Ref.make<AttentionState>(Attention.Idle.make({}))
  const request = yield* SubscriptionRef.make(Option.none<UserInputRequest>())
  const turnRunning = yield* SubscriptionRef.make(false)
  const stopped = yield* Deferred.make<void>()
  const timerFiberRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none())
  const sessionReady = yield* Deferred.make<AgentSession>()

  const unlessStopped = (effect: Effect.Effect<void>) =>
    Effect.flatMap(Deferred.isDone(stopped), (done) => (done ? Effect.void : effect))

  const setStatus = (status: 'idle' | 'running' | 'waiting') =>
    Effect.andThen(
      SubscriptionRef.set(turnRunning, status !== 'idle'),
      unlessStopped(options.onStatus(status))
    )

  const turnEnded = SubscriptionRef.changes(turnRunning).pipe(
    Stream.filter((running) => !running),
    Stream.take(1),
    Stream.runDrain
  )

  const resumeSession = Effect.gen(function* () {
    yield* Ref.set(timerFiberRef, Option.none())
    yield* Effect.logInfo('Usage limit reset; resuming the parked run', { runId: config.paneId })
    const session = yield* Deferred.await(sessionReady)
    yield* session.resume
  })

  const applyAttention: (next: AttentionState) => Effect.Effect<void> = Effect.fn(
    'LiveRun.applyAttention'
  )(function* (next: AttentionState) {
    const current = yield* Ref.get(attentionRef)
    const result = Attention.transitionAttention(current, next)
    if (Result.isFailure(result)) {
      yield* Effect.logWarning('Rejected invalid attention transition', {
        runId: config.paneId,
        from: current._tag,
        to: next._tag
      })
      return
    }

    const pending = yield* Ref.get(timerFiberRef)
    if (Option.isSome(pending)) {
      yield* Fiber.interrupt(pending.value)
      yield* Ref.set(timerFiberRef, Option.none())
    }

    yield* Ref.set(attentionRef, result.success)
    yield* SubscriptionRef.set(
      request,
      result.success._tag === 'AwaitingPermission'
        ? Option.some(result.success.request)
        : Option.none()
    )
    yield* publish(
      PaneEvents.PaneAttentionChanged.make({ paneId: config.paneId, attention: result.success })
    )

    if (result.success._tag === 'Completed') {
      const fiber = yield* Effect.sleep(Duration.seconds(3)).pipe(
        Effect.andThen(Ref.set(timerFiberRef, Option.none())),
        Effect.andThen(applyAttention(Attention.Idle.make({}))),
        Effect.forkIn(runScope)
      )
      yield* Ref.set(timerFiberRef, Option.some(fiber))
    }

    if (result.success._tag === 'ParkedToResume') {
      const nowMs = yield* Clock.currentTimeMillis
      const fiber = yield* Effect.sleep(Duration.millis(result.success.resumesAt - nowMs)).pipe(
        Effect.andThen(resumeSession),
        Effect.forkIn(runScope)
      )
      yield* Ref.set(timerFiberRef, Option.some(fiber))
    }

    if (result.success._tag === 'ParkedUntilReset') {
      const nowMs = yield* Clock.currentTimeMillis
      const forUser = Attention.ParkedForUser.make({ cause: result.success.cause })
      const fiber = yield* Effect.sleep(Duration.millis(result.success.resetsAt - nowMs)).pipe(
        Effect.andThen(Ref.set(timerFiberRef, Option.none())),
        Effect.andThen(
          Effect.logInfo('Usage limit reset; the parked run waits for the user', {
            runId: config.paneId
          })
        ),
        Effect.andThen(applyAttention(forUser)),
        Effect.forkIn(runScope)
      )
      yield* Ref.set(timerFiberRef, Option.some(fiber))
    }
  })

  const park = Effect.fn('LiveRun.park')(function* (
    cause: Parking.ParkCause,
    mode: Parking.UsageLimitResume
  ) {
    const nowMs = yield* Clock.currentTimeMillis
    const next = parkedState(cause, mode, nowMs)
    yield* Effect.logInfo('Parked the run', {
      runId: config.paneId,
      cause: cause._tag,
      mode,
      state: next._tag,
      resumesAt: next._tag === 'ParkedToResume' ? next.resumesAt : null
    })
    yield* applyAttention(next)
  })

  const repark = Effect.fn('LiveRun.repark')(function* (mode: Parking.UsageLimitResume) {
    const attention = yield* Ref.get(attentionRef)
    if (!Attention.isParkedState(attention)) return
    yield* Effect.logInfo('Re-parking the run under a new resume mode', {
      runId: config.paneId,
      mode
    })
    yield* park(attention.cause, mode)
  })

  const leaveParked = Ref.get(attentionRef).pipe(
    Effect.flatMap((attention) =>
      Attention.isParkedState(attention) ? applyAttention(Attention.Idle.make({})) : Effect.void
    )
  )

  const handleSessionEvent = (message: OutboundMessage): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (message._tag === 'SessionStarted') {
        yield* Effect.logInfo('Run session started', {
          runId: config.paneId,
          sessionId: message.sessionId
        })
        yield* unlessStopped(options.onSessionChanged(Option.some(message.sessionId)))
      }

      if (message._tag === 'ConversationReset') {
        yield* Effect.logInfo('Run conversation reset; storing the new session id', {
          runId: config.paneId,
          newSessionId: message.newSessionId
        })
        yield* unlessStopped(options.onSessionChanged(Option.some(message.newSessionId)))
      }

      if (message._tag === 'PermissionModeChanged') {
        yield* Effect.logInfo('Run permission mode changed by the session', {
          runId: config.paneId,
          mode: message.mode
        })
        yield* unlessStopped(options.onPermissionModeChanged(message.mode))
      }

      const event = toIpcEvent(config.paneId, message)
      if (Option.isSome(event)) yield* publish(event.value)

      const status = statusAfter(message)
      if (Option.isSome(status)) yield* setStatus(status.value)

      if (message._tag === 'TurnParked') {
        yield* park(message.cause, yield* options.usageLimitResume)
        return
      }

      const attentionTarget = toAttentionTarget(message)
      if (Option.isSome(attentionTarget)) yield* applyAttention(attentionTarget.value)
    })

  const session = yield* options.open(
    (message) =>
      Effect.andThen(
        Effect.flatMap(Queue.offer(outbound, RunOutput.Record({ message })), (queued) =>
          queued ? Effect.void : options.record(message)
        ),
        handleSessionEvent(message)
      ),
    turnEnded
  )
  yield* Deferred.succeed(sessionReady, session)
  yield* Effect.logInfo('Run agent session created', {
    runId: config.paneId,
    resume: options.resume
  })

  const answered = setStatus('running').pipe(
    Effect.andThen(applyAttention(Attention.Idle.make({})))
  )

  const handle: LiveRunHandle = {
    sendMessage: (text, mode, attachments = []) =>
      Effect.logDebug('Sending text to the run session', {
        runId: config.paneId,
        mode,
        attachments: attachments.length
      }).pipe(
        Effect.andThen(mode === 'steer' ? applyAttention(Attention.Idle.make({})) : Effect.void),
        Effect.andThen(session.sendText(text, mode, attachments))
      ),
    editQueuedMessage: (messageId, text, attachments) =>
      Effect.logDebug('Editing a queued message', { runId: config.paneId, messageId }).pipe(
        Effect.andThen(session.editQueuedText(messageId, text, attachments))
      ),
    removeQueuedMessage: (messageId) =>
      Effect.logDebug('Removing a queued message', { runId: config.paneId, messageId }).pipe(
        Effect.andThen(session.removeQueuedText(messageId))
      ),
    sendQueuedMessageNow: Effect.fnUntraced(function* (messageId) {
      const { queued } = yield* session.messageQueue
      if (!queued.some((message) => message.id === messageId)) {
        return yield* Effect.logDebug('Ignored send now for a message no longer queued', {
          runId: config.paneId,
          messageId
        })
      }
      yield* Effect.logDebug('Sending a queued message now', { runId: config.paneId, messageId })
      yield* applyAttention(Attention.Idle.make({}))
      yield* session.sendQueuedNow(messageId)
    }),
    setThinkingLevel: (level) =>
      Effect.logDebug('Setting the run thinking level', { runId: config.paneId, level }).pipe(
        Effect.andThen(session.setThinkingLevel(level))
      ),
    setPermissionMode: (mode) =>
      Effect.logDebug('Setting the run permission mode', { runId: config.paneId, mode }).pipe(
        Effect.andThen(session.setPermissionMode(mode))
      ),
    setModel: (model) =>
      Effect.logDebug('Setting the run model', { runId: config.paneId, model }).pipe(
        Effect.andThen(session.setModel(model))
      ),
    resolvePermission: (requestId, response) =>
      Effect.logDebug('Resolving a run permission request', {
        runId: config.paneId,
        requestId,
        decision: response._tag
      }).pipe(
        Effect.andThen(session.resolvePermission(requestId, response)),
        Effect.andThen(answered)
      ),
    resolveQuestion: (requestId, response) =>
      Effect.logDebug('Resolving a run question', {
        runId: config.paneId,
        requestId,
        kind: response._tag
      }).pipe(
        Effect.andThen(session.resolveQuestion(requestId, response)),
        Effect.andThen(answered)
      ),
    resolvePlanReview: (requestId, approved) =>
      Effect.logDebug('Resolving a run plan review', {
        runId: config.paneId,
        requestId,
        approved
      }).pipe(
        Effect.andThen(session.resolvePlanReview(requestId, approved)),
        Effect.andThen(answered)
      ),
    rewindToCheckpoint: (messageUuid, resumeAnchorUuid) =>
      Effect.logDebug('Rewinding the run to a checkpoint', {
        runId: config.paneId,
        messageUuid,
        resumeAnchorUuid
      }).pipe(
        Effect.andThen(session.rewindToCheckpoint(messageUuid, resumeAnchorUuid)),
        Effect.andThen(leaveParked)
      ),
    interrupt: () =>
      Effect.logDebug('Interrupting the run session', { runId: config.paneId }).pipe(
        Effect.andThen(session.interrupt()),
        Effect.andThen(setStatus('idle')),
        Effect.andThen(applyAttention(Attention.Idle.make({})))
      ),
    markCrashed: (error) => applyAttention(Attention.Crashed.make({ error })),
    markErrored: (error) => applyAttention(Attention.Errored.make({ error })),
    resumeParked: Ref.get(attentionRef).pipe(
      Effect.flatMap((attention) =>
        Attention.isParkedState(attention)
          ? Effect.logInfo('Resuming the parked run', { runId: config.paneId }).pipe(
              Effect.andThen(session.resume)
            )
          : Effect.logInfo('Skipped a resume; the run is not parked', {
              runId: config.paneId,
              attention: attention._tag
            })
      )
    ),
    continueTurn: Effect.logInfo('Resuming a turn a reload or restart cut off', {
      runId: config.paneId
    }).pipe(Effect.andThen(session.resume))
  }

  const drain = (onEvent: (event: IpcEvent) => Effect.Effect<void>) =>
    Stream.runForEach(Stream.fromQueue(outbound), (output) =>
      output._tag === 'Publish' ? onEvent(output.event) : options.record(output.message)
    )

  return {
    handle,
    session,
    outbound,
    publish,
    drain,
    repark,
    request: SubscriptionRef.changes(request),
    idle: turnEnded,
    stop: Deferred.succeed(stopped, undefined)
  }
})
