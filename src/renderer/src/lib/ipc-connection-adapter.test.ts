import { AwaitingPermission, Completed, Errored, PermissionRequest } from '@shared/domain/attention'
import {
  PaneAssistantTextDelta,
  PaneAssistantThinkingDelta,
  PaneAttentionChanged,
  PaneMessageAppended,
  PaneToolCallCompleted,
  PaneToolCallStarted
} from '@shared/ipc/contract'
import { EventType, type StreamChunk } from '@tanstack/ai/client'
import type { UIMessage } from '@tanstack/ai-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPaneConnectionAdapter } from './ipc-connection-adapter'

const PANE_ID = '00000000-0000-4000-8000-000000000000'

type PaneStreamEvent =
  | PaneAssistantTextDelta
  | PaneAssistantThinkingDelta
  | PaneToolCallStarted
  | PaneToolCallCompleted
  | PaneMessageAppended
  | PaneAttentionChanged

const textDelta = (text: string): PaneStreamEvent =>
  PaneAssistantTextDelta.make({ paneId: PANE_ID, text })

const thinkingDelta = (text: string): PaneStreamEvent =>
  PaneAssistantThinkingDelta.make({ paneId: PANE_ID, text })

const toolStarted = (toolCallId: string, toolName: string): PaneStreamEvent =>
  PaneToolCallStarted.make({ paneId: PANE_ID, toolCallId, toolName })

const toolCompleted = (
  toolCallId: string,
  toolName: string,
  fields: { input?: Record<string, unknown>; output?: string; isError?: boolean } = {}
): PaneStreamEvent =>
  PaneToolCallCompleted.make({
    paneId: PANE_ID,
    toolCallId,
    toolName,
    input: fields.input ?? {},
    output: fields.output ?? '',
    isError: fields.isError ?? false
  })

const assistantAppended = (content: string): PaneStreamEvent =>
  PaneMessageAppended.make({ paneId: PANE_ID, message: { role: 'assistant', content } })

const userAppended = (content: string): PaneStreamEvent =>
  PaneMessageAppended.make({ paneId: PANE_ID, message: { role: 'user', content } })

const completed = (): PaneStreamEvent =>
  PaneAttentionChanged.make({ paneId: PANE_ID, attention: Completed.make({}) })

const errored = (message: string): PaneStreamEvent =>
  PaneAttentionChanged.make({
    paneId: PANE_ID,
    attention: Errored.make({ error: { message } })
  })

const awaitingPermission = (): PaneStreamEvent =>
  PaneAttentionChanged.make({
    paneId: PANE_ID,
    attention: AwaitingPermission.make({
      request: PermissionRequest.make({ requestId: 'req-1', toolName: 'Bash', input: {} })
    })
  })

const makeDia = () => {
  const sent: Array<{ paneId: string; text: string }> = []
  const listeners = new Set<(event: PaneStreamEvent) => void>()
  let unsubscribeCount = 0
  let afterSend: () => void = () => {}

  const add = (listener: (event: PaneStreamEvent) => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      unsubscribeCount += 1
    }
  }

  const emit = (event: PaneStreamEvent): void => {
    for (const listener of listeners) listener(event)
  }

  return {
    sent,
    emit,
    unsubscribeCount: (): number => unsubscribeCount,
    setAfterSend: (fn: () => void): void => {
      afterSend = fn
    },
    sendMessage: (paneId: string, text: string): void => {
      sent.push({ paneId, text })
      afterSend()
    },
    onAssistantTextDelta: (listener: (event: PaneAssistantTextDelta) => void) =>
      add((event) => {
        if (event._tag === 'PaneAssistantTextDelta') listener(event)
      }),
    onAssistantThinkingDelta: (listener: (event: PaneAssistantThinkingDelta) => void) =>
      add((event) => {
        if (event._tag === 'PaneAssistantThinkingDelta') listener(event)
      }),
    onToolCallStarted: (listener: (event: PaneToolCallStarted) => void) =>
      add((event) => {
        if (event._tag === 'PaneToolCallStarted') listener(event)
      }),
    onToolCallCompleted: (listener: (event: PaneToolCallCompleted) => void) =>
      add((event) => {
        if (event._tag === 'PaneToolCallCompleted') listener(event)
      }),
    onMessageAppended: (listener: (event: PaneMessageAppended) => void) =>
      add((event) => {
        if (event._tag === 'PaneMessageAppended') listener(event)
      }),
    onAttentionChanged: (listener: (event: PaneAttentionChanged) => void) =>
      add((event) => {
        if (event._tag === 'PaneAttentionChanged') listener(event)
      })
  }
}

const userMessages = (text = 'hello'): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', content: text }] }
]

const drain = async (iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const drive = async (
  script: ReadonlyArray<PaneStreamEvent>,
  options: { userText?: string } = {}
): Promise<{ chunks: StreamChunk[]; dia: ReturnType<typeof makeDia> }> => {
  const dia = makeDia()
  vi.stubGlobal('window', { dia })
  dia.setAfterSend(() => {
    for (const event of script) dia.emit(event)
  })

  const adapter = createPaneConnectionAdapter(PANE_ID)
  const chunks = await drain(adapter.connect(userMessages(options.userText)))
  return { chunks, dia }
}

const chunkTypes = (chunks: ReadonlyArray<StreamChunk>): string[] =>
  chunks.map((chunk) => chunk.type)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createPaneConnectionAdapter — run lifecycle', () => {
  it('opens with RUN_STARTED and forwards the latest user message to the pane', async () => {
    const { chunks, dia } = await drive([completed()], { userText: 'do the thing' })

    expect(chunks[0]).toMatchObject({ type: EventType.RUN_STARTED, threadId: PANE_ID })
    expect(dia.sent).toEqual([{ paneId: PANE_ID, text: 'do the thing' }])
  })

  it('finishes with reason "stop" carrying the runId RUN_STARTED opened with', async () => {
    const { chunks } = await drive([completed()])

    const started = chunks.find((chunk) => chunk.type === EventType.RUN_STARTED)
    const finished = chunks.find((chunk) => chunk.type === EventType.RUN_FINISHED)
    expect(finished).toMatchObject({ type: EventType.RUN_FINISHED, finishReason: 'stop' })
    expect((finished as { runId: string }).runId).toBe((started as { runId: string }).runId)
  })

  it('maps a terminal Errored attention to RUN_ERROR with the pane error message', async () => {
    const { chunks } = await drive([errored('the pane crashed')])

    expect(chunks.find((chunk) => chunk.type === EventType.RUN_ERROR)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: 'the pane crashed'
    })
    expect(chunkTypes(chunks)).not.toContain(EventType.RUN_FINISHED)
  })

  it('keeps the run open across an AwaitingPermission pause rather than ending it', async () => {
    const { chunks } = await drive([
      textDelta('before '),
      awaitingPermission(),
      textDelta('after'),
      completed()
    ])

    const contentDeltas = chunks
      .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((chunk) => (chunk as { delta: string }).delta)
    expect(contentDeltas).toEqual(['before ', 'after'])
    expect(chunkTypes(chunks).filter((type) => type === EventType.RUN_FINISHED)).toHaveLength(1)
    expect(chunkTypes(chunks)).not.toContain(EventType.RUN_ERROR)
  })
})

describe('createPaneConnectionAdapter — assistant text', () => {
  it('opens the text message once and streams one CONTENT chunk per delta', async () => {
    const { chunks } = await drive([
      textDelta('The '),
      textDelta('quick '),
      textDelta('fox'),
      completed()
    ])

    expect(chunkTypes(chunks)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED
    ])
  })

  it('closes the open text message when an assistant message is appended', async () => {
    const { chunks } = await drive([textDelta('done'), assistantAppended('done'), completed()])

    expect(chunkTypes(chunks)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED
    ])
  })

  it('ignores an appended user message so the optimistic user turn is not duplicated', async () => {
    const { chunks } = await drive([
      textDelta('a'),
      userAppended('hello'),
      textDelta('b'),
      completed()
    ])

    expect(chunkTypes(chunks)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED
    ])
  })
})

describe('createPaneConnectionAdapter — extended thinking', () => {
  it('opens a reasoning message once and streams one CONTENT chunk per thinking delta', async () => {
    const { chunks } = await drive([thinkingDelta('let me '), thinkingDelta('think'), completed()])

    expect(chunkTypes(chunks)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.RUN_FINISHED
    ])

    const reasoningDeltas = chunks
      .filter((chunk) => chunk.type === EventType.REASONING_MESSAGE_CONTENT)
      .map((chunk) => (chunk as { delta: string }).delta)
    expect(reasoningDeltas).toEqual(['let me ', 'think'])

    const reasoningIds = chunks
      .filter(
        (chunk) =>
          chunk.type === EventType.REASONING_MESSAGE_START ||
          chunk.type === EventType.REASONING_MESSAGE_CONTENT
      )
      .map((chunk) => (chunk as { messageId: string }).messageId)
    expect(new Set(reasoningIds).size).toBe(1)
  })

  it('closes the reasoning message before opening the answer text on the first text delta', async () => {
    const { chunks } = await drive([thinkingDelta('reasoning'), textDelta('answer'), completed()])

    expect(chunkTypes(chunks)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED
    ])
  })
})

describe('createPaneConnectionAdapter — tool calls', () => {
  it('closes open text before starting a tool call', async () => {
    const { chunks } = await drive([
      textDelta('let me check'),
      toolStarted('t1', 'Read'),
      toolCompleted('t1', 'Read'),
      completed()
    ])

    const startIndex = chunkTypes(chunks).indexOf(EventType.TOOL_CALL_START)
    expect(chunkTypes(chunks).slice(0, startIndex)).toContain(EventType.TEXT_MESSAGE_END)
  })

  it('surfaces a completed tool call as fully resolved args, end, and result', async () => {
    const { chunks } = await drive([
      toolStarted('t1', 'Bash'),
      toolCompleted('t1', 'Bash', { input: { command: 'ls' }, output: 'file.txt' }),
      completed()
    ])

    expect(chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_START)).toMatchObject({
      toolCallId: 't1',
      toolCallName: 'Bash'
    })
    expect(chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_ARGS)).toMatchObject({
      toolCallId: 't1',
      delta: JSON.stringify({ command: 'ls' })
    })
    expect(chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_END)).toMatchObject({
      toolCallId: 't1',
      state: 'output-available'
    })
    expect(chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
      toolCallId: 't1',
      content: 'file.txt',
      role: 'tool'
    })
  })

  it('marks the tool end as output-error when the call failed or was denied', async () => {
    const { chunks } = await drive([
      toolStarted('t1', 'Bash'),
      toolCompleted('t1', 'Bash', { output: 'permission denied', isError: true }),
      completed()
    ])

    expect(chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_END)).toMatchObject({
      state: 'output-error'
    })
  })
})

describe('createPaneConnectionAdapter — teardown', () => {
  it('unsubscribes every IPC listener once the run completes', async () => {
    const { dia } = await drive([completed()])

    expect(dia.unsubscribeCount()).toBe(6)
  })

  it('closes the stream and unsubscribes when the abort signal fires', async () => {
    const dia = makeDia()
    vi.stubGlobal('window', { dia })
    const controller = new AbortController()
    dia.setAfterSend(() => {
      controller.abort()
    })

    const adapter = createPaneConnectionAdapter(PANE_ID)
    const chunks = await drain(adapter.connect(userMessages(), undefined, controller.signal))

    expect(chunkTypes(chunks)).toEqual([EventType.RUN_STARTED])
    expect(dia.unsubscribeCount()).toBe(6)
  })
})
