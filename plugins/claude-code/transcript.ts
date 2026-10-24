import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ConversationMessage, SessionId } from '@shared/domain/pane'
import { Effect, Option, Schema } from 'effect'

const TextBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String
})
const decodeTextBlock = Schema.decodeUnknownOption(TextBlock)

const MessageEnvelope = Schema.Struct({
  role: Schema.Literals(['user', 'assistant']),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])
})
const decodeEnvelope = Schema.decodeUnknownOption(MessageEnvelope)

const emptyHistory: ReadonlyArray<ConversationMessage> = []

const extractText = (content: string | ReadonlyArray<unknown>): string =>
  typeof content === 'string'
    ? content
    : content
        .map((block) =>
          Option.match(decodeTextBlock(block), { onNone: () => '', onSome: (b) => b.text })
        )
        .join('')

/**
 * Projects the Agent SDK's raw session transcript into dia's `ConversationMessage`
 * list: keeps user/assistant turns that carry displayable text, joining an
 * assistant turn's text blocks and dropping tool-only turns (tool calls/results
 * with no text) and any message whose shape it can't decode. Use to render a
 * restored pane's history from {@link getSessionMessages} output.
 *
 * A rewindable user turn (string content) is anchored with its own uuid as
 * `checkpointUuid` and the most recent assistant turn's uuid as
 * `resumeAnchorUuid` (absent for the first turn), so a restored pane offers the
 * same rewind behaviour a live one does — mirroring the live reducer's anchoring.
 */
export const sessionMessagesToConversation = (
  messages: ReadonlyArray<SessionMessage>
): ReadonlyArray<ConversationMessage> => {
  const conversation: ConversationMessage[] = []
  let lastAssistantUuid: string | undefined
  for (const message of messages) {
    const envelopeOpt = decodeEnvelope(message.message)
    if (Option.isNone(envelopeOpt)) continue
    const envelope = envelopeOpt.value
    if (envelope.role === 'assistant') lastAssistantUuid = message.uuid
    const content = extractText(envelope.content)
    if (content.length === 0) continue
    if (envelope.role === 'user' && typeof envelope.content === 'string') {
      conversation.push({
        role: 'user',
        content,
        checkpointUuid: message.uuid,
        ...(lastAssistantUuid !== undefined ? { resumeAnchorUuid: lastAssistantUuid } : {})
      })
    } else {
      conversation.push({ role: envelope.role, content })
    }
  }
  return conversation
}

/**
 * Reads the transcript for `sessionId` located under `cwd` (the pane's working directory, which
 * the SDK keys sessions by) and projects it with {@link sessionMessagesToConversation}. Returns an
 * empty list, logging a warning, when the session file is missing or unreadable.
 */
export const readHistory = Effect.fn('ClaudeCode.readHistory')(function* (
  sessionId: SessionId,
  cwd: string
) {
  return yield* Effect.tryPromise(() => getSessionMessages(sessionId, { dir: cwd })).pipe(
    Effect.map(sessionMessagesToConversation),
    Effect.catch((cause) =>
      Effect.logWarning('Failed to read session transcript', { sessionId, cause }).pipe(
        Effect.as(emptyHistory)
      )
    )
  )
})
