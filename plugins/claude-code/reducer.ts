import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  AssistantMessageReceived,
  AssistantTextDelta,
  AssistantThinkingDelta,
  CheckpointAvailable,
  ConversationCompacted,
  ConversationReset,
  type OutboundMessage,
  type ParkCause,
  SessionId,
  SessionNotice,
  SessionStarted,
  SignedOut,
  SlashCommandsAvailable,
  ToolCallCompleted,
  ToolCallStarted,
  ToolCallUpdated,
  TurnCompleted,
  TurnErrored,
  TurnParked,
  TurnStatusChanged,
  UsageLimit
} from '@dia/plugin'
import type { ConversationMessage } from '@shared/domain/pane'
import { Option } from 'effect'

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

type ResultMessage = Extract<SDKMessage, { type: 'result' }>
type RateLimitInfo = Extract<SDKMessage, { type: 'rate_limit_event' }>['rate_limit_info']
type RateLimitType = RateLimitInfo['rateLimitType']

const refusedByLimit = (info: RateLimitInfo): boolean =>
  info.status === 'rejected' &&
  info.overageStatus !== 'allowed' &&
  info.overageStatus !== 'allowed_warning'

const resetsAtMillis = (info: RateLimitInfo): number | null =>
  info.resetsAt === undefined ? null : Math.round(info.resetsAt * 1000)

const ERROR_RESULT_LABELS: Record<Exclude<ResultMessage['subtype'], 'success'>, string> = {
  error_during_execution: 'The turn failed',
  error_max_turns: 'Stopped at the turn limit',
  error_max_budget_usd: 'Stopped at the budget limit',
  error_max_structured_output_retries: 'Stopped after too many structured output retries'
}

const RATE_LIMIT_LABELS: Record<NonNullable<RateLimitType>, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'overage'
}

const errorResultMessage = (
  subtype: keyof typeof ERROR_RESULT_LABELS,
  errors: ReadonlyArray<string>
): string =>
  errors.length > 0
    ? `${ERROR_RESULT_LABELS[subtype]}: ${errors.join('; ')}`
    : ERROR_RESULT_LABELS[subtype]

const rateLimitWarning = (type: RateLimitType): string =>
  type === undefined
    ? 'Approaching the usage limit'
    : `Approaching the ${RATE_LIMIT_LABELS[type]} usage limit`

const COMPACTING_LABEL = 'Compacting conversation'

const thinkingLabel = (tokens: number): string =>
  tokens < 1000 ? 'Thinking' : `Thinking · ~${(Math.floor(tokens / 100) / 10).toFixed(1)}k tokens`

const retryLabel = (retry: Extract<SDKMessage, { subtype: 'api_retry' }>): string =>
  `Retrying (attempt ${retry.attempt} of ${retry.max_retries}) in ${Math.ceil(retry.retry_delay_ms / 1000)}s · ${retry.error_status ?? 'connection error'}`

const taskProgressDetail = (task: Extract<SDKMessage, { subtype: 'task_progress' }>): string =>
  task.summary ??
  [
    task.description,
    `${task.usage.tool_uses} tools`,
    ...(task.last_tool_name !== undefined ? [`last: ${task.last_tool_name}`] : [])
  ].join(' · ')

const ENDS_TURN_STATUS: ReadonlySet<OutboundMessage['_tag']> = new Set([
  'AssistantTextDelta',
  'AssistantThinkingDelta',
  'ToolCallStarted',
  'TurnCompleted',
  'TurnErrored',
  'TurnParked'
])

/**
 * Folds the Agent SDK's raw message stream into {@link OutboundMessage}s for one agent session.
 * `step` takes one SDK message, in arrival order, and returns the protocol messages it produces
 * in emission order; it returns an empty array for a message with no protocol effect.
 */
export interface SessionEventReducer {
  readonly step: (message: SDKMessage) => ReadonlyArray<OutboundMessage>
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
 * up to but excluding that user turn. `continuesFrom` is the uuid of the last
 * assistant message of the conversation this stream continues, or none for a new
 * conversation; until the stream delivers an assistant message of its own, user
 * turns carry it as `resumeAnchorUuid`. When the account refuses a turn (a rejected usage limit
 * the plan's overage does not cover, or a signed-out account) and the turn's `result` fails, the
 * reducer ends the turn with `TurnParked` instead of `TurnErrored`.
 */
export const makeSessionEventReducer = (
  continuesFrom: Option.Option<string>
): SessionEventReducer => {
  const toolCallsByBlockIndex = new Map<number, { id: string; name: string }>()
  const partialJsonByBlockIndex = new Map<number, string>()
  const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>()
  let lastAssistantUuid = Option.getOrUndefined(continuesFrom)
  let lastRateLimitStatus: string | undefined
  let lastRejectedResetsAt: number | null = null
  let parkCause: ParkCause | null = null
  let turnStatus: string | null = null

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

  const stepNotice = (message: SDKMessage): ReadonlyArray<OutboundMessage> | undefined => {
    if (message.type === 'tool_progress') {
      if (message.parent_tool_use_id !== null) return []
      return [
        ToolCallUpdated.make({
          toolCallId: message.tool_use_id,
          elapsedSeconds: message.elapsed_time_seconds
        })
      ]
    }
    if (message.type === 'rate_limit_event') {
      const { status, rateLimitType } = message.rate_limit_info
      if (refusedByLimit(message.rate_limit_info)) {
        lastRejectedResetsAt = resetsAtMillis(message.rate_limit_info)
        parkCause = UsageLimit.make({ resetsAt: lastRejectedResetsAt })
      }
      const entered = status !== lastRateLimitStatus
      lastRateLimitStatus = status
      return entered && status === 'allowed_warning'
        ? [SessionNotice.make({ text: rateLimitWarning(rateLimitType) })]
        : []
    }
    if (message.type !== 'system') return undefined
    switch (message.subtype) {
      case 'local_command_output':
        return [
          AssistantMessageReceived.make({
            message: { role: 'assistant', content: message.content }
          })
        ]
      case 'api_retry':
        return [TurnStatusChanged.make({ label: retryLabel(message) })]
      case 'thinking_tokens':
        return [TurnStatusChanged.make({ label: thinkingLabel(message.estimated_tokens) })]
      case 'status':
        return [
          ...(message.status === 'compacting'
            ? [TurnStatusChanged.make({ label: COMPACTING_LABEL })]
            : turnStatus === COMPACTING_LABEL
              ? [TurnStatusChanged.make({ label: null })]
              : []),
          ...(message.compact_result === 'failed'
            ? [
                SessionNotice.make({
                  text:
                    message.compact_error !== undefined
                      ? `Compaction failed: ${message.compact_error}`
                      : 'Compaction failed'
                })
              ]
            : [])
        ]
      case 'model_refusal_fallback':
        return [
          SessionNotice.make({
            text: `${message.original_model} declined the request; retried on ${message.fallback_model}`
          })
        ]
      case 'informational':
        return message.level === 'info' || message.tool_use_id !== undefined
          ? []
          : [SessionNotice.make({ text: message.content })]
      case 'permission_denied':
        return [
          ToolCallUpdated.make({
            toolCallId: message.tool_use_id,
            detail: `Denied: ${message.decision_reason ?? message.message}`
          })
        ]
      case 'task_progress':
        return message.tool_use_id === undefined
          ? []
          : [
              ToolCallUpdated.make({
                toolCallId: message.tool_use_id,
                detail: taskProgressDetail(message)
              })
            ]
      case 'task_notification':
        return message.tool_use_id === undefined || message.status !== 'failed'
          ? []
          : [
              ToolCallUpdated.make({
                toolCallId: message.tool_use_id,
                detail: `Failed: ${message.summary}`
              })
            ]
      default:
        return undefined
    }
  }

  const stepMessage = (message: SDKMessage): ReadonlyArray<OutboundMessage> => {
    if (message.type === 'system' && message.subtype === 'init') {
      // The streamed init message lists command names only (no descriptions). The
      // full list -- with descriptions and argument hints -- is fetched once at
      // session start via query.supportedCommands() in session.ts, so this
      // branch deliberately emits only SessionStarted and leaves the command list
      // to that warm-up (and to later commands_changed messages). Emitting the
      // names-only list here too would race the warm-up and could clobber the
      // enriched list with empty descriptions.
      return [SessionStarted.make({ sessionId: SessionId.make(message.session_id) })]
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
      return [ConversationReset.make({ newSessionId: SessionId.make(message.new_conversation_id) })]
    }

    if (message.type === 'assistant') {
      lastAssistantUuid = message.uuid
      if (message.error === 'rate_limit' && parkCause?._tag !== 'UsageLimit') {
        parkCause = UsageLimit.make({ resetsAt: lastRejectedResetsAt })
      }
      if (message.error === 'authentication_failed') parkCause = SignedOut.make({})
      const text = message.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (!text) return []
      const conversationMessage: ConversationMessage = { role: 'assistant', content: text }
      return [AssistantMessageReceived.make({ message: conversationMessage })]
    }

    if (message.type === 'result') {
      const flushed = flushPendingToolCalls()
      const cause = parkCause
      parkCause = null
      lastRejectedResetsAt = null
      if (cause !== null && (message.subtype !== 'success' || message.is_error)) {
        return [...flushed, TurnParked.make({ cause })]
      }
      if (message.subtype === 'success') {
        return [...flushed, TurnCompleted.make({})]
      }
      return [
        ...flushed,
        TurnErrored.make({
          error: { message: errorResultMessage(message.subtype, message.errors) }
        })
      ]
    }

    const notice = stepNotice(message)
    if (notice !== undefined) return notice

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
      const input = parseToolInput(partialJsonByBlockIndex.get(streamEvent.index) ?? '')
      toolCallsByBlockIndex.delete(streamEvent.index)
      partialJsonByBlockIndex.delete(streamEvent.index)
      pendingToolCalls.set(toolCall.id, { name: toolCall.name, input })
      return [ToolCallUpdated.make({ toolCallId: toolCall.id, input })]
    }

    return []
  }

  const trackTurnStatus = (outbound: OutboundMessage): ReadonlyArray<OutboundMessage> => {
    if (outbound._tag === 'TurnStatusChanged') {
      if (outbound.label === turnStatus) return []
      turnStatus = outbound.label
      return [outbound]
    }
    if (turnStatus === null || !ENDS_TURN_STATUS.has(outbound._tag)) return [outbound]
    turnStatus = null
    return [TurnStatusChanged.make({ label: null }), outbound]
  }

  const step = (message: SDKMessage): ReadonlyArray<OutboundMessage> =>
    stepMessage(message).flatMap(trackTurnStatus)

  return { step }
}
