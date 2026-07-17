import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ConversationMessage } from '@shared/domain/pane'
import { Context, Effect, Layer, Option, Schema } from 'effect'

const TextBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String
})
const decodeTextBlock = Schema.decodeUnknownOption(TextBlock)

const MessageEnvelope = Schema.Struct({
  role: Schema.Literal('user', 'assistant'),
  content: Schema.Union(Schema.String, Schema.Array(Schema.Unknown))
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

const toConversationMessage = (message: SessionMessage): Option.Option<ConversationMessage> =>
  Option.flatMap(decodeEnvelope(message.message), (envelope) => {
    const content = extractText(envelope.content)
    return content.length === 0 ? Option.none() : Option.some({ role: envelope.role, content })
  })

/**
 * Projects the Agent SDK's raw session transcript into dia's `ConversationMessage`
 * list: keeps user/assistant turns that carry displayable text, joining an
 * assistant turn's text blocks and dropping tool-only turns (tool calls/results
 * with no text) and any message whose shape it can't decode. Use to render a
 * restored pane's history from {@link getSessionMessages} output.
 */
export const sessionMessagesToConversation = (
  messages: ReadonlyArray<SessionMessage>
): ReadonlyArray<ConversationMessage> =>
  messages.flatMap((message) =>
    Option.match(toConversationMessage(message), { onNone: () => [], onSome: (c) => [c] })
  )

/**
 * Service tag for reading a pane's past conversation from the Agent SDK session
 * store without spawning a live session. Depend on this to display a restored
 * pane's history on startup; provide it via {@link TranscriptReaderLive}.
 */
export class TranscriptReader extends Context.Tag('TranscriptReader')<
  TranscriptReader,
  {
    /**
     * Reads the transcript for `sessionId` located under `cwd` (the pane's working
     * directory, which the SDK keys sessions by) and projects it to
     * `ConversationMessage`s. Degrades to an empty list -- logging a warning -- when
     * the session file is missing or unreadable, so callers never handle an error.
     */
    readonly readHistory: (
      sessionId: string,
      cwd: string
    ) => Effect.Effect<ReadonlyArray<ConversationMessage>>
  }
>() {}

/**
 * Live {@link TranscriptReader} backed by the Agent SDK's on-disk session store
 * ({@link getSessionMessages}). Provide this at the composition root wherever
 * `TranscriptReader` is required.
 */
export const TranscriptReaderLive = Layer.succeed(TranscriptReader, {
  readHistory: Effect.fn('TranscriptReader.readHistory')(function* (
    sessionId: string,
    cwd: string
  ) {
    return yield* Effect.tryPromise(() => getSessionMessages(sessionId, { dir: cwd })).pipe(
      Effect.map(sessionMessagesToConversation),
      Effect.catchAll((cause) =>
        Effect.logWarning('Failed to read session transcript', { sessionId, cause }).pipe(
          Effect.as(emptyHistory)
        )
      )
    )
  })
})
