import { Attention } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/**
 * One open request of run `runId`, which works in `cwd` (empty when `dia-runs` holds no row for
 * it). Answer it with `dia-runs`' call for the request's `_tag`.
 */
export const InboxItem = Schema.Struct({
  runId: Schema.String,
  cwd: Schema.String,
  request: Attention.UserInputRequest
})
export type InboxItem = typeof InboxItem.Type

/** Every open request of every run, now and after each change; empty while no plugin provides runs. */
export const FollowInbox = Rpc.make('FollowInbox', {
  payload: {},
  success: Schema.Array(InboxItem),
  stream: true
})
