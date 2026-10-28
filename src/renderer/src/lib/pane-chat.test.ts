import type { AttentionState } from '@shared/domain/attention'
import {
  AwaitingPermission,
  Completed,
  Crashed,
  Errored,
  Idle,
  PermissionRequest
} from '@shared/domain/attention'
import { ConversationMessage } from '@shared/domain/pane'
import type { SlashCommandInfo } from '@shared/domain/slash-command'
import {
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneAttentionChanged,
  PaneCheckpointAvailable,
  PaneConversationCompacted,
  PaneConversationReset,
  PaneMessageAppended,
  PaneMessageQueueChanged,
  PaneModelChanged,
  PaneRewoundToCheckpoint,
  PaneSlashCommandsAvailable,
  PaneSlashCommandsWarming,
  PaneToolCallCompleted,
  PaneToolCallStarted,
  PaneUserMessagesSent
} from '@shared/ipc/contract'
import { describe, expect, it } from 'vitest'
import type { PaneChatState } from './pane-chat'
import {
  emptyPaneChatState,
  lastUserText,
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
const slashCommandsAvailable = (commands: ReadonlyArray<SlashCommandInfo>) =>
  PaneSlashCommandsAvailable.make({ paneId: PANE, commands })
const slashCommandsWarming = (active: boolean) =>
  PaneSlashCommandsWarming.make({ paneId: PANE, active })
const conversationCompacted = (
  trigger: 'manual' | 'auto',
  preTokens: number,
  postTokens?: number
) =>
  PaneConversationCompacted.make({
    paneId: PANE,
    trigger,
    preTokens,
    ...(postTokens !== undefined ? { postTokens } : {})
  })
const conversationReset = () => PaneConversationReset.make({ paneId: PANE })
const checkpointAvailable = (messageUuid: string, resumeAnchorUuid?: string) =>
  PaneCheckpointAvailable.make({
    paneId: PANE,
    messageUuid,
    ...(resumeAnchorUuid !== undefined ? { resumeAnchorUuid } : {})
  })
const rewoundToCheckpoint = (messageUuid: string) =>
  PaneRewoundToCheckpoint.make({ paneId: PANE, messageUuid })

const loadingWith = (state: PaneChatState): PaneChatState => ({ ...state, isLoading: true })
const userMessagesSent = (messages: ReadonlyArray<{ id: string; text: string }>) =>
  PaneUserMessagesSent.make({ paneId: PANE, messages })
const sendUser = (state: PaneChatState, id: string, text: string): PaneChatState =>
  reducePaneChat(state, userMessagesSent([{ id, text }]))
const queueChanged = (texts: ReadonlyArray<string>, held: boolean) =>
  PaneMessageQueueChanged.make({
    paneId: PANE,
    queued: texts.map((text, index) => ({ id: `q-${index}`, text })),
    held
  })

describe('paneChatStateFromHistory', () => {
  it('maps each turn to a message with a stable pane-scoped id and one text part', () => {
    const result = paneChatStateFromHistory(PANE, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])

    expect(result).toEqual({
      isLoading: false,
      slashCommands: [],
      warmingCommands: false,
      queued: [],
      queueHeld: false,
      messages: [
        { id: `${PANE}:history:0`, role: 'user', parts: [{ type: 'text', content: 'hi' }] },
        { id: `${PANE}:history:1`, role: 'assistant', parts: [{ type: 'text', content: 'hello' }] }
      ]
    })
  })

  it('yields no messages and a settled turn for empty history', () => {
    expect(paneChatStateFromHistory(PANE, [])).toEqual({
      messages: [],
      isLoading: false,
      slashCommands: [],
      warmingCommands: false,
      queued: [],
      queueHeld: false
    })
  })

  it('carries a restored user turn’s checkpoint uuid onto its message', () => {
    const result = paneChatStateFromHistory(PANE, [
      { role: 'user', content: 'hi', checkpointUuid: 'turn-1' },
      { role: 'assistant', content: 'hello' }
    ])

    expect(result.messages[0].checkpointUuid).toBe('turn-1')
    expect(result.messages[1].checkpointUuid).toBeUndefined()
  })
})

describe('reducePaneChat: user messages sent', () => {
  it('appends a user turn with a pane-scoped id after existing messages and marks the pane loading', () => {
    const seeded = paneChatStateFromHistory(PANE, [{ role: 'assistant', content: 'earlier' }])

    const result = sendUser(seeded, 'u-1', 'do the thing')

    expect(result.isLoading).toBe(true)
    expect(result.messages).toEqual([
      seeded.messages[0],
      { id: `${PANE}:user:u-1`, role: 'user', parts: [{ type: 'text', content: 'do the thing' }] }
    ])
  })

  it('appends one user turn per message of a batch, in order, marking all but the first not rewindable', () => {
    const result = reducePaneChat(
      emptyPaneChatState,
      userMessagesSent([
        { id: 'u-1', text: 'first' },
        { id: 'u-2', text: 'second' },
        { id: 'u-3', text: 'third' }
      ])
    )

    expect(result.messages).toEqual([
      { id: `${PANE}:user:u-1`, role: 'user', parts: [{ type: 'text', content: 'first' }] },
      {
        id: `${PANE}:user:u-2`,
        role: 'user',
        parts: [{ type: 'text', content: 'second' }],
        rewindable: false
      },
      {
        id: `${PANE}:user:u-3`,
        role: 'user',
        parts: [{ type: 'text', content: 'third' }],
        rewindable: false
      }
    ])
  })

  it('does not append a message a second time when its event is delivered again', () => {
    const once = sendUser(emptyPaneChatState, 'u-1', 'hi')

    const twice = sendUser(once, 'u-1', 'hi')

    expect(twice.messages).toEqual(once.messages)
  })

  it('preserves the available slash commands and the queue', () => {
    const command: SlashCommandInfo = { name: 'compact', description: '', argumentHint: '' }
    const seeded = reducePaneChat(
      { ...emptyPaneChatState, slashCommands: [command] },
      queueChanged(['later'], false)
    )

    const result = sendUser(seeded, 'u-1', 'hi')

    expect(result.slashCommands).toEqual([command])
    expect(result.queued).toEqual(seeded.queued)
  })
})

describe('reducePaneChat: text deltas', () => {
  it('opens a new assistant message when the last turn is the user prompt', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = reducePaneChat(afterSend, textDelta('Hel'))

    expect(result.isLoading).toBe(true)
    expect(result.messages).toEqual([
      afterSend.messages[0],
      { id: '1:assistant', role: 'assistant', parts: [{ type: 'text', content: 'Hel' }] }
    ])
  })

  it('concatenates consecutive text deltas into a single text part', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = [textDelta('Hel'), textDelta('lo')].reduce(reducePaneChat, afterSend)

    expect(result.messages.at(-1)?.parts).toEqual([{ type: 'text', content: 'Hello' }])
  })

  it('keeps the same assistant message id across successive deltas', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const first = reducePaneChat(afterSend, textDelta('a'))
    const second = reducePaneChat(first, textDelta('b'))

    expect(second.messages.at(-1)?.id).toBe(first.messages.at(-1)?.id)
    expect(second.messages).toHaveLength(2)
  })

  it('starts a fresh assistant message when a delta arrives after the previous turn settled', () => {
    const settled: PaneChatState = {
      isLoading: false,
      slashCommands: [],
      warmingCommands: false,
      queued: [],
      queueHeld: false,
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
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = [thinkingDelta('weigh'), thinkingDelta('ing')].reduce(reducePaneChat, afterSend)

    expect(result.messages.at(-1)?.parts).toEqual([{ type: 'thinking', content: 'weighing' }])
  })

  it('keeps thinking and text as distinct ordered parts of one message', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

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
      slashCommands: [],
      warmingCommands: false,
      queued: [],
      queueHeld: false,
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
      slashCommands: [],
      warmingCommands: false,
      queued: [],
      queueHeld: false,
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
      slashCommands: [],
      warmingCommands: false,
      queued: [],
      queueHeld: false,
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
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

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
      slashCommands: [],
      warmingCommands: false,
      queued: [],
      queueHeld: false,
      messages: [
        { id: '0:assistant', role: 'assistant', parts: [{ type: 'text', content: 'streamed' }] }
      ]
    }

    const result = reducePaneChat(streaming, messageAppended('assistant', 'streamed'))

    expect(result).toBe(streaming)
  })

  it('ignores an appended user turn (PaneUserMessagesSent already added it)', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'hi')

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

  it('ends the turn and appends a retryable error turn when attention reports Errored', () => {
    const streaming = loadingWith(paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(
      streaming,
      attentionChanged(Errored.make({ error: { message: 'boom' } }))
    )

    expect(result.isLoading).toBe(false)
    const appended = result.messages.at(-1)
    expect(appended?.role).toBe('error')
    expect(appended?.parts).toEqual([{ type: 'text', content: 'boom' }])
  })

  it('ends the turn and appends an error turn when attention reports Crashed', () => {
    const streaming = loadingWith(paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(
      streaming,
      attentionChanged(Crashed.make({ error: { message: 'process exited' } }))
    )

    expect(result.isLoading).toBe(false)
    const appended = result.messages.at(-1)
    expect(appended?.role).toBe('error')
    expect(appended?.parts).toEqual([{ type: 'text', content: 'process exited' }])
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

describe('lastUserText', () => {
  it('returns undefined when there is no user turn', () => {
    expect(lastUserText(emptyPaneChatState)).toBeUndefined()
  })

  it('returns the most recent user turn text, ignoring later assistant/error turns', () => {
    const withTurns = reducePaneChat(
      sendUser(sendUser(emptyPaneChatState, 'u-1', 'first question'), 'u-2', 'second question'),
      attentionChanged(Errored.make({ error: { message: 'boom' } }))
    )

    expect(lastUserText(withTurns)).toBe('second question')
  })

  it('returns the last message of a batch sent as one turn', () => {
    const batch = reducePaneChat(
      emptyPaneChatState,
      userMessagesSent([
        { id: 'u-1', text: 'first' },
        { id: 'u-2', text: 'last' }
      ])
    )

    expect(lastUserText(batch)).toBe('last')
  })
})

describe('reducePaneChat: slash commands', () => {
  it('sets the available slash-command list without touching the transcript', () => {
    const seeded = paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }])
    const commands: ReadonlyArray<SlashCommandInfo> = [
      { name: 'compact', description: 'Compact history', argumentHint: '' }
    ]

    const result = reducePaneChat(seeded, slashCommandsAvailable(commands))

    expect(result.slashCommands).toEqual(commands)
    expect(result.messages).toBe(seeded.messages)
  })

  it('replaces the prior list rather than merging when a richer list arrives', () => {
    const names = reducePaneChat(
      emptyPaneChatState,
      slashCommandsAvailable([{ name: 'compact', description: '', argumentHint: '' }])
    )

    const enriched: SlashCommandInfo = {
      name: 'compact',
      description: 'Compact conversation history',
      argumentHint: '[instructions]'
    }
    const result = reducePaneChat(names, slashCommandsAvailable([enriched]))

    expect(result.slashCommands).toEqual([enriched])
  })

  it('raises the warming indicator when a warm-up starts', () => {
    const result = reducePaneChat(emptyPaneChatState, slashCommandsWarming(true))

    expect(result.warmingCommands).toBe(true)
  })

  it('clears the warming indicator when the available list arrives', () => {
    const warming = reducePaneChat(emptyPaneChatState, slashCommandsWarming(true))
    const commands: ReadonlyArray<SlashCommandInfo> = [
      { name: 'compact', description: '', argumentHint: '' }
    ]

    const result = reducePaneChat(warming, slashCommandsAvailable(commands))

    expect(result.warmingCommands).toBe(false)
    expect(result.slashCommands).toEqual(commands)
  })

  it('clears the warming indicator when the warm-up fails without a list', () => {
    const warming = reducePaneChat(emptyPaneChatState, slashCommandsWarming(true))

    const result = reducePaneChat(warming, slashCommandsWarming(false))

    expect(result.warmingCommands).toBe(false)
    expect(result.slashCommands).toEqual([])
  })
})

describe('reducePaneChat: conversation compaction', () => {
  it('appends a notice divider with the token span, keeping prior messages and load state', () => {
    const streaming = loadingWith(paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(streaming, conversationCompacted('manual', 1842, 500))

    expect(result.isLoading).toBe(true)
    expect(result.messages.slice(0, -1)).toEqual(streaming.messages)
    expect(result.messages.at(-1)).toEqual({
      id: '1:notice',
      role: 'notice',
      parts: [{ type: 'text', content: 'Context compacted — 1842 → 500 tokens' }]
    })
  })

  it('omits the token span when the post-compaction size is unknown', () => {
    const result = reducePaneChat(emptyPaneChatState, conversationCompacted('auto', 900))

    expect(result.messages.at(-1)?.parts).toEqual([{ type: 'text', content: 'Context compacted' }])
  })
})

describe('reducePaneChat: model change', () => {
  it('appends a notice naming the new model by its display name', () => {
    const history = paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }])

    const result = reducePaneChat(history, {
      ...PaneModelChanged.make({ paneId: PANE, model: 'claude-opus-5' }),
      displayName: 'Opus'
    })

    expect(result.messages.at(-1)).toEqual({
      id: '1:notice',
      role: 'notice',
      parts: [{ type: 'text', content: 'Model → Opus' }]
    })
  })

  it('names the model by its raw id when the model list does not have it', () => {
    const result = reducePaneChat(
      emptyPaneChatState,
      PaneModelChanged.make({ paneId: PANE, model: 'claude-opus-5' })
    )

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'text', content: 'Model → claude-opus-5' }
    ])
  })
})

describe('reducePaneChat: conversation reset', () => {
  it('clears messages and load state while preserving the available slash commands', () => {
    const command: SlashCommandInfo = { name: 'clear', description: '', argumentHint: '' }
    const active = reducePaneChat(
      loadingWith(paneChatStateFromHistory(PANE, [{ role: 'user', content: 'hi' }])),
      slashCommandsAvailable([command])
    )

    const result = reducePaneChat(active, conversationReset())

    expect(result.messages).toEqual([])
    expect(result.isLoading).toBe(false)
    expect(result.slashCommands).toEqual([command])
  })
})

describe('reducePaneChat: checkpoint availability', () => {
  it('anchors the uuid onto the sent user turn that had none', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'deploy')

    const result = reducePaneChat(afterSend, checkpointAvailable('turn-1'))

    expect(result.messages[0].checkpointUuid).toBe('turn-1')
  })

  it('binds to the earliest un-anchored user turn when several await one', () => {
    const twoPending = sendUser(sendUser(emptyPaneChatState, 'u-1', 'first'), 'u-2', 'second')

    const result = reducePaneChat(twoPending, checkpointAvailable('turn-1'))

    expect(result.messages[0].checkpointUuid).toBe('turn-1')
    expect(result.messages[1].checkpointUuid).toBeUndefined()
  })

  it('skips a user turn already anchored and binds the next un-anchored one', () => {
    const restoredThenSent = sendUser(
      paneChatStateFromHistory(PANE, [{ role: 'user', content: 'earlier', checkpointUuid: 'a' }]),
      'u-2',
      'later'
    )

    const result = reducePaneChat(restoredThenSent, checkpointAvailable('b'))

    expect(result.messages[0].checkpointUuid).toBe('a')
    expect(result.messages[1].checkpointUuid).toBe('b')
  })

  it('leaves messages untouched when no user turn awaits a uuid', () => {
    const seeded = paneChatStateFromHistory(PANE, [
      { role: 'user', content: 'hi', checkpointUuid: 'a' }
    ])

    const result = reducePaneChat(seeded, checkpointAvailable('b'))

    expect(result.messages).toBe(seeded.messages)
  })

  it('anchors the resume uuid alongside the checkpoint uuid when present', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'deploy')

    const result = reducePaneChat(afterSend, checkpointAvailable('turn-1', 'assistant-0'))

    expect(result.messages[0].checkpointUuid).toBe('turn-1')
    expect(result.messages[0].resumeAnchorUuid).toBe('assistant-0')
  })

  it('leaves the resume uuid absent when the checkpoint carries none (first turn)', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'deploy')

    const result = reducePaneChat(afterSend, checkpointAvailable('turn-1'))

    expect(result.messages[0].checkpointUuid).toBe('turn-1')
    expect(result.messages[0].resumeAnchorUuid).toBeUndefined()
  })

  it('binds the checkpoints of a batch to its user turns in send order', () => {
    const batch = reducePaneChat(
      emptyPaneChatState,
      userMessagesSent([
        { id: 'u-1', text: 'first' },
        { id: 'u-2', text: 'second' }
      ])
    )

    const result = [checkpointAvailable('turn-1'), checkpointAvailable('turn-2')].reduce(
      reducePaneChat,
      batch
    )

    expect(result.messages.map((message) => message.checkpointUuid)).toEqual(['turn-1', 'turn-2'])
  })
})

describe('reducePaneChat: rewind to checkpoint', () => {
  const branched = paneChatStateFromHistory(PANE, [
    { role: 'user', content: 'first', checkpointUuid: 'a' },
    { role: 'assistant', content: 'reply one' },
    { role: 'user', content: 'second', checkpointUuid: 'b' },
    { role: 'assistant', content: 'reply two' }
  ])

  it('drops the anchored turn and everything after it', () => {
    const result = reducePaneChat(loadingWith(branched), rewoundToCheckpoint('a'))

    expect(result.messages).toEqual([])
  })

  it('keeps the anchor turn predecessors when rewinding to a later turn', () => {
    const result = reducePaneChat(branched, rewoundToCheckpoint('b'))

    expect(result.messages).toEqual(branched.messages.slice(0, 2))
  })

  it('ends any in-flight turn on rewind', () => {
    const result = reducePaneChat(loadingWith(branched), rewoundToCheckpoint('a'))

    expect(result.isLoading).toBe(false)
  })

  it('leaves the transcript intact when no turn matches the uuid', () => {
    const result = reducePaneChat(branched, rewoundToCheckpoint('missing'))

    expect(result.messages).toBe(branched.messages)
  })

  it('places a user turn reported after the rewind after the truncated transcript', () => {
    const rewound = reducePaneChat(branched, rewoundToCheckpoint('b'))

    const result = sendUser(rewound, 'u-1', 'sent during rewind')

    expect(result.messages).toEqual([
      ...branched.messages.slice(0, 2),
      {
        id: `${PANE}:user:u-1`,
        role: 'user',
        parts: [{ type: 'text', content: 'sent during rewind' }]
      }
    ])
    expect(result.isLoading).toBe(true)
  })

  it('drops an assistant reply that streamed in after the anchored turn', () => {
    const streamed = reducePaneChat(loadingWith(branched), textDelta('late reply'))

    const result = reducePaneChat(streamed, rewoundToCheckpoint('b'))

    expect(result.messages).toEqual(branched.messages.slice(0, 2))
  })

  it('drops a user turn reported before the rewind along with the turns after the anchor', () => {
    const sentBefore = sendUser(branched, 'u-1', 'sent before rewind')

    const result = reducePaneChat(sentBefore, rewoundToCheckpoint('b'))

    expect(result.messages).toEqual(branched.messages.slice(0, 2))
  })
})

describe('reducePaneChat: message queue', () => {
  it('replaces the queue and its held flag with the reported ones', () => {
    const first = reducePaneChat(emptyPaneChatState, queueChanged(['one', 'two'], false))

    const result = reducePaneChat(first, queueChanged(['two'], true))

    expect(result.queued).toEqual([{ id: 'q-0', text: 'two' }])
    expect(result.queueHeld).toBe(true)
    expect(result.messages).toBe(first.messages)
  })

  it('empties the queue when the pane crashes', () => {
    const queued = reducePaneChat(loadingWith(emptyPaneChatState), queueChanged(['later'], true))

    const result = reducePaneChat(
      queued,
      attentionChanged(Crashed.make({ error: { message: 'process exited' } }))
    )

    expect(result.queued).toEqual([])
    expect(result.queueHeld).toBe(false)
  })

  it('keeps the queue when a turn errors', () => {
    const queued = reducePaneChat(loadingWith(emptyPaneChatState), queueChanged(['later'], true))

    const result = reducePaneChat(
      queued,
      attentionChanged(Errored.make({ error: { message: 'boom' } }))
    )

    expect(result.queued).toEqual(queued.queued)
    expect(result.queueHeld).toBe(true)
  })

  it('keeps the queue across a conversation reset', () => {
    const queued = reducePaneChat(emptyPaneChatState, queueChanged(['later'], false))

    const result = reducePaneChat(queued, conversationReset())

    expect(result.queued).toEqual(queued.queued)
  })
})
