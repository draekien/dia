import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ConversationMessage } from '@shared/domain/pane'
import {
  AssistantMessageReceived,
  AssistantTextDelta,
  AssistantThinkingDelta,
  CheckpointAvailable,
  ConversationCompacted,
  ConversationReset,
  type OutboundMessage,
  SessionStarted,
  SlashCommandsAvailable,
  ToolCallCompleted,
  ToolCallStarted,
  TurnCompleted,
  TurnErrored
} from './protocol'

/**
 * Folds the Agent SDK's raw message/event stream into the {@link OutboundMessage}
 * protocol the pane subprocess sends to main. Create one per agent session with
 * {@link makeSessionEventReducer} and feed every SDK message to {@link SessionEventReducer.step}
 * in arrival order; the reducer owns all cross-event correlation state
 * (in-flight content blocks, accumulated tool input, and tool calls awaiting
 * their result) so callers only deal in complete protocol messages.
 */
export interface SessionEventReducer {
  /**
   * Advances the reducer with one SDK message and returns the protocol messages
   * it produces, in emission order. Returns an empty array for messages that
   * carry no externally visible protocol effect (e.g. intermediate
   * `input_json_delta` chunks, which are accumulated internally).
   */
  readonly step: (message: SDKMessage) => ReadonlyArray<OutboundMessage>
}

const parseToolInput = (partialJson: string): Record<string, unknown> => {
  if (!partialJson) return {}
  try {
    const parsed: unknown = JSON.parse(partialJson)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

type UserContentBlock = Exclude<
  Extract<SDKMessage, { type: 'user' }>['message']['content'],
  string
>[number]

type ToolResultBlock = Extract<UserContentBlock, { type: 'tool_result' }>

const flattenToolResultContent = (content: ToolResultBlock['content']): string => {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('')
}

/**
 * Builds a fresh {@link SessionEventReducer}. Each instance is single-use and
 * stateful: it accumulates streaming tool input and remembers which tool calls
 * are awaiting their result, so a `ToolCallCompleted` is emitted only once the
 * matching tool result arrives (or the turn ends), reflecting real execution
 * time rather than the moment the tool's input finished streaming. It also
 * remembers the uuid of the most recent assistant message seen, so each
 * `CheckpointAvailable` it emits for a user turn carries that uuid as
 * `resumeAnchorUuid` — the point `resumeSessionAt` must branch at to resume
 * up to but excluding that user turn.
 */
export const makeSessionEventReducer = (): SessionEventReducer => {
  const toolCallsByBlockIndex = new Map<number, { id: string; name: string }>()
  const partialJsonByBlockIndex = new Map<number, string>()
  const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>()
  let lastAssistantUuid: string | undefined

  const completeToolCall = (
    toolCallId: string,
    result?: { output: string; isError: boolean }
  ): OutboundMessage | undefined => {
    const pending = pendingToolCalls.get(toolCallId)
    if (!pending) return undefined
    pendingToolCalls.delete(toolCallId)
    return ToolCallCompleted.make({
      toolCallId,
      toolName: pending.name,
      input: pending.input,
      output: result?.output ?? '',
      isError: result?.isError ?? false
    })
  }

  const flushPendingToolCalls = (): OutboundMessage[] => {
    const completed: OutboundMessage[] = []
    for (const toolCallId of [...pendingToolCalls.keys()]) {
      const message = completeToolCall(toolCallId)
      if (message) completed.push(message)
    }
    return completed
  }

  const step = (message: SDKMessage): ReadonlyArray<OutboundMessage> => {
    if (message.type === 'system' && message.subtype === 'init') {
      // The streamed init message lists command names only (no descriptions). The
      // full list -- with descriptions and argument hints -- is fetched once at
      // session start via query.supportedCommands() in agent-session.ts, so this
      // branch deliberately emits only SessionStarted and leaves the command list
      // to that warm-up (and to later commands_changed messages). Emitting the
      // names-only list here too would race the warm-up and could clobber the
      // enriched list with empty descriptions.
      return [SessionStarted.make({ sessionId: message.session_id })]
    }

    if (message.type === 'system' && message.subtype === 'commands_changed') {
      return [
        SlashCommandsAvailable.make({
          commands: message.commands.map((command) => ({
            name: command.name,
            description: command.description,
            argumentHint: command.argumentHint
          }))
        })
      ]
    }

    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const { trigger, pre_tokens, post_tokens } = message.compact_metadata
      return [
        ConversationCompacted.make({
          trigger,
          preTokens: pre_tokens,
          ...(post_tokens !== undefined ? { postTokens: post_tokens } : {})
        })
      ]
    }

    if (message.type === 'conversation_reset') {
      return [ConversationReset.make({ newSessionId: message.new_conversation_id })]
    }

    if (message.type === 'assistant') {
      lastAssistantUuid = message.uuid
      const text = message.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (!text) return []
      const conversationMessage: ConversationMessage = { role: 'assistant', content: text }
      return [AssistantMessageReceived.make({ message: conversationMessage })]
    }

    if (message.type === 'result') {
      const flushed = flushPendingToolCalls()
      if (message.subtype === 'success') {
        return [...flushed, TurnCompleted.make({})]
      }
      const errorMessage = message.errors.length > 0 ? message.errors.join('; ') : message.subtype
      return [...flushed, TurnErrored.make({ error: { message: errorMessage } })]
    }

    if (message.type === 'user') {
      const content = message.message.content
      if (typeof content === 'string') {
        return message.uuid !== undefined
          ? [
              CheckpointAvailable.make({
                messageUuid: message.uuid,
                ...(lastAssistantUuid !== undefined ? { resumeAnchorUuid: lastAssistantUuid } : {})
              })
            ]
          : []
      }
      const completed: OutboundMessage[] = []
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        const completion = completeToolCall(block.tool_use_id, {
          output: flattenToolResultContent(block.content),
          isError: block.is_error ?? false
        })
        if (completion) completed.push(completion)
      }
      return completed
    }

    if (message.type !== 'stream_event') return []
    const streamEvent = message.event

    if (
      streamEvent.type === 'content_block_start' &&
      streamEvent.content_block.type === 'tool_use'
    ) {
      const { id, name } = streamEvent.content_block
      toolCallsByBlockIndex.set(streamEvent.index, { id, name })
      partialJsonByBlockIndex.set(streamEvent.index, '')
      return [ToolCallStarted.make({ toolCallId: id, toolName: name })]
    }

    if (streamEvent.type === 'content_block_delta') {
      if (streamEvent.delta.type === 'text_delta') {
        return [AssistantTextDelta.make({ text: streamEvent.delta.text })]
      }
      if (streamEvent.delta.type === 'thinking_delta') {
        return [AssistantThinkingDelta.make({ text: streamEvent.delta.thinking })]
      }
      if (streamEvent.delta.type === 'input_json_delta') {
        const existing = partialJsonByBlockIndex.get(streamEvent.index) ?? ''
        partialJsonByBlockIndex.set(streamEvent.index, existing + streamEvent.delta.partial_json)
      }
      return []
    }

    if (streamEvent.type === 'content_block_stop') {
      const toolCall = toolCallsByBlockIndex.get(streamEvent.index)
      if (!toolCall) return []
      const partialJson = partialJsonByBlockIndex.get(streamEvent.index) ?? ''
      toolCallsByBlockIndex.delete(streamEvent.index)
      partialJsonByBlockIndex.delete(streamEvent.index)
      pendingToolCalls.set(toolCall.id, {
        name: toolCall.name,
        input: parseToolInput(partialJson)
      })
    }

    return []
  }

  return { step }
}
