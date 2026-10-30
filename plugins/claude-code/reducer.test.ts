// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK types session UUIDs with Node's UUID template type.
import type { UUID } from 'node:crypto'
import type { SDKMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { OutboundMessage } from '@dia/plugin'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeSessionEventReducer } from './reducer'

type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event']
type AssistantContent = Extract<SDKMessage, { type: 'assistant' }>['message']['content']
type UserContent = Extract<SDKMessage, { type: 'user' }>['message']['content']

const streamEvent = (event: StreamEvent): SDKMessage => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: null,
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'test-session'
})

const textDelta = (index: number, text: string): SDKMessage =>
  streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })

const toolUseStart = (index: number, id: string, name: string): SDKMessage =>
  streamEvent({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} }
  })

const inputJsonDelta = (index: number, partialJson: string): SDKMessage =>
  streamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson }
  })

const thinkingDelta = (index: number, thinking: string): SDKMessage =>
  streamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking, estimated_tokens: null }
  })

const blockStop = (index: number): SDKMessage => streamEvent({ type: 'content_block_stop', index })

const assistantMessage = (content: AssistantContent): SDKMessage => ({
  type: 'assistant',
  parent_tool_use_id: null,
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'test-session',
  message: {
    id: 'test-message',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      fallback_credit: null
    }
  }
})

const userMessage = (content: UserContent): SDKMessage => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content }
})

const replayedUserPrompt = (text: string, uuid: string): SDKMessage => ({
  type: 'user',
  parent_tool_use_id: null,
  uuid: uuid as UUID,
  session_id: 'test-session',
  message: { role: 'user', content: text }
})

const userMessageWithUuid = (content: UserContent, uuid: string): SDKMessage => ({
  type: 'user',
  parent_tool_use_id: null,
  uuid: uuid as UUID,
  session_id: 'test-session',
  message: { role: 'user', content }
})

const toolResult = (
  toolUseId: string,
  options?: {
    content?: Extract<UserContent[number], { type: 'tool_result' }>['content']
    isError?: boolean
  }
): UserContent => [
  {
    type: 'tool_result',
    tool_use_id: toolUseId,
    ...(options?.content !== undefined ? { content: options.content } : {}),
    ...(options?.isError !== undefined ? { is_error: options.isError } : {})
  }
]

const systemInit = (slashCommands: string[], sessionId = 'test-session'): SDKMessage => ({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'user',
  claude_code_version: '2.1.0',
  cwd: '/repo',
  tools: [],
  mcp_servers: [],
  model: 'claude-sonnet-5',
  permissionMode: 'default',
  slash_commands: slashCommands,
  output_style: 'default',
  skills: [],
  plugins: [],
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: sessionId
})

const commandsChanged = (commands: ReadonlyArray<SlashCommand>): SDKMessage => ({
  type: 'system',
  subtype: 'commands_changed',
  commands: [...commands],
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'test-session'
})

const compactBoundary = (
  trigger: 'manual' | 'auto',
  preTokens: number,
  postTokens?: number
): SDKMessage => ({
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: {
    trigger,
    pre_tokens: preTokens,
    ...(postTokens !== undefined ? { post_tokens: postTokens } : {})
  },
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'test-session'
})

const conversationReset = (newConversationId: UUID): SDKMessage => ({
  type: 'conversation_reset',
  new_conversation_id: newConversationId,
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'test-session'
})

const runContinuing = (
  continuesFrom: Option.Option<string>,
  messages: ReadonlyArray<SDKMessage>
): OutboundMessage[] => {
  const reducer = makeSessionEventReducer(continuesFrom)
  return messages.flatMap((message) => [...reducer.step(message)])
}

const run = (messages: ReadonlyArray<SDKMessage>): OutboundMessage[] =>
  runContinuing(Option.none(), messages)

const textDeltas = (emitted: ReadonlyArray<OutboundMessage>): string[] =>
  emitted.flatMap((message) => (message._tag === 'AssistantTextDelta' ? [message.text] : []))

const toolCompletions = (
  emitted: ReadonlyArray<OutboundMessage>
): Extract<OutboundMessage, { _tag: 'ToolCallCompleted' }>[] =>
  emitted.flatMap((message) => (message._tag === 'ToolCallCompleted' ? [message] : []))

const thinkingDeltas = (emitted: ReadonlyArray<OutboundMessage>): string[] =>
  emitted.flatMap((message) => (message._tag === 'AssistantThinkingDelta' ? [message.text] : []))

const checkpoints = (emitted: ReadonlyArray<OutboundMessage>): string[] =>
  emitted.flatMap((message) =>
    message._tag === 'CheckpointAvailable' ? [message.messageUuid] : []
  )

describe('makeSessionEventReducer — assistant text streaming (T1)', () => {
  it('accumulates text deltas in arrival order into the intended message text', () => {
    const chunks = ['The ', 'quick ', 'brown ', 'fox']
    const expectedText = 'The quick brown fox'

    const emitted = run(chunks.map((chunk, index) => textDelta(index, chunk)))

    expect(textDeltas(emitted)).toEqual(chunks)
    expect(textDeltas(emitted).join('')).toBe(expectedText)
  })

  it('reconstructs the same text from deltas as the non-streamed assistant message reports', () => {
    const expectedText = 'The quick brown fox'
    const messages: SDKMessage[] = [
      textDelta(0, 'The '),
      textDelta(0, 'quick '),
      textDelta(0, 'brown '),
      textDelta(0, 'fox'),
      assistantMessage([{ type: 'text', text: expectedText, citations: null }])
    ]

    const emitted = run(messages)
    const complete = emitted.find((message) => message._tag === 'AssistantMessageReceived')

    expect(textDeltas(emitted).join('')).toBe(expectedText)
    expect(complete).toEqual({
      _tag: 'AssistantMessageReceived',
      message: { role: 'assistant', content: expectedText }
    })
  })

  it('excludes tool-input deltas from the accumulated assistant text', () => {
    const messages: SDKMessage[] = [
      textDelta(0, 'before'),
      toolUseStart(1, 'tool-1', 'Read'),
      inputJsonDelta(1, '{"file_path":"/x"}'),
      textDelta(0, 'after')
    ]

    expect(textDeltas(run(messages)).join('')).toBe('beforeafter')
  })
})

describe('makeSessionEventReducer — extended thinking streaming', () => {
  it('emits one AssistantThinkingDelta per thinking_delta, preserving text and arrival order', () => {
    const chunks = ['Let me ', 'consider ', 'the options']

    const emitted = run(chunks.map((chunk, index) => thinkingDelta(index, chunk)))

    expect(thinkingDeltas(emitted)).toEqual(chunks)
  })

  it('keeps thinking deltas out of the accumulated assistant text stream', () => {
    const messages: SDKMessage[] = [
      thinkingDelta(0, 'reasoning about it'),
      textDelta(1, 'the answer')
    ]

    const emitted = run(messages)

    expect(thinkingDeltas(emitted)).toEqual(['reasoning about it'])
    expect(textDeltas(emitted)).toEqual(['the answer'])
  })
})

describe('makeSessionEventReducer — tool input accumulation (T4)', () => {
  it('accumulates input_json_delta chunks into parsed input matching ToolCallCompleted.input', () => {
    const expectedInput = { file_path: '/a/b.ts', limit: 100 }
    const jsonChunks = ['{"file_path":"/a', '/b.ts","lim', 'it":100}']

    const messages: SDKMessage[] = [
      toolUseStart(0, 'tool-1', 'Read'),
      ...jsonChunks.map((chunk) => inputJsonDelta(0, chunk)),
      blockStop(0),
      userMessage(toolResult('tool-1'))
    ]

    const completions = toolCompletions(run(messages))

    expect(completions).toEqual([
      {
        _tag: 'ToolCallCompleted',
        toolCallId: 'tool-1',
        toolName: 'Read',
        input: expectedInput,
        output: '',
        isError: false
      }
    ])
  })

  it('reports an empty input object for a tool call that streamed no input chunks', () => {
    const messages: SDKMessage[] = [
      toolUseStart(0, 'tool-1', 'Glob'),
      blockStop(0),
      userMessage(toolResult('tool-1'))
    ]

    expect(toolCompletions(run(messages))[0]?.input).toEqual({})
  })

  it('reports the parsed input as soon as it finishes streaming, before the tool runs', () => {
    const emitted = run([
      toolUseStart(0, 'tool-1', 'Bash'),
      inputJsonDelta(0, '{"command":"ls"}'),
      blockStop(0)
    ])

    expect(emitted).toContainEqual({
      _tag: 'ToolCallUpdated',
      toolCallId: 'tool-1',
      input: { command: 'ls' }
    })
  })

  it('defers completion until the tool result arrives, not when input finishes streaming', () => {
    const beforeResult = run([
      toolUseStart(0, 'tool-1', 'Bash'),
      inputJsonDelta(0, '{"command":"ls"}'),
      blockStop(0)
    ])
    expect(toolCompletions(beforeResult)).toHaveLength(0)

    const throughResult = run([
      toolUseStart(0, 'tool-1', 'Bash'),
      inputJsonDelta(0, '{"command":"ls"}'),
      blockStop(0),
      userMessage(toolResult('tool-1'))
    ])
    expect(toolCompletions(throughResult)).toHaveLength(1)
  })

  it('correlates each tool result to its originating call by id, regardless of result order', () => {
    const messages: SDKMessage[] = [
      toolUseStart(0, 'tool-read', 'Read'),
      inputJsonDelta(0, '{"file_path":"/a"}'),
      blockStop(0),
      toolUseStart(1, 'tool-bash', 'Bash'),
      inputJsonDelta(1, '{"command":"ls"}'),
      blockStop(1),
      userMessage([
        { type: 'tool_result', tool_use_id: 'tool-bash' },
        { type: 'tool_result', tool_use_id: 'tool-read' }
      ])
    ]

    const completions = toolCompletions(run(messages))

    expect(completions).toEqual([
      {
        _tag: 'ToolCallCompleted',
        toolCallId: 'tool-bash',
        toolName: 'Bash',
        input: { command: 'ls' },
        output: '',
        isError: false
      },
      {
        _tag: 'ToolCallCompleted',
        toolCallId: 'tool-read',
        toolName: 'Read',
        input: { file_path: '/a' },
        output: '',
        isError: false
      }
    ])
  })

  it('emits ToolCallStarted with the tool name when the tool block begins', () => {
    const emitted = run([toolUseStart(0, 'tool-1', 'Read')])

    expect(emitted).toEqual([{ _tag: 'ToolCallStarted', toolCallId: 'tool-1', toolName: 'Read' }])
  })
})

describe('makeSessionEventReducer — slash commands and session lifecycle', () => {
  it('emits only SessionStarted on init, leaving the command list to the warm-up', () => {
    const emitted = run([systemInit(['compact', 'clear'])])

    expect(emitted).toEqual([{ _tag: 'SessionStarted', sessionId: 'test-session' }])
  })

  it('reports the slash-command list with descriptions from a commands_changed message', () => {
    const emitted = run([
      commandsChanged([
        { name: 'compact', description: 'Compact history', argumentHint: '[instructions]' }
      ])
    ])

    expect(emitted).toEqual([
      {
        _tag: 'SlashCommandsAvailable',
        commands: [
          { name: 'compact', description: 'Compact history', argumentHint: '[instructions]' }
        ]
      }
    ])
  })

  it('reports a compaction boundary with its manual trigger and token span', () => {
    const emitted = run([compactBoundary('manual', 1842, 500)])

    expect(emitted).toEqual([
      { _tag: 'ConversationCompacted', trigger: 'manual', preTokens: 1842, postTokens: 500 }
    ])
  })

  it('omits postTokens when the compaction boundary does not report them', () => {
    const emitted = run([compactBoundary('auto', 900)])

    expect(emitted).toEqual([{ _tag: 'ConversationCompacted', trigger: 'auto', preTokens: 900 }])
  })

  it('surfaces a conversation reset carrying the new conversation id to persist', () => {
    const emitted = run([conversationReset('11111111-1111-4111-8111-111111111111')])

    expect(emitted).toEqual([
      { _tag: 'ConversationReset', newSessionId: '11111111-1111-4111-8111-111111111111' }
    ])
  })
})

describe('makeSessionEventReducer — tool output capture', () => {
  const completeCall = (result: ReturnType<typeof toolResult>) =>
    toolCompletions(run([toolUseStart(0, 'tool-1', 'Bash'), blockStop(0), userMessage(result)]))[0]

  it('captures string tool_result content as the completion output', () => {
    const completion = completeCall(toolResult('tool-1', { content: 'hello world' }))

    expect(completion?.output).toBe('hello world')
    expect(completion?.isError).toBe(false)
  })

  it('flattens an array of text content blocks into the output', () => {
    const completion = completeCall(
      toolResult('tool-1', {
        content: [
          { type: 'text', text: 'first ' },
          { type: 'text', text: 'second' }
        ]
      })
    )

    expect(completion?.output).toBe('first second')
  })

  it('flags a failed or denied result via isError', () => {
    const completion = completeCall(
      toolResult('tool-1', { content: 'permission denied', isError: true })
    )

    expect(completion?.isError).toBe(true)
    expect(completion?.output).toBe('permission denied')
  })
})

describe('makeSessionEventReducer — file-checkpoint anchoring', () => {
  it('emits CheckpointAvailable carrying the uuid of a replayed user prompt turn', () => {
    const uuid = 'ckpt-1111-4111-8111-111111111111'

    const emitted = run([replayedUserPrompt('Refactor the auth module', uuid)])

    expect(emitted).toEqual([{ _tag: 'CheckpointAvailable', messageUuid: uuid }])
  })

  it('emits no CheckpointAvailable for a user prompt turn without a uuid (replay disabled)', () => {
    const emitted = run([userMessage('Refactor the auth module')])

    expect(checkpoints(emitted)).toEqual([])
  })

  it('carries the preceding assistant uuid as resumeAnchorUuid', () => {
    const uuid = 'ckpt-1111-4111-8111-111111111111'

    const emitted = run([
      replayedUserPrompt('first prompt', 'ckpt-0000-4000-8000-000000000000'),
      assistantMessage([{ type: 'text', text: 'a reply', citations: null }]),
      replayedUserPrompt('second prompt', uuid)
    ])

    expect(emitted).toContainEqual({
      _tag: 'CheckpointAvailable',
      messageUuid: uuid,
      resumeAnchorUuid: '00000000-0000-0000-0000-000000000000'
    })
  })

  it('omits resumeAnchorUuid on the first turn (no preceding assistant)', () => {
    const uuid = 'ckpt-1111-4111-8111-111111111111'

    const emitted = run([replayedUserPrompt('first prompt', uuid)])

    expect(emitted).toEqual([{ _tag: 'CheckpointAvailable', messageUuid: uuid }])
  })

  it('anchors the first turn of a continued conversation to the message it continues from', () => {
    const continuesFrom = 'asst-9999-4999-8999-999999999999'
    const uuid = 'ckpt-1111-4111-8111-111111111111'

    const emitted = runContinuing(Option.some(continuesFrom), [
      replayedUserPrompt('first prompt after a restart', uuid)
    ])

    expect(emitted).toEqual([
      { _tag: 'CheckpointAvailable', messageUuid: uuid, resumeAnchorUuid: continuesFrom }
    ])
  })

  it('anchors a later turn of a continued conversation to the newest assistant message', () => {
    const uuid = 'ckpt-1111-4111-8111-111111111111'

    const emitted = runContinuing(Option.some('asst-9999-4999-8999-999999999999'), [
      assistantMessage([{ type: 'text', text: 'a reply', citations: null }]),
      replayedUserPrompt('second prompt after a restart', uuid)
    ])

    expect(emitted).toContainEqual({
      _tag: 'CheckpointAvailable',
      messageUuid: uuid,
      resumeAnchorUuid: '00000000-0000-0000-0000-000000000000'
    })
  })

  it('does not treat a tool-result user message as a checkpoint even when it carries a uuid', () => {
    const emitted = run([
      toolUseStart(0, 'tool-1', 'Read'),
      blockStop(0),
      userMessageWithUuid(toolResult('tool-1', { content: 'ok' }), 'tr-2222-4222-8222-222222222222')
    ])

    expect(checkpoints(emitted)).toEqual([])
    expect(toolCompletions(emitted)).toHaveLength(1)
  })
})

const sdkMessage = (fields: Record<string, unknown>): SDKMessage =>
  ({
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 'test-session',
    ...fields
  }) as unknown as SDKMessage

const system = (subtype: string, fields: Record<string, unknown> = {}): SDKMessage =>
  sdkMessage({ type: 'system', subtype, ...fields })

const stepOnce = (message: SDKMessage): ReadonlyArray<OutboundMessage> =>
  makeSessionEventReducer(Option.none()).step(message)

describe('makeSessionEventReducer — activity line states', () => {
  it('names an API retry with its attempt, delay rounded up to whole seconds, and HTTP status', () => {
    const emitted = stepOnce(
      system('api_retry', { attempt: 2, max_retries: 10, retry_delay_ms: 3200, error_status: 529 })
    )
    expect(emitted).toEqual([
      { _tag: 'TurnStatusChanged', label: 'Retrying (attempt 2 of 10) in 4s · 529' }
    ])
  })

  it('names a retry after a connection error, which has no HTTP status', () => {
    const emitted = stepOnce(
      system('api_retry', { attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: null })
    )
    expect(emitted).toEqual([
      { _tag: 'TurnStatusChanged', label: 'Retrying (attempt 1 of 10) in 1s · connection error' }
    ])
  })

  it('names compaction while it runs and ends the state when the status clears', () => {
    const reducer = makeSessionEventReducer(Option.none())
    expect(reducer.step(system('status', { status: 'compacting' }))).toEqual([
      { _tag: 'TurnStatusChanged', label: 'Compacting conversation' }
    ])
    expect(reducer.step(system('status', { status: null }))).toEqual([
      { _tag: 'TurnStatusChanged', label: null }
    ])
  })

  it('records a failed compaction in the transcript with its error', () => {
    const emitted = stepOnce(
      system('status', { status: null, compact_result: 'failed', compact_error: 'prompt too long' })
    )
    expect(emitted).toContainEqual({
      _tag: 'SessionNotice',
      text: 'Compaction failed: prompt too long'
    })
  })

  it('shows the thinking-token estimate in thousands above 999 tokens', () => {
    const emitted = stepOnce(
      system('thinking_tokens', { estimated_tokens: 1234, estimated_tokens_delta: 100 })
    )
    expect(emitted).toEqual([{ _tag: 'TurnStatusChanged', label: 'Thinking · ~1.2k tokens' }])
  })

  it('shows no count below 1000 thinking tokens, so the label does not change per token', () => {
    const emitted = stepOnce(
      system('thinking_tokens', { estimated_tokens: 999, estimated_tokens_delta: 1 })
    )
    expect(emitted).toEqual([{ _tag: 'TurnStatusChanged', label: 'Thinking' }])
  })

  it('keeps a retry label when a requesting status arrives during the wait', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(
      system('api_retry', { attempt: 2, max_retries: 10, retry_delay_ms: 8000, error_status: 529 })
    )
    expect(reducer.step(system('status', { status: 'requesting' }))).toEqual([])
  })

  it('ignores progress for a tool running inside a subagent', () => {
    const emitted = stepOnce(
      sdkMessage({
        type: 'tool_progress',
        tool_use_id: 'toolu_inner',
        tool_name: 'Grep',
        parent_tool_use_id: 'toolu_task',
        elapsed_time_seconds: 3
      })
    )
    expect(emitted).toEqual([])
  })

  it('does not add a notice for an informational line tied to a tool call', () => {
    const emitted = stepOnce(
      system('informational', { content: 'hook output', level: 'notice', tool_use_id: 'toolu_1' })
    )
    expect(emitted).toEqual([])
  })

  it('prefers a task’s own progress summary over the tool count', () => {
    const emitted = stepOnce(
      system('task_progress', {
        task_id: 'task_1',
        tool_use_id: 'toolu_task',
        description: 'Explore',
        usage: { total_tokens: 900, tool_uses: 14, duration_ms: 5000 },
        summary: 'Reading the reducer tests'
      })
    )
    expect(emitted).toEqual([
      { _tag: 'ToolCallUpdated', toolCallId: 'toolu_task', detail: 'Reading the reducer tests' }
    ])
  })
})

describe('makeSessionEventReducer — tool row updates', () => {
  it('reports a running tool call’s elapsed seconds', () => {
    const emitted = stepOnce(
      sdkMessage({
        type: 'tool_progress',
        tool_use_id: 'toolu_1',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: 42
      })
    )
    expect(emitted).toEqual([
      { _tag: 'ToolCallUpdated', toolCallId: 'toolu_1', elapsedSeconds: 42 }
    ])
  })

  it('shows why a tool call was auto-denied, preferring the decision reason', () => {
    const emitted = stepOnce(
      system('permission_denied', {
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        decision_reason: 'matches a deny rule',
        message: 'Permission denied'
      })
    )
    expect(emitted).toEqual([
      { _tag: 'ToolCallUpdated', toolCallId: 'toolu_1', detail: 'Denied: matches a deny rule' }
    ])
  })

  it('falls back to the denial message when no decision reason is given', () => {
    const emitted = stepOnce(
      system('permission_denied', {
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        message: 'Permission denied'
      })
    )
    expect(emitted).toEqual([
      { _tag: 'ToolCallUpdated', toolCallId: 'toolu_1', detail: 'Denied: Permission denied' }
    ])
  })

  it('shows a subagent’s progress on its Task row', () => {
    const emitted = stepOnce(
      system('task_progress', {
        task_id: 'task_1',
        tool_use_id: 'toolu_task',
        description: 'Explore',
        usage: { total_tokens: 900, tool_uses: 14, duration_ms: 5000 },
        last_tool_name: 'Grep'
      })
    )
    expect(emitted).toEqual([
      {
        _tag: 'ToolCallUpdated',
        toolCallId: 'toolu_task',
        detail: 'Explore · 14 tools · last: Grep'
      }
    ])
  })

  it('ignores task progress that has no tool row to attach to', () => {
    const emitted = stepOnce(
      system('task_progress', {
        task_id: 'task_1',
        description: 'Explore',
        usage: { total_tokens: 900, tool_uses: 14, duration_ms: 5000 }
      })
    )
    expect(emitted).toEqual([])
  })

  it('shows a failed task’s summary on its Task row', () => {
    const emitted = stepOnce(
      system('task_notification', {
        task_id: 'task_1',
        tool_use_id: 'toolu_task',
        status: 'failed',
        output_file: 'out.txt',
        summary: 'Agent crashed'
      })
    )
    expect(emitted).toEqual([
      { _tag: 'ToolCallUpdated', toolCallId: 'toolu_task', detail: 'Failed: Agent crashed' }
    ])
  })

  it('emits nothing for a task that completed', () => {
    const emitted = stepOnce(
      system('task_notification', {
        task_id: 'task_1',
        tool_use_id: 'toolu_task',
        status: 'completed',
        output_file: 'out.txt',
        summary: 'Done'
      })
    )
    expect(emitted).toEqual([])
  })
})

describe('makeSessionEventReducer — transcript notices', () => {
  it('records a refusal fallback naming both models', () => {
    const emitted = stepOnce(
      system('model_refusal_fallback', {
        trigger: 'refusal',
        direction: 'retry',
        original_model: 'claude-opus-5-5',
        fallback_model: 'claude-sonnet-5-5',
        request_id: null,
        content: ''
      })
    )
    expect(emitted).toEqual([
      {
        _tag: 'SessionNotice',
        text: 'claude-opus-5-5 declined the request; retried on claude-sonnet-5-5'
      }
    ])
  })

  it('records a warning-level informational message', () => {
    const emitted = stepOnce(
      system('informational', { content: 'Stop hook blocked continuation', level: 'warning' })
    )
    expect(emitted).toEqual([{ _tag: 'SessionNotice', text: 'Stop hook blocked continuation' }])
  })

  it('does not show an info-level informational message', () => {
    expect(stepOnce(system('informational', { content: 'status line', level: 'info' }))).toEqual([])
  })

  it('shows local slash command output as an assistant message', () => {
    const emitted = stepOnce(system('local_command_output', { content: 'Session cost: $0.42' }))
    expect(emitted).toEqual([
      {
        _tag: 'AssistantMessageReceived',
        message: { role: 'assistant', content: 'Session cost: $0.42' }
      }
    ])
  })

  it('warns once when the account starts approaching a named usage limit', () => {
    const reducer = makeSessionEventReducer(Option.none())
    const warning = sdkMessage({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' }
    })
    expect(reducer.step(warning)).toEqual([
      { _tag: 'SessionNotice', text: 'Approaching the 5-hour usage limit' }
    ])
    expect(reducer.step(warning)).toEqual([])
  })

  it('warns again after the usage limit status returned to allowed', () => {
    const reducer = makeSessionEventReducer(Option.none())
    const event = (status: string): SDKMessage =>
      sdkMessage({ type: 'rate_limit_event', rate_limit_info: { status } })
    reducer.step(event('allowed_warning'))
    reducer.step(event('allowed'))
    expect(reducer.step(event('allowed_warning'))).toEqual([
      { _tag: 'SessionNotice', text: 'Approaching the usage limit' }
    ])
  })
})

describe('makeSessionEventReducer — failed turn messages', () => {
  const errorResult = (subtype: string, errors: ReadonlyArray<string>): SDKMessage =>
    sdkMessage({ type: 'result', subtype, errors })

  it('names the budget limit when a turn stops on it', () => {
    expect(stepOnce(errorResult('error_max_budget_usd', []))).toEqual([
      { _tag: 'TurnErrored', error: { message: 'Stopped at the budget limit' } }
    ])
  })

  it('names the turn limit when a turn stops on it', () => {
    expect(stepOnce(errorResult('error_max_turns', []))).toEqual([
      { _tag: 'TurnErrored', error: { message: 'Stopped at the turn limit' } }
    ])
  })

  it('appends the reported errors to the failure label', () => {
    expect(stepOnce(errorResult('error_during_execution', ['boom', 'bang']))).toEqual([
      { _tag: 'TurnErrored', error: { message: 'The turn failed: boom; bang' } }
    ])
  })
})

describe('makeSessionEventReducer — ending a turn status', () => {
  const compacting = system('status', { status: 'compacting' })

  it('ends a named turn state before the turn’s next streamed text', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(compacting)
    expect(reducer.step(textDelta(0, 'Hi'))).toEqual([
      { _tag: 'TurnStatusChanged', label: null },
      { _tag: 'AssistantTextDelta', text: 'Hi' }
    ])
  })

  it('ends a named turn state before the turn starts a tool call', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(compacting)
    expect(reducer.step(toolUseStart(0, 'toolu_1', 'Bash'))[0]).toEqual({
      _tag: 'TurnStatusChanged',
      label: null
    })
  })

  it('ends a named turn state before the turn fails', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(compacting)
    const emitted = reducer.step(
      sdkMessage({ type: 'result', subtype: 'error_max_turns', errors: [] })
    )
    expect(emitted[0]).toEqual({ _tag: 'TurnStatusChanged', label: null })
  })

  it('emits nothing extra before streamed text when no state is named', () => {
    expect(stepOnce(textDelta(0, 'Hi'))).toEqual([{ _tag: 'AssistantTextDelta', text: 'Hi' }])
  })

  it('does not repeat an unchanged label', () => {
    const reducer = makeSessionEventReducer(Option.none())
    const thinking = system('thinking_tokens', {
      estimated_tokens: 1210,
      estimated_tokens_delta: 10
    })
    reducer.step(thinking)
    expect(reducer.step(thinking)).toEqual([])
  })

  it('does not report an end for a state that was never named', () => {
    expect(stepOnce(system('status', { status: null }))).toEqual([])
  })
})
