import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { assert, describe, it } from '@effect/vitest'
import { sessionMessagesToConversation } from './transcript-reader'

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
      { role: 'user', content: 'third', checkpointUuid: 'turn-4' }
    ])
  })

  it('returns an empty list for no messages', () => {
    assert.deepStrictEqual(sessionMessagesToConversation([]), [])
  })
})
