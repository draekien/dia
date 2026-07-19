import { Schema } from 'effect'

/**
 * A slash command available in a pane's live Agent SDK session, surfaced to the
 * renderer to drive the `/` command popover. `name` is the command without its
 * leading slash. `description` and `argumentHint` are human-facing hints that
 * may be empty strings when only the command name is known: the session's
 * `init` message reports names only, while a later `commands_changed` message
 * enriches the same commands with descriptions and argument hints. Consumers
 * should treat every arriving list as the complete, replacement set.
 */
export const SlashCommandInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.String
})
export type SlashCommandInfo = typeof SlashCommandInfo.Type
