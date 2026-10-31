import { Schema } from 'effect'

/**
 * A slash command available in a pane's live Agent SDK session, surfaced to the
 * renderer to drive the `/` command popover. `name` is the command without its
 * leading slash; a plugin command's `name` carries its plugin prefix
 * (`productivity-skills:get-aligned`). `aliases` are other names that run the
 * same command (`get-aligned`), empty when it has none. `description` and
 * `argumentHint` are human-facing hints,
 * populated from the session's `query.supportedCommands()` warm-up at start and
 * refreshed by any later `commands_changed` message; either may be an empty
 * string when a command declares none. Consumers should treat every arriving
 * list as the complete, replacement set.
 */
export const SlashCommandInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.String,
  aliases: Schema.Array(Schema.String)
})
export type SlashCommandInfo = typeof SlashCommandInfo.Type
