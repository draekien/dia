import {
  getSessionInfo,
  getSessionMessages,
  type SessionMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  AgentEvents,
  ContentAttachment,
  type TranscriptEntry,
  type TranscriptInfo,
  type TranscriptTail
} from '@dia/plugin'
import type { AgentEvent } from '@shared/domain/agent-event'
import type { Attachment } from '@shared/domain/attachment'
import type { ConversationMessage, SessionId } from '@shared/domain/pane'
import { Array as Arr, Data, Effect, Option, Schema } from 'effect'
import { flattenToolResultContent } from './reducer'

const TextBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String
})
const decodeTextBlock = Schema.decodeUnknownOption(TextBlock)

const ImageBlock = Schema.Struct({
  type: Schema.Literal('image'),
  source: Schema.Struct({
    type: Schema.Literal('base64'),
    media_type: Schema.String,
    data: Schema.String
  })
})
const decodeImageBlock = Schema.decodeUnknownOption(ImageBlock)
const decodeToolResult = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal('tool_result') })
)

const imagesOf = (content: ReadonlyArray<unknown>): ReadonlyArray<Attachment> =>
  content
    .flatMap((block) => Option.toArray(decodeImageBlock(block)))
    .map((image, index) =>
      ContentAttachment.make({
        name: `image-${index + 1}`,
        mediaType: image.source.media_type,
        data: image.source.data
      })
    )

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

const isTaskNotification = (text: string): boolean =>
  text.trimStart().startsWith('<task-notification>')

/**
 * Projects the Agent SDK's raw session transcript into dia's `ConversationMessage`
 * list: keeps user/assistant turns that carry displayable text, joining an
 * assistant turn's text blocks and dropping tool-only turns (tool calls/results
 * with no text), background task reports (user turns starting with `<task-notification>`,
 * which a live transcript does not show either) and any message whose shape it can't decode.
 * Use to render a restored pane's history from {@link getSessionMessages} output.
 *
 * A user turn's image blocks become its `attachments`, named `image-1`, `image-2` in order.
 * A rewindable user turn (string content, or image blocks with no tool result) is anchored with its own uuid as
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
    conversation.push(...Option.toArray(conversationMessageOf(envelope, message.uuid, anchorUuid)))
  }
  return conversation
}

const conversationMessageOf = (
  envelope: typeof MessageEnvelope.Type,
  uuid: string,
  anchorUuid: string | undefined
): Option.Option<ConversationMessage> => {
  const content = extractText(envelope.content)
  if (envelope.role === 'user' && isTaskNotification(content)) return Option.none()
  const images =
    envelope.role === 'user' && typeof envelope.content !== 'string'
      ? imagesOf(envelope.content)
      : []
  const isToolResult =
    typeof envelope.content !== 'string' &&
    envelope.content.some((block) => Option.isSome(decodeToolResult(block)))
  if (content.length === 0 && images.length === 0) return Option.none()
  if (
    envelope.role === 'user' &&
    (typeof envelope.content === 'string' || (images.length > 0 && !isToolResult))
  ) {
    return Option.some({
      role: 'user',
      content,
      ...(images.length > 0 ? { attachments: images } : {}),
      checkpointUuid: uuid,
      ...(anchorUuid !== undefined ? { resumeAnchorUuid: anchorUuid } : {})
    })
  }
  return Option.some({ role: envelope.role, content })
}

const ThinkingBlock = Schema.Struct({ type: Schema.Literal('thinking'), thinking: Schema.String })
const decodeThinkingBlock = Schema.decodeUnknownOption(ThinkingBlock)

const ToolUseBlock = Schema.Struct({
  type: Schema.Literal('tool_use'),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown
})
const decodeToolUseBlock = Schema.decodeUnknownOption(ToolUseBlock)

const ToolResultBlock = Schema.Struct({
  type: Schema.Literal('tool_result'),
  tool_use_id: Schema.String,
  content: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))
    ])
  ),
  is_error: Schema.optional(Schema.Boolean)
})
const decodeToolResultBlock = Schema.decodeUnknownOption(ToolResultBlock)

const decodeToolInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

interface ToolCallStart {
  readonly toolName: string
  readonly input: Record<string, unknown>
}

const decodedBlocks = <A>(
  content: string | ReadonlyArray<unknown>,
  decode: (block: unknown) => Option.Option<A>
): ReadonlyArray<A> =>
  typeof content === 'string' ? [] : Arr.getSomes(content.map((block) => decode(block)))

const messageEvents = (
  envelope: typeof MessageEnvelope.Type,
  uuid: string,
  anchorUuid: string | undefined
): ReadonlyArray<AgentEvent> =>
  Option.toArray(conversationMessageOf(envelope, uuid, anchorUuid)).map((message) =>
    AgentEvents.MessageUpdated.make({ itemId: uuid, message, streaming: false })
  )

const assistantEvents = (
  envelope: typeof MessageEnvelope.Type,
  uuid: string,
  toolCalls: Map<string, ToolCallStart>
): ReadonlyArray<AgentEvent> => {
  const thinking = decodedBlocks(envelope.content, decodeThinkingBlock)
    .map((block) => block.thinking)
    .join('')
  const reasoning =
    thinking.length > 0
      ? [
          AgentEvents.ReasoningUpdated.make({
            itemId: `${uuid}:thinking`,
            text: thinking,
            streaming: false
          })
        ]
      : []
  const started = decodedBlocks(envelope.content, decodeToolUseBlock).map((toolUse) => {
    toolCalls.set(toolUse.id, {
      toolName: toolUse.name,
      input: Option.getOrElse(decodeToolInput(toolUse.input), () => ({}))
    })
    return AgentEvents.ToolCallStarted.make({ toolCallId: toolUse.id, toolName: toolUse.name })
  })
  return [...reasoning, ...messageEvents(envelope, uuid, undefined), ...started]
}

const userEvents = (
  envelope: typeof MessageEnvelope.Type,
  uuid: string,
  anchorUuid: string | undefined,
  toolCalls: ReadonlyMap<string, ToolCallStart>
): ReadonlyArray<AgentEvent> => {
  const completed = decodedBlocks(envelope.content, decodeToolResultBlock).flatMap((result) => {
    const start = toolCalls.get(result.tool_use_id)
    if (start === undefined) return []
    return [
      AgentEvents.ToolCallCompleted.make({
        toolCallId: result.tool_use_id,
        toolName: start.toolName,
        input: start.input,
        output: AgentEvents.capToolOutput(flattenToolResultContent(result.content)),
        isError: result.is_error ?? false
      })
    ]
  })
  return [...messageEvents(envelope, uuid, anchorUuid), ...completed]
}

/**
 * Maps `messages`, the whole active chain of a session as `getSessionMessages` returns it, to
 * agent events in transcript order, and returns those from the messages after `afterUuid`; all of
 * them when `afterUuid` is none or not among `messages`. Each entry's `sourceUuid` is its
 * message's uuid. User turns follow {@link sessionMessagesToConversation}'s rules; an assistant
 * message yields its thinking (`ReasoningUpdated`, item `<uuid>:thinking`), its text
 * (`MessageUpdated`, item `<uuid>`) and its tool calls (`ToolCallStarted`, item = tool use id), each
 * only when present; a tool result yields `ToolCallCompleted` with the input of its tool use and
 * its output capped by `capToolOutput`. Subagent messages are left out.
 */
export const transcriptEntriesAfter = (
  messages: ReadonlyArray<SessionMessage>,
  afterUuid: Option.Option<string>
): ReadonlyArray<TranscriptEntry> => {
  const start = Option.match(afterUuid, {
    onNone: () => 0,
    onSome: (uuid) => messages.findIndex((message) => message.uuid === uuid) + 1
  })
  const toolCalls = new Map<string, ToolCallStart>()
  const entries: TranscriptEntry[] = []
  let anchorUuid: string | undefined
  messages.forEach((message, index) => {
    const envelopeOpt = decodeEnvelope(message.message)
    if (message.parent_tool_use_id !== null || Option.isNone(envelopeOpt)) return
    const envelope = envelopeOpt.value
    const events =
      envelope.role === 'assistant'
        ? assistantEvents(envelope, message.uuid, toolCalls)
        : userEvents(envelope, message.uuid, anchorUuid, toolCalls)
    if (envelope.role === 'assistant') anchorUuid = message.uuid
    if (index < start) return
    entries.push(...events.map((event) => ({ event, sourceUuid: message.uuid })))
  })
  return entries
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

/**
 * The claude-code adapter's `AgentBackend.transcriptInfo`: the size and modification time of the
 * transcript of `sessionId` under `cwd`, without reading its entries. None, logging a warning, when
 * the SDK finds no transcript, reports no file size, or the read fails.
 */
export const transcriptInfo = Effect.fn('ClaudeCode.transcriptInfo')(
  function* (sessionId: SessionId, cwd: string) {
    const info = yield* Effect.tryPromise(() => getSessionInfo(sessionId, { dir: cwd }))
    if (info?.fileSize === undefined) {
      yield* Effect.logWarning('Found no readable session transcript', { sessionId, cwd })
      return Option.none<TranscriptInfo>()
    }
    return Option.some<TranscriptInfo>({ fileSize: info.fileSize, mtimeMs: info.lastModified })
  },
  (effect, sessionId) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning('Failed to read session transcript info', { sessionId, cause }).pipe(
          Effect.as(Option.none<TranscriptInfo>())
        )
      )
    )
)

/**
 * The claude-code adapter's `AgentBackend.readTranscriptAfter`: reads the transcript of
 * `sessionId` under `cwd` and returns {@link transcriptEntriesAfter} of it with the
 * {@link transcriptInfo} read first. None, logging a warning, when that info is none or the read of
 * the entries fails. Logs a warning when `afterUuid` is not in the transcript, and then returns
 * every entry.
 */
export const readTranscriptAfter = Effect.fn('ClaudeCode.readTranscriptAfter')(
  function* (sessionId: SessionId, cwd: string, afterUuid: Option.Option<string>) {
    const info = yield* transcriptInfo(sessionId, cwd)
    if (Option.isNone(info)) return Option.none<TranscriptTail>()
    const messages = yield* Effect.tryPromise(() => getSessionMessages(sessionId, { dir: cwd }))
    if (Option.isSome(afterUuid) && !messages.some((message) => message.uuid === afterUuid.value)) {
      yield* Effect.logWarning(
        'The transcript cursor is not in the transcript; reading every entry',
        {
          sessionId,
          afterUuid: afterUuid.value
        }
      )
    }
    const entries = transcriptEntriesAfter(messages, afterUuid)
    yield* Effect.logDebug('Read transcript entries', {
      sessionId,
      afterUuid: Option.getOrUndefined(afterUuid),
      entries: entries.length
    })
    return Option.some<TranscriptTail>({ ...info.value, entries })
  },
  (effect, sessionId) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning('Failed to read session transcript', { sessionId, cause }).pipe(
          Effect.as(Option.none<TranscriptTail>())
        )
      )
    )
)

/**
 * Failure of {@link readTurnResumeAnchor}: the user turn `messageUuid` is not in the transcript of
 * `sessionId`, which includes a transcript that is missing or unreadable.
 */
export class TurnNotInTranscriptError extends Data.TaggedError('TurnNotInTranscriptError')<{
  readonly sessionId: SessionId
  readonly messageUuid: string
}> {}

/**
 * Reads the transcript of `sessionId` under `cwd` and returns the uuid a rewind of the user turn
 * `messageUuid` resumes from: the last assistant message before that turn, or none when the turn
 * is the first of the conversation. Fails with {@link TurnNotInTranscriptError} when the turn is
 * not in the transcript.
 */
export const readTurnResumeAnchor = Effect.fn('ClaudeCode.readTurnResumeAnchor')(function* (
  sessionId: SessionId,
  cwd: string,
  messageUuid: string
) {
  const messages = yield* readSessionMessages(sessionId, cwd)
  const turn = messages.findIndex((message) => message.uuid === messageUuid)
  if (turn === -1) return yield* new TurnNotInTranscriptError({ sessionId, messageUuid })
  const anchor = lastAssistantUuid(messages.slice(0, turn))
  yield* Effect.logDebug('Read the resume anchor of a user turn', {
    sessionId,
    messageUuid,
    anchor: Option.getOrUndefined(anchor)
  })
  return anchor
})
