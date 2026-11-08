import {
  type AgentItem,
  MessageItem,
  MessageUpdated,
  ReasoningItem,
  ReasoningUpdated,
  ToolCallCompleted,
  ToolCallItem,
  ToolCallStarted
} from '@shared/domain/agent-event'
import type { AttentionState } from '@shared/domain/attention'
import {
  AwaitingPermission,
  Completed,
  Crashed,
  Errored,
  Idle,
  PermissionRequest
} from '@shared/domain/attention'
import type { ConversationMessage } from '@shared/domain/pane'
import { RESUME_TEXT } from '@shared/domain/parking'
import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { SessionSetupStep, WorktreeSetupStep } from '@shared/domain/tab-setup'
import {
  PaneAgentEvent,
  PaneAttentionChanged,
  PaneBackgroundTasksChanged,
  PaneCompactionFailed,
  PaneConversationCompacted,
  PaneConversationReset,
  PaneMessageQueueChanged,
  PaneModelChanged,
  PaneRewoundToCheckpoint,
  PaneSessionNotice,
  PaneSetupProgress,
  PaneSlashCommandsAvailable,
  PaneSlashCommandsWarming,
  PaneToolCallUpdated,
  PaneTurnStatusChanged,
  PaneUserMessagesSent
} from '@shared/ipc/contract'
import { describe, expect, it } from 'vitest'
import type { PaneChatState } from './pane-chat'
import {
  emptyPaneChatState,
  isParkNotice,
  lastUserText,
  paneChatStateFromItems,
  reducePaneChat
} from './pane-chat'

const PANE = '00000000-0000-4000-8000-000000000000'

const agentEvent = (event: PaneAgentEvent['agentEvent']) =>
  PaneAgentEvent.make({ paneId: PANE, agentEvent: event })
const reply = (itemId: string, content: string, streaming = true) =>
  agentEvent(MessageUpdated.make({ itemId, message: { role: 'assistant', content }, streaming }))
const thinking = (itemId: string, text: string, streaming = true) =>
  agentEvent(ReasoningUpdated.make({ itemId, text, streaming }))
const userRecorded = (itemId: string, message: Omit<ConversationMessage, 'role'>) =>
  agentEvent(
    MessageUpdated.make({ itemId, message: { role: 'user', ...message }, streaming: false })
  )
const toolStarted = (toolCallId: string, toolName: string) =>
  agentEvent(ToolCallStarted.make({ toolCallId, toolName }))
const toolCompleted = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean
) => agentEvent(ToolCallCompleted.make({ toolCallId, toolName, input, output, isError }))
const historyOf = (turns: ReadonlyArray<ConversationMessage>): PaneChatState =>
  paneChatStateFromItems(
    turns.map((message, position) =>
      MessageItem.make({ itemId: `h-${position}`, position, streaming: false, message })
    )
  )
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
const foldAll = (state: PaneChatState, events: ReadonlyArray<PaneAgentEvent>) =>
  events.reduce((current, event) => reducePaneChat(current, event), state)

describe('paneChatStateFromItems', () => {
  it('shows each user item as a user turn and each run of assistant items as one assistant turn', () => {
    const items: ReadonlyArray<AgentItem> = [
      MessageItem.make({
        itemId: 'u-1',
        position: 0,
        streaming: false,
        message: { role: 'user', content: 'hi', checkpointUuid: 'turn-1' }
      }),
      ReasoningItem.make({ itemId: 'r-1', position: 1, streaming: false, text: 'hmm' }),
      MessageItem.make({
        itemId: 'a-1',
        position: 2,
        streaming: false,
        message: { role: 'assistant', content: 'hello' }
      })
    ]

    expect(paneChatStateFromItems(items)).toEqual({
      ...emptyPaneChatState,
      messages: [
        {
          id: 'u-1',
          role: 'user',
          parts: [{ type: 'text', content: 'hi' }],
          checkpointUuid: 'turn-1'
        },
        {
          id: 'r-1',
          role: 'assistant',
          parts: [
            { type: 'thinking', content: 'hmm', itemId: 'r-1' },
            { type: 'text', content: 'hello', itemId: 'a-1' }
          ]
        }
      ]
    })
  })

  it('yields no messages and a settled turn for no items', () => {
    expect(paneChatStateFromItems([])).toEqual(emptyPaneChatState)
  })

  it('shows a tool call stored while still running as finished', () => {
    const state = paneChatStateFromItems([
      ToolCallItem.make({ itemId: 'call-1', position: 0, running: true, toolName: 'Bash' })
    ])

    expect(state.messages[0].parts).toEqual([
      { type: 'tool-call', toolCallId: 'call-1', name: 'Bash', state: 'done' }
    ])
  })

  it('builds the same turns the reducer builds from the events that stored those items', () => {
    const events = [
      userRecorded('u-1', { content: 'question' }),
      thinking('r-1', 'weighing', false),
      reply('a-1', 'let me look', false),
      toolStarted('call-1', 'Bash'),
      toolCompleted('call-1', 'Bash', { command: 'ls' }, 'out', false),
      reply('a-2', 'done', false)
    ]
    const items: ReadonlyArray<AgentItem> = [
      MessageItem.make({
        itemId: 'u-1',
        position: 0,
        streaming: false,
        message: { role: 'user', content: 'question' }
      }),
      ReasoningItem.make({ itemId: 'r-1', position: 1, streaming: false, text: 'weighing' }),
      MessageItem.make({
        itemId: 'a-1',
        position: 2,
        streaming: false,
        message: { role: 'assistant', content: 'let me look' }
      }),
      ToolCallItem.make({
        itemId: 'call-1',
        position: 3,
        running: false,
        toolName: 'Bash',
        input: { command: 'ls' },
        output: 'out',
        isError: false
      }),
      MessageItem.make({
        itemId: 'a-2',
        position: 4,
        streaming: false,
        message: { role: 'assistant', content: 'done' }
      })
    ]

    expect(paneChatStateFromItems(items).messages).toEqual(
      foldAll(emptyPaneChatState, events).messages
    )
  })
})

describe('reducePaneChat: user messages sent', () => {
  it('drops a failed setup once the user sends a message, which starts a new conversation', () => {
    const failedSetup = reducePaneChat(
      emptyPaneChatState,
      PaneSetupProgress.make({
        paneId: PANE,
        steps: [
          WorktreeSetupStep.make({ reattach: true, state: 'done' }),
          SessionSetupStep.make({ state: 'failed', error: 'gone' })
        ]
      })
    )

    const result = sendUser(failedSetup, 'u-1', 'start again')

    expect(result.setup).toBeUndefined()
  })

  it('appends a user turn named by the message id after existing messages and marks the pane loading', () => {
    const seeded = historyOf([{ role: 'assistant', content: 'earlier' }])

    const result = sendUser(seeded, 'u-1', 'do the thing')

    expect(result.isLoading).toBe(true)
    expect(result.messages).toEqual([
      seeded.messages[0],
      { id: 'u-1', role: 'user', parts: [{ type: 'text', content: 'do the thing' }] }
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
      { id: 'u-1', role: 'user', parts: [{ type: 'text', content: 'first' }] },
      {
        id: 'u-2',
        role: 'user',
        parts: [{ type: 'text', content: 'second' }],
        rewindable: false
      },
      {
        id: 'u-3',
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

  it('keeps a message recorded before its send event in place and marks the batch on it', () => {
    const recorded = foldAll(emptyPaneChatState, [
      userRecorded('u-1', { content: 'first', checkpointUuid: 'turn-1' }),
      userRecorded('u-2', { content: 'second' })
    ])

    const result = reducePaneChat(
      recorded,
      userMessagesSent([
        { id: 'u-1', text: 'first' },
        { id: 'u-2', text: 'second' }
      ])
    )

    expect(result.messages).toEqual([
      {
        id: 'u-1',
        role: 'user',
        parts: [{ type: 'text', content: 'first' }],
        checkpointUuid: 'turn-1'
      },
      { id: 'u-2', role: 'user', parts: [{ type: 'text', content: 'second' }], rewindable: false }
    ])
  })

  it('preserves the available slash commands and the queue', () => {
    const command: SlashCommandInfo = {
      name: 'compact',
      description: '',
      argumentHint: '',
      aliases: []
    }
    const seeded = reducePaneChat(
      { ...emptyPaneChatState, slashCommands: [command] },
      queueChanged(['later'], false)
    )

    const result = sendUser(seeded, 'u-1', 'hi')

    expect(result.slashCommands).toEqual([command])
    expect(result.queued).toEqual(seeded.queued)
  })
})

describe('reducePaneChat: assistant text', () => {
  it('opens an assistant turn named by the item when the last turn is the user prompt', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = reducePaneChat(afterSend, reply('a-1', 'Hel'))

    expect(result.isLoading).toBe(true)
    expect(result.messages).toEqual([
      afterSend.messages[0],
      { id: 'a-1', role: 'assistant', parts: [{ type: 'text', content: 'Hel', itemId: 'a-1' }] }
    ])
  })

  it('replaces the text of an item shown already with its latest update', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = foldAll(afterSend, [reply('a-1', 'Hel'), reply('a-1', 'Hello', false)])

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'text', content: 'Hello', itemId: 'a-1' }
    ])
  })

  it('adds a second text item to the same assistant turn', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = foldAll(afterSend, [reply('a-1', 'one', false), reply('a-2', 'two')])

    expect(result.messages).toHaveLength(2)
    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'text', content: 'one', itemId: 'a-1' },
      { type: 'text', content: 'two', itemId: 'a-2' }
    ])
  })

  it('updates an item in an earlier turn without touching later turns', () => {
    const twoTurns = foldAll(sendUser(emptyPaneChatState, 'u-1', 'q1'), [reply('a-1', 'draft')])
    const asked = sendUser(twoTurns, 'u-2', 'q2')

    const result = reducePaneChat(asked, reply('a-1', 'final', false))

    expect(result.messages.map((message) => message.id)).toEqual(['u-1', 'a-1', 'u-2'])
    expect(result.messages[1].parts).toEqual([{ type: 'text', content: 'final', itemId: 'a-1' }])
  })

  it('does not mark an idle pane loading for an item that arrives already finished', () => {
    const result = reducePaneChat(emptyPaneChatState, reply('a-1', 'imported', false))

    expect(result.isLoading).toBe(false)
  })
})

describe('reducePaneChat: thinking', () => {
  it('replaces the text of a thinking item with its latest update', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = foldAll(afterSend, [thinking('r-1', 'weigh'), thinking('r-1', 'weighing')])

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'thinking', content: 'weighing', itemId: 'r-1' }
    ])
  })

  it('keeps thinking and text as distinct ordered parts of one message', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = foldAll(afterSend, [thinking('r-1', 'hmm'), reply('a-1', 'answer')])

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'thinking', content: 'hmm', itemId: 'r-1' },
      { type: 'text', content: 'answer', itemId: 'a-1' }
    ])
  })
})

describe('reducePaneChat: tool calls', () => {
  it('appends a running tool-call part to the streaming assistant message', () => {
    const streaming = foldAll(sendUser(emptyPaneChatState, 'u-1', 'q'), [
      reply('a-1', 'let me look')
    ])

    const result = reducePaneChat(streaming, toolStarted('call-1', 'Bash'))

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'text', content: 'let me look', itemId: 'a-1' },
      { type: 'tool-call', toolCallId: 'call-1', name: 'Bash', state: 'running' }
    ])
  })

  it('ignores a repeated start of a tool call shown already', () => {
    const started = reducePaneChat(loadingWith(emptyPaneChatState), toolStarted('call-1', 'Bash'))

    expect(reducePaneChat(started, toolStarted('call-1', 'Bash'))).toBe(started)
  })

  it('resolves the matching running tool call in place with input, output, and error flag', () => {
    const running = reducePaneChat(loadingWith(emptyPaneChatState), toolStarted('call-1', 'Bash'))

    const result = reducePaneChat(
      running,
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
    const running = foldAll(loadingWith(emptyPaneChatState), [
      toolStarted('call-1', 'Bash'),
      toolStarted('call-2', 'Read')
    ])

    const result = reducePaneChat(
      running,
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

  it('shows a completed tool call it never saw start as a finished row', () => {
    const result = reducePaneChat(
      emptyPaneChatState,
      toolCompleted('call-1', 'Bash', { command: 'ls' }, 'out', false)
    )

    expect(result.messages.at(-1)?.parts).toMatchObject([{ toolCallId: 'call-1', state: 'done' }])
  })

  it('does not mark an idle pane loading for a tool event', () => {
    const started = reducePaneChat(emptyPaneChatState, toolStarted('call-1', 'Bash'))
    const completed = reducePaneChat(
      emptyPaneChatState,
      toolCompleted('call-1', 'Bash', {}, 'out', false)
    )

    expect([started.isLoading, completed.isLoading]).toEqual([false, false])
  })

  it('preserves part order across interleaved text and tool calls in one turn', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'question')

    const result = foldAll(afterSend, [
      reply('a-1', 'A'),
      toolStarted('call-1', 'Bash'),
      toolCompleted('call-1', 'Bash', { command: 'ls' }, 'out', false),
      reply('a-2', 'B')
    ])

    expect(result.messages.at(-1)?.parts).toEqual([
      { type: 'text', content: 'A', itemId: 'a-1' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        name: 'Bash',
        state: 'done',
        input: { command: 'ls' },
        output: 'out',
        isError: false
      },
      { type: 'text', content: 'B', itemId: 'a-2' }
    ])
  })
})

describe('reducePaneChat: recorded user messages', () => {
  it('merges the checkpoint and resume uuids into the sent turn with the same id', () => {
    const afterSend = sendUser(emptyPaneChatState, 'u-1', 'deploy')

    const result = reducePaneChat(
      afterSend,
      userRecorded('u-1', {
        content: 'deploy',
        checkpointUuid: 'turn-1',
        resumeAnchorUuid: 'assistant-0'
      })
    )

    expect(result.messages).toEqual([
      {
        id: 'u-1',
        role: 'user',
        parts: [{ type: 'text', content: 'deploy' }],
        checkpointUuid: 'turn-1',
        resumeAnchorUuid: 'assistant-0'
      }
    ])
  })

  it('binds each checkpoint of a batch to its own turn whatever order they are recorded in', () => {
    const batch = reducePaneChat(
      emptyPaneChatState,
      userMessagesSent([
        { id: 'u-1', text: 'first' },
        { id: 'u-2', text: 'second' }
      ])
    )

    const result = foldAll(batch, [
      userRecorded('u-2', { content: 'second', checkpointUuid: 'turn-2' }),
      userRecorded('u-1', { content: 'first', checkpointUuid: 'turn-1' })
    ])

    expect(result.messages.map((message) => message.checkpointUuid)).toEqual(['turn-1', 'turn-2'])
  })

  it('keeps the batch flag on a sent turn when its checkpoint is recorded', () => {
    const batch = reducePaneChat(
      emptyPaneChatState,
      userMessagesSent([
        { id: 'u-1', text: 'first' },
        { id: 'u-2', text: 'second' }
      ])
    )

    const result = reducePaneChat(
      batch,
      userRecorded('u-2', { content: 'second', checkpointUuid: 'turn-2' })
    )

    expect(result.messages[1].rewindable).toBe(false)
  })

  it('appends a user turn recorded without a send event, such as one imported from the transcript', () => {
    const seeded = historyOf([{ role: 'assistant', content: 'earlier' }])

    const result = reducePaneChat(seeded, userRecorded('u-9', { content: 'typed in a terminal' }))

    expect(result.messages.at(-1)).toEqual({
      id: 'u-9',
      role: 'user',
      parts: [{ type: 'text', content: 'typed in a terminal' }]
    })
  })
})

describe('reducePaneChat: attention', () => {
  it('ends the turn when attention reports Completed', () => {
    const streaming = loadingWith(historyOf([{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(streaming, attentionChanged(Completed.make({})))

    expect(result.isLoading).toBe(false)
    expect(result.messages).toBe(streaming.messages)
  })

  it('ends the turn and appends a retryable error turn when attention reports Errored', () => {
    const streaming = loadingWith(historyOf([{ role: 'user', content: 'hi' }]))

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
    const streaming = loadingWith(historyOf([{ role: 'user', content: 'hi' }]))

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
    const streaming = loadingWith(historyOf([{ role: 'user', content: 'hi' }]))

    const awaiting = AwaitingPermission.make({
      request: PermissionRequest.make({ requestId: 'r-1', toolName: 'Bash', input: {} })
    })

    const result = reducePaneChat(streaming, attentionChanged(awaiting))

    expect(result).toEqual({ ...streaming, attention: awaiting })
  })

  it('leaves a loading turn unchanged when attention settles to Idle', () => {
    const streaming = loadingWith(historyOf([{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(streaming, attentionChanged(Idle.make({})))

    expect(result).toEqual(streaming)
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
    const seeded = historyOf([{ role: 'user', content: 'hi' }])
    const commands: ReadonlyArray<SlashCommandInfo> = [
      { name: 'compact', description: 'Compact history', argumentHint: '', aliases: [] }
    ]

    const result = reducePaneChat(seeded, slashCommandsAvailable(commands))

    expect(result.slashCommands).toEqual(commands)
    expect(result.messages).toBe(seeded.messages)
  })

  it('replaces the prior list rather than merging when a richer list arrives', () => {
    const names = reducePaneChat(
      emptyPaneChatState,
      slashCommandsAvailable([{ name: 'compact', description: '', argumentHint: '', aliases: [] }])
    )

    const enriched: SlashCommandInfo = {
      name: 'compact',
      description: 'Compact conversation history',
      argumentHint: '[instructions]',
      aliases: []
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
      { name: 'compact', description: '', argumentHint: '', aliases: [] }
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
    const streaming = loadingWith(historyOf([{ role: 'user', content: 'hi' }]))

    const result = reducePaneChat(streaming, conversationCompacted('manual', 1842, 500))

    expect(result.isLoading).toBe(true)
    expect(result.messages.slice(0, -1).map((message) => message.parts)).toEqual(
      streaming.messages.map((message) => message.parts)
    )
    expect(result.messages.at(-1)).toEqual({
      id: '1:notice',
      role: 'notice',
      parts: [{ type: 'text', content: 'Context compacted' }],
      compaction: { preTokens: 1842, postTokens: 500 }
    })
  })

  it('omits the post-compaction size when the session did not report it', () => {
    const result = reducePaneChat(emptyPaneChatState, conversationCompacted('auto', 900))

    expect(result.messages.at(-1)?.compaction).toEqual({ preTokens: 900 })
  })

  it('hides rewind on every user turn sent before the compaction', () => {
    const history = historyOf([
      { role: 'user', content: 'write note', checkpointUuid: 'turn-a' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '/compact' }
    ])

    const result = reducePaneChat(history, conversationCompacted('manual', 94533, 23665))

    expect(
      result.messages.filter((message) => message.role === 'user').map((m) => m.rewindable)
    ).toEqual([false, false])
  })

  it('keeps rewind on a user turn sent after the compaction', () => {
    const compacted = reducePaneChat(
      historyOf([{ role: 'user', content: '/compact' }]),
      conversationCompacted('manual', 94533, 23665)
    )

    const result = sendUser(compacted, 'm-c', 'edit note')

    expect(result.messages.at(-1)?.rewindable).toBeUndefined()
  })

  it('keeps a turn sent before the compaction not rewindable when its checkpoint arrives later', () => {
    const compacted = reducePaneChat(
      sendUser(emptyPaneChatState, 'u-1', '/compact'),
      conversationCompacted('manual', 94533, 23665)
    )

    const result = reducePaneChat(
      compacted,
      userRecorded('u-1', { content: '/compact', checkpointUuid: 'summary-uuid' })
    )

    expect(result.messages[0]).toMatchObject({ checkpointUuid: 'summary-uuid', rewindable: false })
  })
})

describe('reducePaneChat: compaction failure', () => {
  const failure = { reason: 'failed', message: 'Compaction failed: prompt too long' } as const
  const failed = reducePaneChat(
    emptyPaneChatState,
    PaneCompactionFailed.make({ paneId: PANE, failure })
  )

  it('holds the failure', () => {
    expect(failed.compactionFailure).toEqual(failure)
  })

  it('clears the failure on the next send', () => {
    expect(sendUser(failed, 'u-1', 'next').compactionFailure).toBeNull()
  })

  it('clears the failure when a compaction succeeds', () => {
    expect(
      reducePaneChat(failed, conversationCompacted('manual', 40_000)).compactionFailure
    ).toBeNull()
  })

  it('clears the failure on a conversation reset', () => {
    expect(reducePaneChat(failed, conversationReset()).compactionFailure).toBeNull()
  })
})

describe('reducePaneChat: model change', () => {
  it('appends a notice naming the new model by its display name', () => {
    const history = historyOf([{ role: 'user', content: 'hi' }])

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
    const command: SlashCommandInfo = {
      name: 'clear',
      description: '',
      argumentHint: '',
      aliases: []
    }
    const active = reducePaneChat(
      loadingWith(historyOf([{ role: 'user', content: 'hi' }])),
      slashCommandsAvailable([command])
    )

    const result = reducePaneChat(active, conversationReset())

    expect(result.messages).toEqual([])
    expect(result.isLoading).toBe(false)
    expect(result.slashCommands).toEqual([command])
  })
})

describe('reducePaneChat: rewind to checkpoint', () => {
  const branched = historyOf([
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
        id: 'u-1',
        role: 'user',
        parts: [{ type: 'text', content: 'sent during rewind' }]
      }
    ])
    expect(result.isLoading).toBe(true)
  })

  it('drops an assistant reply that streamed in after the anchored turn', () => {
    const streamed = reducePaneChat(loadingWith(branched), reply('late', 'late reply'))

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

describe('reducePaneChat — turn status, tool row updates and notices', () => {
  const turnStatus = (label: string | null) => PaneTurnStatusChanged.make({ paneId: PANE, label })
  const toolUpdated = (fields: { elapsedSeconds?: number; detail?: string }) =>
    PaneToolCallUpdated.make({ paneId: PANE, toolCallId: 'toolu_1', ...fields })
  const loading = loadingWith(emptyPaneChatState)

  it('sets a running tool row’s input when it arrives before the call completes', () => {
    const started = reducePaneChat(loading, toolStarted('toolu_1', 'Bash'))
    const updated = reducePaneChat(
      started,
      PaneToolCallUpdated.make({ paneId: PANE, toolCallId: 'toolu_1', input: { command: 'ls' } })
    )
    expect(updated.messages.at(-1)?.parts[0]).toMatchObject({
      state: 'running',
      input: { command: 'ls' }
    })
  })

  it('names the in-flight turn’s state', () => {
    const state = reducePaneChat(loading, turnStatus('Compacting conversation'))
    expect(state.turnStatus).toBe('Compacting conversation')
  })

  it('clears a turn status left from the previous turn when the user sends again', () => {
    const stale = { ...emptyPaneChatState, turnStatus: 'Compacting conversation' }
    const sent = reducePaneChat(
      stale,
      PaneUserMessagesSent.make({ paneId: PANE, messages: [{ id: 'u-1', text: 'hi' }] })
    )
    expect(sent.turnStatus).toBeNull()
  })

  it('ends the turn status when the session clears it', () => {
    const compacting = reducePaneChat(loading, turnStatus('Compacting conversation'))
    expect(reducePaneChat(compacting, turnStatus(null)).turnStatus).toBeNull()
  })

  it('sets a running tool row’s elapsed time and detail without changing its state', () => {
    const running = reducePaneChat(loading, toolStarted('toolu_1', 'Task'))
    const timed = reducePaneChat(running, toolUpdated({ elapsedSeconds: 42 }))
    const detailed = reducePaneChat(timed, toolUpdated({ detail: 'Explore · 3 tools' }))
    expect(detailed.messages.at(-1)?.parts).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'toolu_1',
        name: 'Task',
        state: 'running',
        elapsedSeconds: 42,
        detail: 'Explore · 3 tools'
      }
    ])
  })

  it('ignores a tool row update for a turn that has ended', () => {
    const running = reducePaneChat(loading, toolStarted('toolu_1', 'Task'))
    const ended = reducePaneChat(running, attentionChanged(Completed.make({})))
    expect(reducePaneChat(ended, toolUpdated({ detail: 'late' }))).toBe(ended)
  })

  it('keeps resolving a running tool row after a notice lands mid-turn', () => {
    const running = reducePaneChat(loading, toolStarted('toolu_1', 'Bash'))
    const noticed = reducePaneChat(
      running,
      PaneSessionNotice.make({ paneId: PANE, text: 'Approaching the 5-hour usage limit' })
    )
    const updated = reducePaneChat(noticed, toolUpdated({ elapsedSeconds: 7 }))
    const completed = reducePaneChat(updated, toolCompleted('toolu_1', 'Bash', {}, 'ok', false))
    expect(completed.messages.map((message) => message.role)).toEqual(['assistant', 'notice'])
    expect(completed.messages[0]?.parts).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'toolu_1',
        name: 'Bash',
        state: 'done',
        elapsedSeconds: 7,
        input: {},
        output: 'ok',
        isError: false
      }
    ])
  })

  it("keeps a session notice's link on its notice divider", () => {
    const link = { label: 'Open', plugin: 'org', page: 'org', target: 'objective-1' }
    const state = reducePaneChat(
      emptyPaneChatState,
      PaneSessionNotice.make({ paneId: PANE, text: 'Ada moved "Fix the typo" to in review.', link })
    )
    expect(state.messages.map((message) => message.link)).toEqual([link])
  })

  it('appends a session notice as a notice divider', () => {
    const state = reducePaneChat(
      emptyPaneChatState,
      PaneSessionNotice.make({ paneId: PANE, text: 'Approaching the 5-hour usage limit' })
    )
    expect(state.messages).toEqual([
      {
        id: '0:notice',
        role: 'notice',
        parts: [{ type: 'text', content: 'Approaching the 5-hour usage limit' }]
      }
    ])
  })
})

describe('reducePaneChat: arrival times', () => {
  const loading = loadingWith(emptyPaneChatState)
  const partsOf = (state: PaneChatState) => state.messages.at(-1)?.parts

  it('stamps a new text part with the time its first update arrived, and keeps it as it grows', () => {
    const opened = reducePaneChat(loading, reply('a-1', 'Hel'), 1_000)
    const grown = reducePaneChat(opened, reply('a-1', 'Hello'), 2_500)
    expect(partsOf(grown)).toEqual([
      { type: 'text', content: 'Hello', itemId: 'a-1', startedAt: 1_000 }
    ])
  })

  it('stamps a new thinking part with the time its first update arrived', () => {
    const opened = reducePaneChat(loading, thinking('r-1', 'weigh'), 1_000)
    const grown = reducePaneChat(opened, thinking('r-1', 'weighing'), 2_500)
    expect(partsOf(grown)).toEqual([
      { type: 'thinking', content: 'weighing', itemId: 'r-1', startedAt: 1_000 }
    ])
  })

  it('stamps a tool call with its start time and, on completion, its end time', () => {
    const started = reducePaneChat(loading, toolStarted('toolu_1', 'Read'), 1_000)
    const done = reducePaneChat(
      started,
      toolCompleted('toolu_1', 'Read', { file_path: 'a.ts' }, 'ok', false),
      4_000
    )
    expect(partsOf(done)).toMatchObject([{ startedAt: 1_000, endedAt: 4_000, state: 'done' }])
  })

  it('leaves parts without times when no arrival time is given', () => {
    const started = reducePaneChat(loading, toolStarted('toolu_1', 'Read'))
    expect(partsOf(started)?.[0]).not.toHaveProperty('startedAt')
  })
})

describe('reducePaneChat: parked turns', () => {
  const signedOut = { _tag: 'ParkedForUser' as const, cause: { _tag: 'SignedOut' as const } }
  const unknownReset = {
    _tag: 'ParkedForUser' as const,
    cause: { _tag: 'UsageLimit' as const, resetsAt: null }
  }
  const limitHasReset = {
    _tag: 'ParkedForUser' as const,
    cause: { _tag: 'UsageLimit' as const, resetsAt: 1000 }
  }
  const resuming = {
    _tag: 'ParkedToResume' as const,
    cause: { _tag: 'UsageLimit' as const, resetsAt: 1000 },
    resumesAt: 6000
  }
  const untilReset = {
    _tag: 'ParkedUntilReset' as const,
    cause: { _tag: 'UsageLimit' as const, resetsAt: 1000 },
    resetsAt: 1000
  }
  const noticeTexts = (state: PaneChatState) =>
    state.messages
      .filter((message) => message.role === 'notice')
      .map((message) => message.parts.find((part) => part.type === 'text')?.content)

  it('stops loading and adds a park notice that names the cause', () => {
    const state = reducePaneChat(loadingWith(emptyPaneChatState), attentionChanged(signedOut))
    expect(state.isLoading).toBe(false)
    expect(noticeTexts(state)).toEqual(['Claude Code is not signed in'])
    expect(state.messages.every(isParkNotice)).toBe(true)
  })

  it('says only that the limit was reached when its reset time is unknown', () => {
    const state = reducePaneChat(emptyPaneChatState, attentionChanged(unknownReset))
    expect(noticeTexts(state)).toEqual(['Usage limit reached'])
  })

  it('says the limit has reset once the user can resume the agent', () => {
    const state = reducePaneChat(emptyPaneChatState, attentionChanged(limitHasReset))
    expect(noticeTexts(state)).toEqual(['Usage limit has reset'])
  })

  it('names when dia resumes an agent it resumes on its own', () => {
    const state = reducePaneChat(emptyPaneChatState, attentionChanged(resuming))
    expect(noticeTexts(state)[0]).toMatch(/^Usage limit reached · dia resumes at \S/)
  })

  it('names when the user can resume an agent waiting for its reset', () => {
    const state = reducePaneChat(emptyPaneChatState, attentionChanged(untilReset))
    expect(noticeTexts(state)[0]).toMatch(/^Usage limit reached · you can resume at \S/)
  })

  it('replaces the park notice when the agent is parked again, instead of repeating it', () => {
    const parkedTwice = [untilReset, limitHasReset].reduce(
      (state, attention) => reducePaneChat(state, attentionChanged(attention)),
      emptyPaneChatState
    )
    expect(noticeTexts(parkedTwice)).toEqual(['Usage limit has reset'])
  })

  it('records a resume: the notice drops its future time and the continue turn carries when it resumed', () => {
    const parked = reducePaneChat(emptyPaneChatState, attentionChanged(resuming))
    const resumed = sendUser(parked, 'm-1', RESUME_TEXT)
    expect(noticeTexts(resumed)).toEqual(['Usage limit reached'])
    expect(resumed.messages.some(isParkNotice)).toBe(false)
    const turn = resumed.messages.at(-1)
    expect(turn?.role).toBe('user')
    expect(typeof turn?.resumedAt).toBe('number')
  })

  it('resolves the park notice for any message sent while parked, marking only a continue as a resume', () => {
    const parked = reducePaneChat(emptyPaneChatState, attentionChanged(signedOut))
    const sent = sendUser(parked, 'm-1', 'try again')
    expect(sent.messages.some(isParkNotice)).toBe(false)
    expect(sent.messages.at(-1)?.resumedAt).toBeUndefined()
  })

  it('drops the future time from the park notice when the agent leaves parked without a resume', () => {
    const parked = reducePaneChat(emptyPaneChatState, attentionChanged(resuming))
    const interrupted = reducePaneChat(parked, attentionChanged({ _tag: 'Idle' }))
    expect(noticeTexts(interrupted)).toEqual(['Usage limit reached'])
    expect(interrupted.messages.some(isParkNotice)).toBe(false)
  })

  it('does not mark a continue sent while the agent is not parked', () => {
    const sent = sendUser(emptyPaneChatState, 'm-1', RESUME_TEXT)
    expect(sent.messages.at(-1)?.resumedAt).toBeUndefined()
  })

  it('keeps an earlier park notice once other messages follow it', () => {
    const parked = reducePaneChat(emptyPaneChatState, attentionChanged(signedOut))
    const resumed = sendUser(parked, 'm-1', RESUME_TEXT)
    const parkedAgain = reducePaneChat(resumed, attentionChanged(signedOut))
    expect(noticeTexts(parkedAgain)).toEqual([
      'Claude Code is not signed in',
      'Claude Code is not signed in'
    ])
  })
})

describe('reducePaneChat — background tasks', () => {
  const watcher = { taskId: 'b1', description: 'Run the test watcher' }
  const reviewer = { taskId: 'a1', description: 'Review the diff' }
  const tasksChanged = (tasks: ReadonlyArray<{ taskId: string; description: string }>) =>
    PaneBackgroundTasksChanged.make({ paneId: PANE, tasks })
  const running = reducePaneChat(emptyPaneChatState, tasksChanged([watcher, reviewer]))

  it('starts with no background tasks', () => {
    expect(emptyPaneChatState.backgroundTasks).toEqual([])
  })

  it('replaces the set with each report instead of merging it', () => {
    expect(reducePaneChat(running, tasksChanged([reviewer])).backgroundTasks).toEqual([reviewer])
  })

  it('keeps the set when the conversation is cleared, because the process keeps running', () => {
    expect(reducePaneChat(running, conversationReset()).backgroundTasks).toEqual([
      watcher,
      reviewer
    ])
  })

  it('empties the set when the session crashes', () => {
    const crashed = reducePaneChat(
      running,
      attentionChanged(Crashed.make({ error: { message: 'process exited' } }))
    )
    expect(crashed.backgroundTasks).toEqual([])
  })

  it('keeps the set when a turn errors, because the process keeps running', () => {
    const errored = reducePaneChat(
      running,
      attentionChanged(Errored.make({ error: { message: 'declined' } }))
    )
    expect(errored.backgroundTasks).toEqual([watcher, reviewer])
  })

  it('empties the set on a rewind, which restarts the session process', () => {
    expect(reducePaneChat(running, rewoundToCheckpoint('u1')).backgroundTasks).toEqual([])
  })
})
