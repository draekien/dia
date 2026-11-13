import { SessionId } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/** Asks the example plugin's `host` entry for its greeting, optionally naming the session it is for. */
export const ReadGreeting = Rpc.make('ReadGreeting', {
  payload: { session: Schema.optional(SessionId) },
  success: Schema.String
})
