import type { AttentionState } from '@shared/domain/attention'
import {
  AwaitingPermission,
  Completed,
  Errored,
  Idle,
  PermissionRequest
} from '@shared/domain/attention'
import { ConversationMessage } from '@shared/domain/pane'
import {
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneAttentionChanged,
  PaneMessageAppended,
  PaneToolCallCompleted,
  PaneToolCallStarted
} from '@shared/ipc/contract'
import { describe, expect, it } from 'vitest'
import type { PaneChatState } from './pane-chat'
import {
  appendUserMessage,
  emptyPaneChatState,
  paneChatStateFromHistory,
  reducePaneChat
} from './pane-chat'

const PANE = '00000000-0000-4000-8000-000000000000'

const textDelta = (text: string) => PaneAssistantTextDelta.make({ paneId: PANE, text })
const thinkingDelta = (text: string) => PaneAssistantThinkingDelta.make({ paneId: PANE, text })
const toolStarted = (toolCallId: string, toolName: string) =>
  PaneToolCallStarted.make({ paneId: PANE, toolCallId, toolName })
const toolCompleted = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean
) => PaneToolCallCompleted.make({ paneId: PANE, toolCallId, toolName, input, output, isError })
const messageAppended = (role: 'user' | 'assistant', content: string) =>
  PaneMessageAppended.make({ paneId: PANE, message: ConversationMessage.make({ role, content }) })
const attentionChanged = (attention: AttentionState) =>
  PaneAttentionChanged.make({ paneId: PANE, attention })

const loadingWith = (state: PaneChatState): PaneChatState => ({ ...state, isLoading: true })

describe('paneChatStateFromHistory', () => {
  it('maps each turn to a message with a stable pane-scoped id and one text part', () => {
    const result = paneChatStateFromHistory(PANE, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])

    expect(result).toEqual({
      isLoading: false,
      messages: [
        { id: `${PANE}:history:0`, role: 'user', parts: [{ type: 'text', content: 'hi' }] },
        { id: `${PANE}:history:1`, role: 'assistant', parts: [{ type: 'text', content: 'hello' }] }
      ]
    })
  })

  it('yields no messages and a settled turn for empty history', () => {
    expect(paneChatStateFromHistory(PANE, [])).toEqual({ messages: [], isLoading: false })
  })
})

describe('appendUserMessage', () => {
  it('appends a user turn after existing messages and marks the pane loading', () => {
    const seeded = paneChatStateFromHistory(PANE, [{ role: 'assistant', content: 'earlier' }])

    const result = appendUserMessage(seeded, 'u-1', 'do the thing')

    expect(result.isLoading).toBe(true)
    expect(result.messages).toEqual([
      seeded.messages[0],
      { id: 'u-1', role: 'user', parts: [{ type: 'text', content: 'do the thing' }] }
    ])
  })
})

describe('reducePaneChat: text deltas', () => {
  it('opens a new assistant message when the last turn is the user prompt', () => {
    const afterSend = appendUserMessage(emptyPaneChatState, 'u-1', 'question')

    const result = reducePaneChat(afterSend, textDelta('Hel'))

    expect(result.isLoading).toBe(true)
    expect(result.messages).toEqual([
      afterSend.messages[0],
      { id: '1:assistant', role: 'assistant', parts: [{ type: 'text', content: 'Hel' }] }
    ])
  })

  it('concatenates consecutive text deltas into a single text part', () => {
    const afterSend = appendUserMessage(emptyPaneChatState, 'u-1', 'question')

    const result = [textDelta('Hel'), textDelta('lo')].reduce(reducePaneChat, afterSend)

    expect(result.messages.at(-1)?.parts).toEqual([{ type: 'text', content: 'Hello' }])
  })

  it('keeps the same assistant message id across successive deltas', () => {
    const afterSend = appendUserMessage(emptyPaneChatState, 'u-1', 'question')

    const first = reducePaneChat(afterSend, textDelta('a'))
    const second = reducePaneChat(first, textDelta('b'))

    expect(second.messages.at(-1)?.id).toBe(first.messages.at(-1)?.id)
    expect(second.messages).toHaveLength(2)
  })

  it('starts a fresh assistant message when a delta arrives after the previous turn settled', () => {
    const settled: PaneChatState = {
      isLoading: false,
      messages: [
        { id: '0:assistant', role: 'assistant', parts: [{ type: 'text', content: 'done' }] }
      ]
    }

    const result = reducePaneChat(settled, textDelta('next'))

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toBe(settled.messages[0])
    expect(result.messages[1]).toEqual({
      id: '1:assistant',
      role: 'assistant',
      parts: [{ type: 'text', content: 'next' }]
    })
    expect(result.isLoading).toBe(true)
  })
})

describe('reducePaneChat: thinking deltas', () => {
  it('concatenates consecutive thinking deltas into a single thinking part', () => {
    const afterSend = appendUserMessage(emptyPaneChatState, 'u-1', 'question')

    const result = [thinkingDelta('weigh'), thinkingDelta('ing')].reduce(reducePaneChat, afterSend)

    expect(result.messages.at(-1)?.parts).toEqual([{ type: 'thinking', content: 'weighing' }])
  })

  it('keeps thinking and text as distinct ordered parts of one message', () => {
    const afterSend = appendUserMessage(emptyPaneChatState, 'u-1', 'question')

    const result = [thinkingDelta('hmm'), textDelta('answer')].reduce(reducePaneChat, afterSend)

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'thinking', content: 'hmm' },
      { type: 'text', content: 'answer' }
    ])
  })
})

describe('reducePaneChat: tool calls', () => {
  it('appends a running tool-call part to the streaming assistant message', () => {
    const streaming = loadingWith({
      isLoading: true,
      messages: [
        { id: '0:assistant', role: 'assistant', parts: [{ type: 'text', content: 'let me look' }] }
      ]
    })

    const result = reducePaneChat(streaming, toolStarted('call-1', 'Bash'))

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'text', content: 'let me look' },
      { type: 'tool-call', toolCallId: 'call-1', name: 'Bash', state: 'running' }
    ])
  })

  it('resolves the matching running tool call in place with input, output, and error flag', () => {
    const streaming: PaneChatState = {
      isLoading: true,
      messages: [
        {
          id: '0:assistant',
          role: 'assistant',
          parts: [{ type: 'tool-call', toolCallId: 'call-1', name: 'Bash', state: 'running' }]
        }
      ]
    }

    const result = reducePaneChat(
      streaming,
      toolCompleted('call-1', 'Bash', { command: 'ls' }, 'file.txt', false)
    )

    expect(result.messages.at(-1)?.parts).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        name: 'Bash',
        state: 'done',
        input: { command: 'ls' },
        output: 'file.txt',
        isError: false
      }
    ])
  })

  it('leaves other tool-call parts untouched when completing one by id', () => {
    const streaming: PaneChatState = {
      isLoading: true,
      messages: [
        {
          id: '0:assistant',
          role: 'assistant',
          parts: [
            { type: 'tool-call', toolCallId: 'call-1', name: 'Bash', state: 'running' },
            { type: 'tool-call', toolCallId: 'call-2', name: 'Read', state: 'running' }
          ]
        }
      ]
    }

    const result = reducePaneChat(
      streaming,
      toolCompleted('call-2', 'Read', { file_path: '/x' }, 'body', false)
    )

    const parts = result.messages.at(-1)?.parts
    expect(parts?.[0]).toEqual({
      type: 'tool-call',
      toolCallId: 'call-1',
      name: 'Bash',
      state: 'running'
    })
    expect(parts?.[1]).toMatchObject({ toolCallId: 'call-2', state: 'done', output: 'body' })
  })

  it('preserves part order across interleaved text and tool calls in one turn', () => {
    const afterSend = appendUserMessage(emptyPaneChatState, 'u-1', 'question')

    const result = [
      textDelta('A'),
      toolStarted('call-1', 'Bash'),
      toolCompleted('call-1', 'Bash', { command: 'ls' }, 'out', false),
      textDelta('B')
    ].reduce(reducePaneChat, afterSend)

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'text', content: 'A' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        name: 'Bash',
        state: 'done',
        input: { command: 'ls' },
        output: 'out',
        isError: false
      },
      { type: 'text', content: 'B' }
    ])
  })
})

describe('reducePaneChat: PaneMessageAppended backstop', () => {
  it('appends a closed assistant turn when no deltas built one', () => {
    const settled = paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }])

    const result = reducePaneChat(settled, messageAppended('assistant', 'full reply'))

    expect(result.isLoading).toBe(false)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1]).toEqual({
      id: '1:assistant',
      role: 'assistant',
      parts: [{ type: 'text', content: 'full reply' }]
    })
  })

  it('ignores the appended assistant turn when deltas already built the streaming message', () => {
    const streaming: PaneChatState = {
      isLoading: true,
      messages: [
        { id: '0:assistant', role: 'assistant', parts: [{ type: 'text', content: 'streamed' }] }
      ]
    }

    const result = reducePaneChat(streaming, messageAppended('assistant', 'streamed'))

    expect(result).toBe(streaming)
  })

  it('ignores an appended user turn (the optimistic append already added it)', () => {
    const afterSend = appendUserMessage(emptyPaneChatState, 'u-1', 'hi')

    const result = reducePaneChat(afterSend, messageAppended('user', 'hi'))

    expect(result).toBe(afterSend)
  })
})

describe('reducePaneChat: attention', () => {
  it('ends the turn when attention reports Completed', () => {
    const streaming = loadingWith(paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(streaming, attentionChanged(Completed.make({})))

    expect(result.isLoading).toBe(false)
    expect(result.messages).toBe(streaming.messages)
  })

  it('ends the turn when attention reports Errored', () => {
    const streaming = loadingWith(paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(
      streaming,
      attentionChanged(Errored.make({ error: { message: 'boom' } }))
    )

    expect(result.isLoading).toBe(false)
  })

  it('keeps the turn loading while awaiting permission', () => {
    const streaming = loadingWith(paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(
      streaming,
      attentionChanged(
        AwaitingPermission.make({
          request: PermissionRequest.make({ requestId: 'r-1', toolName: 'Bash', input: {} })
        })
      )
    )

    expect(result).toBe(streaming)
  })

  it('leaves a loading turn unchanged when attention settles to Idle', () => {
    const streaming = loadingWith(paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(streaming, attentionChanged(Idle.make({})))

    expect(result).toBe(streaming)
  })
})
