import { TokenUsage } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/**
 * Turn `turn` of a run, counting from 1, the first line of its prompt (`''` when the turn had no
 * message of its own, such as a resumed parked turn), and the tokens its main agent loop used.
 */
export const TurnUsage = Schema.Struct({
  turn: Schema.Int,
  prompt: Schema.String,
  usage: TokenUsage
})
/** One turn's usage; see {@link TurnUsage}. */
export type TurnUsage = typeof TurnUsage.Type

/** A run's turns that reported usage, in order, and the sum of their tokens. */
export const RunUsage = Schema.Struct({
  turns: Schema.Array(TurnUsage),
  total: TokenUsage
})
/** A run's usage; see {@link RunUsage}. */
export type RunUsage = typeof RunUsage.Type

/**
 * Run `runId`'s usage now, then again after each turn of the run that reports usage. Emits one
 * value with no turns while run events are not provided or the run's log cannot be read.
 */
export const FollowRunUsage = Rpc.make('FollowRunUsage', {
  payload: { runId: Schema.String },
  success: RunUsage,
  stream: true
})
