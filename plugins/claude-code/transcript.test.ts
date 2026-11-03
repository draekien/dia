import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { assert, describe, it } from '@effect/vitest'
import {
  MessageUpdated,
  ReasoningUpdated,
  TOOL_OUTPUT_LIMIT,
  ToolCallCompleted,
  ToolCallStarted
} from '@shared/domain/agent-event'
import { ContentAttachment } from '@shared/domain/attachment'
import { SessionId } from '@shared/domain/pane'
import { Effect, Option } from 'effect'
import { beforeEach, vi } from 'vitest'
import {
  lastAssistantUuid,
  readTranscriptAfter,
  sessionMessagesToConversation,
  transcriptEntriesAfter
} from './transcript'

const sdk = vi.hoisted(() => ({
  getSessionInfo: vi.fn<() => Promise<SDKSessionInfo | undefined>>(),
  getSessionMessages: vi.fn<() => Promise<Array<SessionMessage>>>()
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  getSessionInfo: sdk.getSessionInfo,
  getSessionMessages: sdk.getSessionMessages
}))

function sessionMessage(
  type: SessionMessage['type'],
  message: unknown,
  uuid = 'uuid'
): SessionMessage {
  return {
    type,
    uuid,
    session_id: 'session',
    message,
    parent_tool_use_id: null,
    parent_agent_id: null
  }
}

describe('sessionMessagesToConversation', () => {
  it('anchors a checkpoint uuid onto a user turn with string content', () => {
    const result = sessionMessagesToConversation([
      sessionMessage('user', { role: 'user', content: 'hello there' }, 'turn-1')
    ])

    assert.deepStrictEqual(result, [
      { role: 'user', content: 'hello there', checkpointUuid: 'turn-1' }
    ])
  })

  it('restores the image blocks of a user turn as attachments and anchors its checkpoint', () => {
    const result = sessionMessagesToConversation([
      sessionMessage(
        'user',
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is wrong here?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }
          ]
        },
        'turn-1'
      )
    ])

    assert.deepStrictEqual(result, [
      {
        role: 'user',
        content: 'what is wrong here?',
        attachments: [
          ContentAttachment.make({ name: 'image-1', mediaType: 'image/png', data: 'AAA' })
        ],
        checkpointUuid: 'turn-1'
      }
    ])
  })

  it('joins an assistant turn’s text blocks into one message', () => {
    const result = sessionMessagesToConversation([
      sessionMessage('assistant', {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' }
        ]
      })
    ])

    assert.deepStrictEqual(result, [{ role: 'assistant', content: 'part one part two' }])
  })

  it('keeps only the text blocks of an assistant turn that also calls a tool', () => {
    const result = sessionMessagesToConversation([
      sessionMessage('assistant', {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } }
        ]
      })
    ])

    assert.deepStrictEqual(result, [{ role: 'assistant', content: 'let me check' }])
  })

  it('drops a tool-result turn that carries no displayable text', () => {
    const result = sessionMessagesToConversation([
      sessionMessage('user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }]
      })
    ])

    assert.deepStrictEqual(result, [])
  })

  it('drops a message whose shape cannot be decoded', () => {
    const result = sessionMessagesToConversation([
      sessionMessage('system', { note: 'compact boundary' }),
      sessionMessage('user', null)
    ])

    assert.deepStrictEqual(result, [])
  })

  it('preserves chronological order and anchors each user turn to its own uuid', () => {
    const result = sessionMessagesToConversation([
      sessionMessage('user', { role: 'user', content: 'first' }, 'turn-1'),
      sessionMessage(
        'assistant',
        { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        'turn-2'
      ),
      sessionMessage(
        'user',
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ignored' }] },
        'turn-3'
      ),
      sessionMessage('user', { role: 'user', content: 'third' }, 'turn-4')
    ])

    assert.deepStrictEqual(result, [
      { role: 'user', content: 'first', checkpointUuid: 'turn-1' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third', checkpointUuid: 'turn-4', resumeAnchorUuid: 'turn-2' }
    ])
  })

  it('anchors the resume uuid to the most recent assistant turn, including tool-only ones', () => {
    const result = sessionMessagesToConversation([
      sessionMessage('user', { role: 'user', content: 'first' }, 'turn-1'),
      sessionMessage(
        'assistant',
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } }]
        },
        'turn-2'
      ),
      sessionMessage(
        'user',
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        'turn-3'
      ),
      sessionMessage('user', { role: 'user', content: 'second' }, 'turn-4')
    ])

    assert.deepStrictEqual(result, [
      { role: 'user', content: 'first', checkpointUuid: 'turn-1' },
      { role: 'user', content: 'second', checkpointUuid: 'turn-4', resumeAnchorUuid: 'turn-2' }
    ])
  })

  it('drops a background task notification turn, which a live transcript does not show', () => {
    const result = sessionMessagesToConversation([
      sessionMessage('user', { role: 'user', content: 'first' }, 'turn-1'),
      sessionMessage(
        'assistant',
        { role: 'assistant', content: [{ type: 'text', text: 'started a task' }] },
        'turn-2'
      ),
      sessionMessage(
        'user',
        {
          role: 'user',
          content:
            '<task-notification> <task-id>a4eb4cdbca17de9b4</task-id> <status>completed</status> </task-notification>'
        },
        'turn-3'
      ),
      sessionMessage('user', { role: 'user', content: 'second' }, 'turn-4')
    ])

    assert.deepStrictEqual(result, [
      { role: 'user', content: 'first', checkpointUuid: 'turn-1' },
      { role: 'assistant', content: 'started a task' },
      { role: 'user', content: 'second', checkpointUuid: 'turn-4', resumeAnchorUuid: 'turn-2' }
    ])
  })

  it('drops a task notification turn whose content is a text block array', () => {
    const result = sessionMessagesToConversation([
      sessionMessage(
        'user',
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<task-notification> <status>completed</status> </task-notification>'
            }
          ]
        },
        'turn-1'
      )
    ])

    assert.deepStrictEqual(result, [])
  })

  it('keeps a user turn that mentions a task notification tag after other text', () => {
    const result = sessionMessagesToConversation([
      sessionMessage(
        'user',
        { role: 'user', content: 'why does <task-notification> show up?' },
        'turn-1'
      )
    ])

    assert.deepStrictEqual(result, [
      { role: 'user', content: 'why does <task-notification> show up?', checkpointUuid: 'turn-1' }
    ])
  })

  it('returns an empty list for no messages', () => {
    assert.deepStrictEqual(sessionMessagesToConversation([]), [])
  })
})

describe('lastAssistantUuid', () => {
  it('returns the uuid of the newest assistant message', () => {
    const result = lastAssistantUuid([
      sessionMessage(
        'assistant',
        { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
        'turn-2'
      ),
      sessionMessage('user', { role: 'user', content: 'next' }, 'turn-3'),
      sessionMessage(
        'assistant',
        { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
        'turn-4'
      ),
      sessionMessage('user', { role: 'user', content: 'last' }, 'turn-5')
    ])

    assert.deepStrictEqual(result, Option.some('turn-4'))
  })

  it('counts a tool-only assistant message, as the resume anchor rule does', () => {
    const result = lastAssistantUuid([
      sessionMessage('user', { role: 'user', content: 'first' }, 'turn-1'),
      sessionMessage(
        'assistant',
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } }]
        },
        'turn-2'
      ),
      sessionMessage(
        'user',
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        'turn-3'
      )
    ])

    assert.deepStrictEqual(result, Option.some('turn-2'))
  })

  it('returns none for a transcript with no assistant message', () => {
    const result = lastAssistantUuid([
      sessionMessage('user', { role: 'user', content: 'only a prompt' }, 'turn-1')
    ])

    assert.deepStrictEqual(result, Option.none())
  })

  it('returns none for an empty transcript', () => {
    assert.deepStrictEqual(lastAssistantUuid([]), Option.none())
  })
})

const subagentMessage = (message: unknown, uuid: string): SessionMessage => ({
  ...sessionMessage('assistant', message, uuid),
  parent_tool_use_id: 'toolu_task'
})

const listFilesTranscript: ReadonlyArray<SessionMessage> = [
  sessionMessage('user', { role: 'user', content: 'list the files' }, 'u1'),
  sessionMessage(
    'assistant',
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'need ls' },
        { type: 'text', text: 'Listing.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
      ]
    },
    'a1'
  ),
  sessionMessage(
    'user',
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'src\nout' }]
    },
    'u2'
  ),
  sessionMessage(
    'assistant',
    { role: 'assistant', content: [{ type: 'text', text: 'Two folders.' }] },
    'a2'
  )
]

const listFilesEntries = [
  {
    sourceUuid: 'u1',
    event: MessageUpdated.make({
      itemId: 'u1',
      message: { role: 'user', content: 'list the files', checkpointUuid: 'u1' },
      streaming: false
    })
  },
  {
    sourceUuid: 'a1',
    event: ReasoningUpdated.make({ itemId: 'a1:thinking', text: 'need ls', streaming: false })
  },
  {
    sourceUuid: 'a1',
    event: MessageUpdated.make({
      itemId: 'a1',
      message: { role: 'assistant', content: 'Listing.' },
      streaming: false
    })
  },
  { sourceUuid: 'a1', event: ToolCallStarted.make({ toolCallId: 'toolu_1', toolName: 'Bash' }) },
  {
    sourceUuid: 'u2',
    event: ToolCallCompleted.make({
      toolCallId: 'toolu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
      output: 'src\nout',
      isError: false
    })
  },
  {
    sourceUuid: 'a2',
    event: MessageUpdated.make({
      itemId: 'a2',
      message: { role: 'assistant', content: 'Two folders.' },
      streaming: false
    })
  }
]

const toolResultAfterListFiles = (block: Record<string, unknown>, uuid: string) => [
  listFilesTranscript[1],
  sessionMessage('user', { role: 'user', content: [{ type: 'tool_result', ...block }] }, uuid)
]

describe('transcriptEntriesAfter', () => {
  it('maps every message to events in transcript order when there is no cursor', () => {
    assert.deepStrictEqual(
      transcriptEntriesAfter(listFilesTranscript, Option.none()),
      listFilesEntries
    )
  })

  it('returns only the events of messages after the cursor', () => {
    const entriesOfU2AndA2 = listFilesEntries.slice(4)

    assert.deepStrictEqual(
      transcriptEntriesAfter(listFilesTranscript, Option.some('a1')),
      entriesOfU2AndA2
    )
  })

  it('returns every event when the cursor is not in the transcript', () => {
    assert.deepStrictEqual(
      transcriptEntriesAfter(listFilesTranscript, Option.some('rewound-away')),
      listFilesEntries
    )
  })

  it('returns nothing when the cursor is the last message', () => {
    assert.deepStrictEqual(transcriptEntriesAfter(listFilesTranscript, Option.some('a2')), [])
  })

  it('finds a cursor on a skipped subagent message and returns the events after it', () => {
    const transcript = [
      subagentMessage({ role: 'assistant', content: [{ type: 'text', text: 'sub' }] }, 's1'),
      sessionMessage('assistant', { role: 'assistant', content: 'done' }, 'a3')
    ]

    assert.deepStrictEqual(transcriptEntriesAfter(transcript, Option.some('s1')), [
      {
        sourceUuid: 'a3',
        event: MessageUpdated.make({
          itemId: 'a3',
          message: { role: 'assistant', content: 'done' },
          streaming: false
        })
      }
    ])
  })

  it('leaves out subagent messages', () => {
    const transcript = [
      subagentMessage({ role: 'assistant', content: [{ type: 'text', text: 'sub' }] }, 's1')
    ]

    assert.deepStrictEqual(transcriptEntriesAfter(transcript, Option.none()), [])
  })

  it('leaves out background task notifications', () => {
    const transcript = [
      sessionMessage(
        'user',
        { role: 'user', content: '<task-notification>done</task-notification>' },
        'n1'
      )
    ]

    assert.deepStrictEqual(transcriptEntriesAfter(transcript, Option.none()), [])
  })

  it('anchors a later user turn on the last assistant message', () => {
    const transcript = [
      ...listFilesTranscript,
      sessionMessage('user', { role: 'user', content: 'thanks' }, 'u3')
    ]

    assert.deepStrictEqual(transcriptEntriesAfter(transcript, Option.some('a2')), [
      {
        sourceUuid: 'u3',
        event: MessageUpdated.make({
          itemId: 'u3',
          message: {
            role: 'user',
            content: 'thanks',
            checkpointUuid: 'u3',
            resumeAnchorUuid: 'a2'
          },
          streaming: false
        })
      }
    ])
  })

  it('emits no reasoning or message for an assistant message with only a tool use', () => {
    const transcript = [
      sessionMessage(
        'assistant',
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a.ts' } }
          ]
        },
        'a4'
      )
    ]

    assert.deepStrictEqual(transcriptEntriesAfter(transcript, Option.none()), [
      { sourceUuid: 'a4', event: ToolCallStarted.make({ toolCallId: 'toolu_2', toolName: 'Read' }) }
    ])
  })

  it('skips a tool result whose tool use is not in the transcript', () => {
    const transcript = [
      sessionMessage(
        'user',
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_unknown', content: 'x' }]
        },
        'u4'
      )
    ]

    assert.deepStrictEqual(transcriptEntriesAfter(transcript, Option.none()), [])
  })

  it('marks a failed tool result as an error', () => {
    const transcript = toolResultAfterListFiles(
      { tool_use_id: 'toolu_1', content: 'boom', is_error: true },
      'u5'
    )

    assert.deepStrictEqual(transcriptEntriesAfter(transcript, Option.some('a1')), [
      {
        sourceUuid: 'u5',
        event: ToolCallCompleted.make({
          toolCallId: 'toolu_1',
          toolName: 'Bash',
          input: { command: 'ls' },
          output: 'boom',
          isError: true
        })
      }
    ])
  })

  it('caps a tool output longer than the limit', () => {
    const overLimitBy10 = 'y'.repeat(TOOL_OUTPUT_LIMIT + 10)
    const transcript = toolResultAfterListFiles(
      { tool_use_id: 'toolu_1', content: overLimitBy10 },
      'u6'
    )

    const [completion] = transcriptEntriesAfter(transcript, Option.some('a1'))

    assert.strictEqual(
      completion.event._tag === 'ToolCallCompleted' ? completion.event.output : undefined,
      `${'y'.repeat(TOOL_OUTPUT_LIMIT)}\n[output truncated: 10 characters omitted]`
    )
  })
})

const sessionInfo = (fields: Partial<SDKSessionInfo>): SDKSessionInfo => ({
  sessionId: 'session',
  summary: 'list the files',
  lastModified: 1_762_128_000_000,
  fileSize: 4_821,
  ...fields
})

const SESSION = SessionId.make('session')

describe('readTranscriptAfter', () => {
  beforeEach(() => {
    sdk.getSessionInfo.mockReset()
    sdk.getSessionMessages.mockReset()
  })

  it.effect('returns the entries with the size and mtime the SDK reports for the file', () =>
    Effect.gen(function* () {
      sdk.getSessionInfo.mockResolvedValue(sessionInfo({}))
      sdk.getSessionMessages.mockResolvedValue([...listFilesTranscript])

      const tail = yield* readTranscriptAfter(SESSION, 'F:/proj', Option.some('a1'))

      assert.deepStrictEqual(
        tail,
        Option.some({
          entries: listFilesEntries.slice(4),
          fileSize: 4_821,
          mtimeMs: 1_762_128_000_000
        })
      )
    })
  )

  it.effect('returns none when the SDK finds no transcript', () =>
    Effect.gen(function* () {
      sdk.getSessionInfo.mockResolvedValue(undefined)

      const tail = yield* readTranscriptAfter(SESSION, 'F:/proj', Option.none())

      assert.deepStrictEqual(tail, Option.none())
    })
  )

  it.effect('returns none when the SDK reports no file size', () =>
    Effect.gen(function* () {
      sdk.getSessionInfo.mockResolvedValue(sessionInfo({ fileSize: undefined }))

      const tail = yield* readTranscriptAfter(SESSION, 'F:/proj', Option.none())

      assert.deepStrictEqual(tail, Option.none())
    })
  )

  it.effect('returns none rather than an empty tail when reading the messages fails', () =>
    Effect.gen(function* () {
      sdk.getSessionInfo.mockResolvedValue(sessionInfo({}))
      sdk.getSessionMessages.mockRejectedValue(new Error('EACCES'))

      const tail = yield* readTranscriptAfter(SESSION, 'F:/proj', Option.none())

      assert.deepStrictEqual(tail, Option.none())
    })
  )

  it.effect('returns none when reading the session info fails', () =>
    Effect.gen(function* () {
      sdk.getSessionInfo.mockRejectedValue(new Error('EACCES'))

      const tail = yield* readTranscriptAfter(SESSION, 'F:/proj', Option.none())

      assert.deepStrictEqual(tail, Option.none())
    })
  )
})
