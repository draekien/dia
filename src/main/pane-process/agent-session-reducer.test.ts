import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { makeSessionEventReducer } from './agent-session-reducer'
import type { OutboundMessage } from './protocol'

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
      speed: null
    }
  }
})

const userMessage = (content: UserContent): SDKMessage => ({
  type: 'user',
  parent_tool_use_id: null,
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

const run = (messages: ReadonlyArray<SDKMessage>): OutboundMessage[] => {
  const reducer = makeSessionEventReducer()
  return messages.flatMap((message) => [...reducer.step(message)])
}

const textDeltas = (emitted: ReadonlyArray<OutboundMessage>): string[] =>
  emitted.flatMap((message) => (message._tag === 'AssistantTextDelta' ? [message.text] : []))

const toolCompletions = (
  emitted: ReadonlyArray<OutboundMessage>
): Extract<OutboundMessage, { _tag: 'ToolCallCompleted' }>[] =>
  emitted.flatMap((message) => (message._tag === 'ToolCallCompleted' ? [message] : []))

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
