import { Schema } from 'effect'

/**
 * An OS notification about one agent. `title` and `body` are the text the OS shows; clicking the
 * notification shows the tab of `paneId`. Plugins pass one to `ctx.window.notify`.
 */
export const AgentNotification = Schema.Struct({
  paneId: Schema.String,
  title: Schema.String,
  body: Schema.String
})
export type AgentNotification = typeof AgentNotification.Type
