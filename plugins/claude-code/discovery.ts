// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path comparison inside a synchronous filter, with no I/O.
import { relative } from 'node:path'
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { type DiscoveredSession, SessionId } from '@dia/plugin'
import { Effect } from 'effect'

const DEFAULT_MODEL = 'default'

const isIn = (directory: string) => (info: SDKSessionInfo) =>
  info.cwd === undefined || relative(info.cwd, directory) === ''

/**
 * The {@link DiscoveredSession}s for `directory` among `infos`, the rows `listSessions` returned
 * for it. Leaves out a session whose working directory is another directory. Each session is
 * titled by its custom title, else its summary, starts at its creation time, else its last
 * change, and resumes on Claude Code's default model.
 */
export const toDiscoveredSessions = (
  infos: ReadonlyArray<SDKSessionInfo>,
  directory: string
): ReadonlyArray<DiscoveredSession> =>
  infos.filter(isIn(directory)).map((info) => ({
    sessionId: SessionId.make(info.sessionId),
    title: info.customTitle ?? info.summary,
    startedAt: info.createdAt ?? info.lastModified,
    model: DEFAULT_MODEL
  }))

/**
 * The conversations Claude Code holds whose working directory is `directory`, including those
 * started from the `claude` CLI and not including those of the directory's other git worktrees.
 * Returns an empty list, logging a warning, when they cannot be listed.
 */
export const discoverSessions = Effect.fn('ClaudeCode.discoverSessions')(function* (
  directory: string
) {
  const infos = yield* Effect.tryPromise(() =>
    listSessions({ dir: directory, includeWorktrees: false })
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning('Failed to list the sessions of a directory', { directory, cause }).pipe(
        Effect.as<ReadonlyArray<SDKSessionInfo>>([])
      )
    )
  )
  const sessions = toDiscoveredSessions(infos, directory)
  yield* Effect.logDebug('Discovered the sessions of a directory', {
    directory,
    listed: infos.length,
    discovered: sessions.length
  })
  return sessions
})
