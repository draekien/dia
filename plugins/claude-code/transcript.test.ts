import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { assert, describe, it } from '@effect/vitest'
import { Option } from 'effect'
import { lastAssistantUuid, sessionMessagesToConversation } from './transcript'

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
