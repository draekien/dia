import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import { Skill } from './registry'

/**
 * Streams every registered source's skills, adding the skills of the project at `cwd` when it is
 * set: the current list, then the list after each change.
 */
export const WatchSkills = Rpc.make('WatchSkills', {
  payload: { cwd: Schema.optionalKey(Schema.String) },
  success: Schema.Array(Skill),
  stream: true
})
