import type {
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneAttentionChanged,
  PaneMessageAppended,
  PaneToolCallCompleted,
  PaneToolCallStarted
} from '@shared/ipc/contract'
import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai/client'
import {
  type ConnectConnectionAdapter,
  generateMessageId,
  type UIMessage
} from '@tanstack/ai-client'
import { Effect, Stream } from 'effect'

type PaneStreamEvent =
  | PaneAssistantTextDelta
  | PaneAssistantThinkingDelta
  | PaneToolCallStarted
  | PaneToolCallCompleted
  | PaneMessageAppended
  | PaneAttentionChanged

const latestUserText = (messages: ReadonlyArray<UIMessage | ModelMessage>): string => {
  const message = messages.at(-1)
  if (message === undefined) return ''
  if ('parts' in message) {
    return message.parts.reduce(
      (text, part) => (part.type === 'text' ? text + part.content : text),
      ''
    )
  }
  if (typeof message.content === 'string') return message.content
  if (message.content === null) return ''
  return message.content.reduce(
    (text, part) => (part.type === 'text' ? text + part.content : text),
    ''
  )
}

const runStarted = (threadId: string, runId: string): StreamChunk => ({
  type: EventType.RUN_STARTED,
  threadId,
  runId
})

const runFinished = (threadId: string, runId: string): StreamChunk => ({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  finishReason: 'stop'
})

const runError = (threadId: string, runId: string, message: string): StreamChunk => ({
  type: EventType.RUN_ERROR,
  threadId,
  runId,
  message
})

const textStart = (messageId: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_START,
  messageId,
  role: 'assistant'
})

const textContent = (messageId: string, delta: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId,
  delta
})

const textEnd = (messageId: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_END,
  messageId
})

const reasoningStart = (messageId: string): StreamChunk => ({
  type: EventType.REASONING_MESSAGE_START,
  messageId,
  role: 'reasoning'
})

const reasoningContent = (messageId: string, delta: string): StreamChunk => ({
  type: EventType.REASONING_MESSAGE_CONTENT,
  messageId,
  delta
})

const reasoningEnd = (messageId: string): StreamChunk => ({
  type: EventType.REASONING_MESSAGE_END,
  messageId
})

const toolStart = (toolCallId: string, toolName: string): StreamChunk => ({
  type: EventType.TOOL_CALL_START,
  toolCallId,
  toolCallName: toolName,
  toolName
})

const toolArgs = (toolCallId: string, input: Record<string, unknown>): StreamChunk => ({
  type: EventType.TOOL_CALL_ARGS,
  toolCallId,
  delta: JSON.stringify(input)
})

const toolEnd = (toolCallId: string, toolName: string, isError: boolean): StreamChunk => ({
  type: EventType.TOOL_CALL_END,
  toolCallId,
  toolCallName: toolName,
  state: isError ? 'output-error' : 'output-available'
})

const toolResult = (toolCallId: string, content: string): StreamChunk => ({
  type: EventType.TOOL_CALL_RESULT,
  messageId: generateMessageId(),
  toolCallId,
  content,
  role: 'tool'
})

interface TranslationState {
  readonly openTextMessageId: string | undefined
  readonly openReasoningMessageId: string | undefined
}

const initialTranslationState: TranslationState = {
  openTextMessageId: undefined,
  openReasoningMessageId: undefined
}

const closeOpenText = (
  state: TranslationState
): readonly [TranslationState, ReadonlyArray<StreamChunk>] =>
  state.openTextMessageId === undefined
    ? [state, []]
    : [{ ...state, openTextMessageId: undefined }, [textEnd(state.openTextMessageId)]]

const closeOpenReasoning = (
  state: TranslationState
): readonly [TranslationState, ReadonlyArray<StreamChunk>] =>
  state.openReasoningMessageId === undefined
    ? [state, []]
    : [
        { ...state, openReasoningMessageId: undefined },
        [reasoningEnd(state.openReasoningMessageId)]
      ]

// Closes both the in-progress reasoning and text messages, in that order, so a boundary event
// (tool call, assistant message, or run end) never leaves either dangling open.
const closeOpen = (
  state: TranslationState
): readonly [TranslationState, ReadonlyArray<StreamChunk>] => {
  const [afterReasoning, closingReasoning] = closeOpenReasoning(state)
  const [afterText, closingText] = closeOpenText(afterReasoning)
  return [afterText, [...closingReasoning, ...closingText]]
}

const translateEvent = (
  threadId: string,
  runId: string,
  state: TranslationState,
  event: PaneStreamEvent
): readonly [TranslationState, ReadonlyArray<StreamChunk>] => {
  switch (event._tag) {
    case 'PaneAssistantThinkingDelta': {
      if (state.openReasoningMessageId === undefined) {
        const messageId = generateMessageId()
        return [
          { ...state, openReasoningMessageId: messageId },
          [reasoningStart(messageId), reasoningContent(messageId, event.text)]
        ]
      }
      return [state, [reasoningContent(state.openReasoningMessageId, event.text)]]
    }
    case 'PaneAssistantTextDelta': {
      // Thinking always precedes the answer, so the first answer delta closes any open reasoning.
      const [afterReasoning, closingReasoning] = closeOpenReasoning(state)
      if (afterReasoning.openTextMessageId === undefined) {
        const messageId = generateMessageId()
        return [
          { ...afterReasoning, openTextMessageId: messageId },
          [...closingReasoning, textStart(messageId), textContent(messageId, event.text)]
        ]
      }
      return [
        afterReasoning,
        [...closingReasoning, textContent(afterReasoning.openTextMessageId, event.text)]
      ]
    }
    case 'PaneMessageAppended':
      return event.message.role === 'assistant' ? closeOpen(state) : [state, []]
    case 'PaneToolCallStarted': {
      const [nextState, closing] = closeOpen(state)
      return [nextState, [...closing, toolStart(event.toolCallId, event.toolName)]]
    }
    case 'PaneToolCallCompleted':
      return [
        state,
        [
          toolArgs(event.toolCallId, event.input),
          toolEnd(event.toolCallId, event.toolName, event.isError),
          toolResult(event.toolCallId, event.output)
        ]
      ]
    case 'PaneAttentionChanged': {
      if (event.attention._tag === 'Completed') {
        const [, closing] = closeOpen(state)
        return [initialTranslationState, [...closing, runFinished(threadId, runId)]]
      }
      if (event.attention._tag === 'Errored') {
        const [, closing] = closeOpen(state)
        return [
          initialTranslationState,
          [...closing, runError(threadId, runId, event.attention.error.message)]
        ]
      }
      return [state, []]
    }
  }
}

const isRunTerminal = (chunk: StreamChunk): boolean =>
  chunk.type === EventType.RUN_FINISHED || chunk.type === EventType.RUN_ERROR

/**
 * Builds a TanStack AI `ConnectConnectionAdapter` that replays one pane's
 * Electron IPC event stream as an AG-UI `StreamChunk` stream, so `useChat` can
 * drive the pane as a pure observer. Pass the returned adapter to `useChat`'s
 * `connection`.
 *
 * The adapter owns no model or tool execution: each `connect(messages)` call
 * subscribes to the pane's IPC events, forwards the latest user message via
 * `window.dia.sendMessage`, and yields chunks translated from those events
 * (assistant text deltas, tool calls with their resolved output) until the
 * pane's attention settles to `Completed` (`RUN_FINISHED`) or `Errored`
 * (`RUN_ERROR`), at which point the stream ends and its IPC subscriptions are
 * released. Aborting the request (or `useChat` tearing the stream down) also
 * releases them. Permission and clarifying-question prompts are intentionally
 * not surfaced here — they stay on their own IPC channels as blocking overlays
 * (see ADR-0014). Tool calls are always yielded fully resolved so `useChat`
 * never awaits a client-side execution.
 */
export const createPaneConnectionAdapter = (paneId: string): ConnectConnectionAdapter => ({
  connect: (messages, _data, abortSignal, runContext) => {
    const threadId = runContext?.threadId ?? paneId
    const runId = runContext?.runId ?? generateMessageId()

    const forPane =
      <T extends { paneId: string }>(handler: (event: T) => void) =>
      (event: T): void => {
        if (event.paneId === paneId) handler(event)
      }

    const events = Stream.asyncPush<PaneStreamEvent>((emit) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const push = (event: PaneStreamEvent): void => {
            emit.single(event)
          }
          const unsubscribes = [
            window.dia.onAssistantTextDelta(forPane(push)),
            window.dia.onAssistantThinkingDelta(forPane(push)),
            window.dia.onToolCallStarted(forPane(push)),
            window.dia.onToolCallCompleted(forPane(push)),
            window.dia.onMessageAppended(forPane(push)),
            window.dia.onAttentionChanged(forPane(push))
          ]
          const onAbort = (): void => emit.end()
          abortSignal?.addEventListener('abort', onAbort)
          window.dia.sendMessage(paneId, latestUserText(messages))
          yield* Effect.logDebug('pane connection adapter subscribed').pipe(
            Effect.annotateLogs({ paneId, runId })
          )
          return { unsubscribes, onAbort }
        }),
        ({ unsubscribes, onAbort }) =>
          Effect.sync(() => {
            abortSignal?.removeEventListener('abort', onAbort)
            for (const unsubscribe of unsubscribes) unsubscribe()
          })
      )
    )

    const translated = events.pipe(
      Stream.mapAccum(initialTranslationState, (state, event) =>
        translateEvent(threadId, runId, state, event)
      ),
      Stream.mapConcat((chunks) => chunks),
      Stream.takeUntil(isRunTerminal)
    )

    return Stream.make(runStarted(threadId, runId)).pipe(
      Stream.concat(translated),
      Stream.toAsyncIterable
    )
  }
})
