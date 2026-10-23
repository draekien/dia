import { Schema } from 'effect'

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
 * (`worktreesRoot`), where to write logs (`logFilePath`), whether this is a development build,
 * and which `Origin` values its WebSocket accepts (`allowedOrigins`). The Host starts listening
 * only after it receives this.
 */
export const HostInit = Schema.TaggedStruct('Init', {
  userDataPath: Schema.String,
  worktreesRoot: Schema.String,
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

/** Every message main may send to the Host over `parentPort`. */
export const MainToHostMessage = Schema.Union([HostInit, HostShutdown])
export type MainToHostMessage = typeof MainToHostMessage.Type

/**
 * Message the Host sends once its WebSocket is listening: the loopback `port` it bound and the
 * `token` clients must present. Neither travels through argv or environment variables.
 */
export const HostReady = Schema.TaggedStruct('Ready', {
  port: Schema.Number,
  token: Schema.String
})
export type HostReady = typeof HostReady.Type

/** Message the Host sends after finishing the shutdown requested by {@link HostShutdown}. */
export const HostShutdownComplete = Schema.TaggedStruct('ShutdownComplete', {})
export type HostShutdownComplete = typeof HostShutdownComplete.Type

/** Every message the Host may send to main over `parentPort`. */
export const HostToMainMessage = Schema.Union([HostBooted, HostReady, HostShutdownComplete])
export type HostToMainMessage = typeof HostToMainMessage.Type
