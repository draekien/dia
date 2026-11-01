import type { ConversationMessage, SessionId } from '@shared/domain/pane'
import { Context, Effect, Layer } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { type DiscoveredSession, resolveAgentBackend } from '../session/agent-backend'

/**
 * Service tag for reading a pane's past conversation, and the conversations a directory holds,
 * without spawning a live session. Depend on this to display a restored pane's history on startup
 * or to import a project's conversations; provide it via {@link TranscriptReaderLive}.
 */
export class TranscriptReader extends Context.Service<
  TranscriptReader,
  {
    /**
     * Reads the transcript for `sessionId` located under `cwd` (the pane's working
     * directory) and projects it to `ConversationMessage`s. Degrades to an empty list --
     * logging a warning -- when the transcript is missing or unreadable or no agent backend is
     * loaded, so callers never handle an error.
     */
    readonly readHistory: (
      sessionId: SessionId,
      cwd: string
    ) => Effect.Effect<ReadonlyArray<ConversationMessage>>
    /**
     * The conversations the loaded agent adapter holds for `directory`, in any order. Empty,
     * with a log line, when no adapter is loaded or the adapter cannot discover sessions. Never
     * fails.
     */
    readonly discoverSessions: (
      directory: string
    ) => Effect.Effect<ReadonlyArray<DiscoveredSession>>
  }
>()('TranscriptReader') {}

/**
 * Live {@link TranscriptReader} that reads through the agent backend the adapter plugin
 * provides, resolved on every read. Requires `HostPlugins`.
 */
export const TranscriptReaderLive = Layer.effect(
  TranscriptReader,
  Effect.gen(function* () {
    const plugins = yield* HostPlugins
    return {
      readHistory: Effect.fn('TranscriptReader.readHistory')(function* (
        sessionId: SessionId,
        cwd: string
      ) {
        const backend = yield* resolveAgentBackend(plugins)
        return yield* backend.readHistory(sessionId, cwd)
      }),
      discoverSessions: Effect.fn('TranscriptReader.discoverSessions')(function* (
        directory: string
      ) {
        const backend = yield* resolveAgentBackend(plugins)
        if (backend.discoverSessions === undefined) {
          yield* Effect.logDebug('The agent backend cannot discover sessions', { directory })
          return []
        }
        return yield* backend.discoverSessions(directory)
      })
    }
  })
)
