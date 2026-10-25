import { getSessionInfo, deleteSession as sdkDeleteSession } from '@anthropic-ai/claude-agent-sdk'
import { SessionDeleteError, type SessionId } from '@dia/plugin'
import { Effect } from 'effect'

/**
 * Deletes the local transcript of `sessionId` and its subagent transcripts through the Agent
 * SDK. Succeeds without deleting anything when the SDK finds no such session, so a repeated call
 * is safe. Fails with {@link SessionDeleteError} when the SDK cannot look up or delete it.
 */
export const deleteSession = Effect.fn('ClaudeCode.deleteSession')(function* (
  sessionId: SessionId
) {
  const fail = (cause: unknown) => new SessionDeleteError({ sessionId, reason: String(cause) })
  const info = yield* Effect.tryPromise({ try: () => getSessionInfo(sessionId), catch: fail })
  if (info === undefined) {
    yield* Effect.logInfo('No transcript to delete', { sessionId })
    return
  }
  yield* Effect.tryPromise({ try: () => sdkDeleteSession(sessionId), catch: fail })
  yield* Effect.logInfo('Deleted transcript', { sessionId })
})
