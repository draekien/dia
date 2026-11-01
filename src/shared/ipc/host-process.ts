import { Schema } from 'effect'
import { AgentNotification } from '../domain/notification'

/**
 * First message the Host sends: it has registered its module loader and is listening on
 * `parentPort`. Main replies with {@link HostInit} only after receiving it, because a message
 * posted earlier could be lost.
 */
export const HostBooted = Schema.TaggedStruct('Booted', {})
export type HostBooted = typeof HostBooted.Type

/**
 * Message main sends to the Host over `parentPort`, carrying everything the Host needs
 * that main alone knows: where to keep state (`userDataPath`), where per-pane git worktrees live
 * (`worktreesRoot`), where the plugins shipped with dia live (`pluginsRoot`), the built module plugins import as `@dia/plugin` (`pluginApiPath`), where to write logs (`logFilePath`), whether this is a development build,
 * and which `Origin` values its WebSocket accepts (`allowedOrigins`). The Host starts listening
 * only after it receives this.
 */
export const HostInit = Schema.TaggedStruct('Init', {
  userDataPath: Schema.String,
  worktreesRoot: Schema.String,
  pluginsRoot: Schema.String,
  pluginApiPath: Schema.String,
  logFilePath: Schema.String,
  isDev: Schema.Boolean,
  allowedOrigins: Schema.Array(Schema.String)
})
export type HostInit = typeof HostInit.Type

/**
 * Message main sends to the Host to ask it to end every pane's session, remove worktrees and
 * reply with {@link HostShutdownComplete}, so quitting never leaves a pane to be killed and
 * reported as a crash.
 */
export const HostShutdown = Schema.TaggedStruct('Shutdown', {})
export type HostShutdown = typeof HostShutdown.Type

/**
 * Message main sends to the Host whenever the user may have started or stopped looking at dia's
 * window, and once after every Host start: `attended` is true while the window is shown, not
 * minimised and focused.
 */
export const WindowAttention = Schema.TaggedStruct('WindowAttention', { attended: Schema.Boolean })
export type WindowAttention = typeof WindowAttention.Type

/** Message main sends to the Host when the user clicks an agent's notification: show `paneId`'s tab. */
export const ShowAgent = Schema.TaggedStruct('ShowAgent', { paneId: Schema.String })
export type ShowAgent = typeof ShowAgent.Type

/** Every message main may send to the Host over `parentPort`. */
export const MainToHostMessage = Schema.Union([HostInit, HostShutdown, WindowAttention, ShowAgent])
export type MainToHostMessage = typeof MainToHostMessage.Type

/**
 * Message the Host sends once its WebSocket is listening: the loopback `port` it bound and the
 * `token` clients must present. Neither travels through argv or environment variables.
 */
export const HostReady = Schema.TaggedStruct('Ready', {
  port: Schema.Finite,
  token: Schema.String
})
export type HostReady = typeof HostReady.Type

/** Message the Host sends after finishing the shutdown requested by {@link HostShutdown}. */
export const HostShutdownComplete = Schema.TaggedStruct('ShutdownComplete', {})
export type HostShutdownComplete = typeof HostShutdownComplete.Type

/** Message the Host sends to have main show `notification` as an OS notification. */
export const Notify = Schema.TaggedStruct('Notify', { notification: AgentNotification })
export type Notify = typeof Notify.Type

/** Every message the Host may send to main over `parentPort`. */
export const HostToMainMessage = Schema.Union([HostBooted, HostReady, HostShutdownComplete, Notify])
export type HostToMainMessage = typeof HostToMainMessage.Type
