import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import { McpServerNameTaken, RegisteredServer } from './registry'
import { McpServers } from './servers'

/** Streams every server the registry holds: the current list, then the list after each change. */
export const WatchServers = Rpc.make('WatchServers', {
  payload: {},
  success: Schema.Array(RegisteredServer),
  stream: true
})

/**
 * Replaces the user's servers with `servers`. Refused as a whole, with nothing saved, when a
 * plugin holds any name in `servers`.
 */
export const SaveUserServers = Rpc.make('SaveUserServers', {
  payload: { servers: McpServers },
  error: McpServerNameTaken
})
