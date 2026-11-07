import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/** Asks the example plugin's `host` entry for its greeting. */
export const ReadGreeting = Rpc.make('ReadGreeting', { payload: {}, success: Schema.String })
