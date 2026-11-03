import type { ConversationMessage, SessionId } from '@shared/domain/pane'
import { Context, Effect, Layer, type Option } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import {
  type DiscoveredSession,
  resolveAgentBackend,
  type TranscriptInfo,
  type TranscriptTail
} from '../session/agent-backend'

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
    /**
     * The size and mtime of `sessionId`'s transcript under `cwd`, without reading its entries.
     * None, with a log line, when there is no readable transcript or no adapter is loaded. Never
     * fails.
     */
    readonly transcriptInfo: (
      sessionId: SessionId,
      cwd: string
    ) => Effect.Effect<Option.Option<TranscriptInfo>>
    /**
     * The events of `sessionId`'s transcript under `cwd` that follow the entry `afterUuid` (every
     * entry when none, or when that entry is not found), with the transcript file's size and
     * mtime. None, with a log line, when the transcript cannot be read or no adapter is loaded.
     * Never fails.
     */
    readonly readTranscriptAfter: (
      sessionId: SessionId,
      cwd: string,
      afterUuid: Option.Option<string>
    ) => Effect.Effect<Option.Option<TranscriptTail>>
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
      }),
      transcriptInfo: Effect.fn('TranscriptReader.transcriptInfo')(function* (
        sessionId: SessionId,
        cwd: string
      ) {
        const backend = yield* resolveAgentBackend(plugins)
        return yield* backend.transcriptInfo(sessionId, cwd)
      }),
      readTranscriptAfter: Effect.fn('TranscriptReader.readTranscriptAfter')(function* (
        sessionId: SessionId,
        cwd: string,
        afterUuid: Option.Option<string>
      ) {
        const backend = yield* resolveAgentBackend(plugins)
        return yield* backend.readTranscriptAfter(sessionId, cwd, afterUuid)
      })
    }
  })
)
