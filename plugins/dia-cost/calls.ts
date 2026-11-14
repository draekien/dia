import { TokenUsage } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/**
 * Turn `turn` of a run, counting from 1 at each message sent, the ids of the messages sent to
 * start it (as the chat transcript's user messages carry them; none for usage reported before any
 * message), the first line of its prompt (`''` when none), and the tokens its main agent loop has
 * used so far: 0 until the turn ends.
 */
export const TurnUsage = Schema.Struct({
  turn: Schema.Int,
  messageIds: Schema.Array(Schema.String),
  prompt: Schema.String,
  usage: TokenUsage
})
/** One turn's usage; see {@link TurnUsage}. */
export type TurnUsage = typeof TurnUsage.Type

/**
 * Every turn of a run in order, including turns still running and turns from before dia recorded
 * usage, which have 0 tokens, and the sum of their tokens.
 */
export const RunUsage = Schema.Struct({
  turns: Schema.Array(TurnUsage),
  total: TokenUsage
})
/** A run's usage; see {@link RunUsage}. */
export type RunUsage = typeof RunUsage.Type

/**
 * Run `runId`'s usage now, then again after each message sent to the run and each usage it
 * reports. Emits one value with no turns while run events are not provided or the run's log
 * cannot be read.
 */
export const FollowRunUsage = Rpc.make('FollowRunUsage', {
  payload: { runId: Schema.String },
  success: RunUsage,
  stream: true
})
