import { Schema } from 'effect'

/**
 * How a user message sent while a turn runs is delivered. `queue` holds it until the turn ends;
 * `steer` interrupts the turn and runs it next. With no turn running, both send at once.
 */
export const SendMode = Schema.Literals(['queue', 'steer'])
export type SendMode = typeof SendMode.Type

/** The send mode used when none has been persisted yet. */
export const DEFAULT_SEND_MODE: SendMode = 'queue'

/**
 * A user message the agent session has accepted but not yet answered. `id` is unique within the
 * pane and stays the same from creation until the message is sent; `text` is what the agent
 * receives.
 */
export const OutgoingMessage = Schema.Struct({ id: Schema.String, text: Schema.String })
export type OutgoingMessage = typeof OutgoingMessage.Type

/**
 * A pane's message queue, in send order. `held` is true when the queue waits for the next user
 * send instead of the next turn end (after a stop, a failed turn or a rewind); it is false
 * whenever `queued` is empty.
 */
export const MessageQueueSnapshot = Schema.Struct({
  queued: Schema.Array(OutgoingMessage),
  held: Schema.Boolean
})
export type MessageQueueSnapshot = typeof MessageQueueSnapshot.Type

/** The snapshot of a pane with nothing queued. */
export const EMPTY_MESSAGE_QUEUE: MessageQueueSnapshot = { queued: [], held: false }
