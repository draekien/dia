import { OutgoingMessage } from '@dia/plugin'
import { Schema } from 'effect'

const Messages = Schema.Array(OutgoingMessage)

/** No turn is running. `queued` is non-empty only when `held` is true. */
export const QueueIdle = Schema.TaggedStruct('QueueIdle', {
  queued: Messages,
  held: Schema.Boolean
})

/**
 * A turn is running or about to start. `steered` waits for the running turn to end; `queued` waits
 * for the turn after it; `dispatching` counts the `Dispatch` actions whose messages are not yet
 * offered to the SDK.
 */
export const QueueRunning = Schema.TaggedStruct('QueueRunning', {
  queued: Messages,
  held: Schema.Boolean,
  steered: Messages,
  dispatching: Schema.Int
})

/** The message queue of one agent session. Start from {@link initialQueueState}. */
export const QueueState = Schema.Union([QueueIdle, QueueRunning])
export type QueueState = typeof QueueState.Type

/** Send `messages` to the SDK as one turn, in order. */
export const DispatchAction = Schema.TaggedStruct('DispatchAction', { messages: Messages })

/** Interrupt the running turn. */
export const InterruptAction = Schema.TaggedStruct('InterruptAction', {})

/** Report the queue to the renderer. */
export const QueueChangedAction = Schema.TaggedStruct('QueueChangedAction', {
  queued: Messages,
  held: Schema.Boolean
})

/** A side effect a transition asks the session to perform, in list order. */
export const QueueAction = Schema.Union([DispatchAction, InterruptAction, QueueChangedAction])
export type QueueAction = typeof QueueAction.Type

/**
 * The result of a transition, in the `[result, next state]` order `Ref.modify` takes, so a
 * transition can be passed to `Ref.modify` directly.
 */
export type QueueTransition = readonly [ReadonlyArray<QueueAction>, QueueState]

/** The state of a session that has not sent anything. */
export const initialQueueState: QueueState = QueueIdle.make({ queued: [], held: false })

type Queued = ReadonlyArray<OutgoingMessage>

const heldFor = (queued: Queued, held: boolean) => held && queued.length > 0

const queueChanged = (queued: Queued, held: boolean) =>
  QueueChangedAction.make({ queued, held: heldFor(queued, held) })

const idle = (queued: Queued, held: boolean) =>
  QueueIdle.make({ queued, held: heldFor(queued, held) })

const running = (state: typeof QueueRunning.Type, changes: Partial<typeof QueueRunning.Type>) =>
  QueueRunning.make({ ...state, ...changes })

const dispatchNow = (messages: Queued, queued: Queued = [], held = false): QueueTransition => [
  [DispatchAction.make({ messages })],
  QueueRunning.make({ queued, held, steered: [], dispatching: 1 })
]

/**
 * A user sends `message` in `mode`. With no turn running it is dispatched at once, after any held
 * queue; during a turn `queue` appends it to the queue and `steer` interrupts the turn so the
 * message runs next. Either send during a turn releases a held queue.
 */
export const send =
  (message: OutgoingMessage, mode: 'queue' | 'steer') =>
  (state: QueueState): QueueTransition => {
    if (state._tag === 'QueueIdle') {
      const [actions, next] = dispatchNow([...state.queued, message])
      return [state.queued.length > 0 ? [queueChanged([], false), ...actions] : actions, next]
    }
    if (mode === 'queue') {
      const queued = [...state.queued, message]
      return [[queueChanged(queued, false)], running(state, { queued, held: false })]
    }
    if (state.steered.length > 0) {
      return [[], running(state, { steered: [...state.steered, message] })]
    }
    return [
      [InterruptAction.make({}), ...(state.held ? [queueChanged(state.queued, false)] : [])],
      running(state, { steered: [message], held: false })
    ]
  }

/**
 * The running turn ended; `ok` is false for a failed turn. Steered messages run next; otherwise the
 * queue runs next unless it is held or the turn failed, in which case it is held.
 */
export const turnEnded =
  (ok: boolean) =>
  (state: QueueState): QueueTransition => {
    if (state._tag === 'QueueIdle') return [[], state]
    if (state.steered.length > 0) {
      return [
        [DispatchAction.make({ messages: state.steered })],
        running(state, { steered: [], dispatching: state.dispatching + 1 })
      ]
    }
    if (state.queued.length > 0 && ok && !state.held) {
      return [
        [queueChanged([], false), DispatchAction.make({ messages: state.queued })],
        running(state, { queued: [], dispatching: state.dispatching + 1 })
      ]
    }
    if (state.queued.length > 0 && !ok) {
      return [[queueChanged(state.queued, true)], idle(state.queued, true)]
    }
    return [[], idle(state.queued, state.held)]
  }

/**
 * The user pressed stop. The running turn is interrupted and anything waiting for it is held until
 * the next user send.
 */
export const stopRequested = (state: QueueState): QueueTransition => {
  if (state._tag === 'QueueIdle') return [[InterruptAction.make({})], state]
  const queued = [...state.steered, ...state.queued]
  const held = queued.length > 0
  const changed = state.steered.length > 0 || held !== state.held
  return [
    [InterruptAction.make({}), ...(changed ? [queueChanged(queued, held)] : [])],
    running(state, { queued, held, steered: [] })
  ]
}

/** A `Dispatch` action finished offering its messages, or was skipped. */
export const dispatchEnded = (state: QueueState): QueueTransition =>
  state._tag === 'QueueIdle'
    ? [[], state]
    : [[], running(state, { dispatching: Math.max(0, state.dispatching - 1) })]

const replaceQueued = (state: QueueState, queued: Queued): QueueTransition => [
  [queueChanged(queued, state.held)],
  state._tag === 'QueueIdle'
    ? idle(queued, state.held)
    : running(state, { queued, held: heldFor(queued, state.held) })
]

/**
 * The user changed the text of queued message `id`. A message no longer queued is left alone, and
 * the current queue is reported so the renderer drops it.
 */
export const edit =
  (id: string, text: string) =>
  (state: QueueState): QueueTransition =>
    replaceQueued(
      state,
      state.queued.map((message) => (message.id === id ? { id, text } : message))
    )

/**
 * The user removed queued message `id`. A message no longer queued is left alone, and the current
 * queue is reported so the renderer drops it.
 */
export const remove =
  (id: string) =>
  (state: QueueState): QueueTransition =>
    replaceQueued(
      state,
      state.queued.filter((message) => message.id !== id)
    )

/**
 * The session rewound to a checkpoint and its query was replaced; the turn that was running is
 * gone. Steered messages join the front of the queue, which is held. The state stays running while
 * a `Dispatch` has not offered its messages yet.
 */
export const rewound = (state: QueueState): QueueTransition => {
  const queued = state._tag === 'QueueIdle' ? state.queued : [...state.steered, ...state.queued]
  const held = queued.length > 0
  const next =
    state._tag === 'QueueRunning' && state.dispatching > 0
      ? running(state, { queued, held, steered: [] })
      : idle(queued, held)
  return [[queueChanged(queued, held)], next]
}

/** The session ended; nothing queued will be sent. */
export const sessionEnded = (_state: QueueState): QueueTransition => [
  [queueChanged([], false)],
  initialQueueState
]

/** The queue as the renderer shows it. */
export const snapshotOf = (state: QueueState) => ({
  queued: state.queued,
  held: heldFor(state.queued, state.held)
})
