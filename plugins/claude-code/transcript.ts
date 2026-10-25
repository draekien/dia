import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ConversationMessage, SessionId } from '@shared/domain/pane'
import { Array as Arr, Effect, Option, Schema } from 'effect'

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

const emptyMessages: ReadonlyArray<SessionMessage> = []

const isAssistantMessage = (message: SessionMessage): boolean =>
  Option.exists(decodeEnvelope(message.message), (envelope) => envelope.role === 'assistant')

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
  let anchorUuid: string | undefined
  for (const message of messages) {
    const envelopeOpt = decodeEnvelope(message.message)
    if (Option.isNone(envelopeOpt)) continue
    const envelope = envelopeOpt.value
    if (envelope.role === 'assistant') anchorUuid = message.uuid
    const content = extractText(envelope.content)
    if (content.length === 0) continue
    if (envelope.role === 'user' && typeof envelope.content === 'string') {
      conversation.push({
        role: 'user',
        content,
        checkpointUuid: message.uuid,
        ...(anchorUuid !== undefined ? { resumeAnchorUuid: anchorUuid } : {})
      })
    } else {
      conversation.push({ role: envelope.role, content })
    }
  }
  return conversation
}

/**
 * The uuid of the last assistant message in `messages`, or none when there is none. A user turn
 * sent after these messages branches from this uuid when it is rewound. Applies the same rule
 * {@link sessionMessagesToConversation} uses for `resumeAnchorUuid`.
 */
export const lastAssistantUuid = (messages: ReadonlyArray<SessionMessage>): Option.Option<string> =>
  Option.map(Arr.findLast(messages, isAssistantMessage), (message) => message.uuid)

const readSessionMessages = Effect.fn('ClaudeCode.readSessionMessages')(function* (
  sessionId: SessionId,
  cwd: string
) {
  return yield* Effect.tryPromise(() => getSessionMessages(sessionId, { dir: cwd })).pipe(
    Effect.catch((cause) =>
      Effect.logWarning('Failed to read session transcript', { sessionId, cause }).pipe(
        Effect.as(emptyMessages)
      )
    )
  )
})

/**
 * Reads the transcript for `sessionId` located under `cwd` (the pane's working directory, which
 * the SDK keys sessions by) and projects it with {@link sessionMessagesToConversation}. Returns an
 * empty list, logging a warning, when the session file is missing or unreadable.
 */
export const readHistory = Effect.fn('ClaudeCode.readHistory')(function* (
  sessionId: SessionId,
  cwd: string
) {
  return sessionMessagesToConversation(yield* readSessionMessages(sessionId, cwd))
})

/**
 * Reads the transcript of `sessionId` under `cwd` and returns {@link lastAssistantUuid} of it.
 * Returns none, logging a warning, when the transcript is missing or unreadable.
 */
export const readLastAssistantUuid = Effect.fn('ClaudeCode.readLastAssistantUuid')(function* (
  sessionId: SessionId,
  cwd: string
) {
  const uuid = lastAssistantUuid(yield* readSessionMessages(sessionId, cwd))
  yield* Effect.logDebug('Read the last assistant message of a transcript', {
    sessionId,
    uuid: Option.getOrUndefined(uuid)
  })
  return uuid
})
