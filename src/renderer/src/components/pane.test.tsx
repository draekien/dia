// @vitest-environment jsdom
import type { UIMessage } from '@tanstack/ai-client'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { dirName, historyToInitialMessages, MessageView, resolveInitialMessages } from './pane'

afterEach(cleanup)

const userMessage = (content: string): UIMessage => ({
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', content }]
})

describe('dirName', () => {
  it('returns the final segment of a forward-slash path', () => {
    expect(dirName('/repo/project')).toBe('project')
  })

  it('returns the final segment of a backslash path', () => {
    expect(dirName('C:\\repo\\project')).toBe('project')
  })

  it('strips a trailing separator before extracting the segment', () => {
    expect(dirName('/repo/project/')).toBe('project')
  })

  it('returns the whole string when there is no separator', () => {
    expect(dirName('project')).toBe('project')
  })

  it('handles mixed separators by taking the last one of either kind', () => {
    expect(dirName('C:\\repo/project')).toBe('project')
  })
})

describe('historyToInitialMessages', () => {
  it('maps each turn to a UIMessage with a stable pane-scoped id and one text part', () => {
    const result = historyToInitialMessages('pane-7', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])

    expect(result).toEqual([
      { id: 'pane-7:history:0', role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      { id: 'pane-7:history:1', role: 'assistant', parts: [{ type: 'text', content: 'hello' }] }
    ])
  })

  it('returns an empty list for empty history', () => {
    expect(historyToInitialMessages('pane-7', [])).toEqual([])
  })
})

describe('resolveInitialMessages', () => {
  it('prefers a cached live snapshot over persisted history', () => {
    const snapshot: UIMessage[] = [
      { id: 'live-1', role: 'assistant', parts: [{ type: 'text', content: 'streamed' }] }
    ]

    const result = resolveInitialMessages(snapshot, 'pane-7', [{ role: 'user', content: 'old' }])

    expect(result).toBe(snapshot)
  })

  it('falls back to mapped history when there is no snapshot', () => {
    const history = [{ role: 'user' as const, content: 'hi' }]

    expect(resolveInitialMessages(undefined, 'pane-7', history)).toEqual(
      historyToInitialMessages('pane-7', history)
    )
  })
})

describe('MessageView', () => {
  it('renders a user turn as an end-aligned bubble carrying the text', () => {
    const { container } = render(<MessageView message={userMessage('deploy the thing')} />)

    expect(screen.getByText('deploy the thing')).toBeTruthy()
    expect(container.querySelector('[data-slot="message"]')?.getAttribute('data-align')).toBe('end')
    expect(container.querySelector('[data-slot="bubble"]')?.getAttribute('data-variant')).toBe(
      'tinted'
    )
  })

  it('renders an assistant text turn as a start-aligned muted bubble', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', content: 'here is the answer' }]
    }

    const { container } = render(<MessageView message={message} />)

    expect(screen.getByText('here is the answer')).toBeTruthy()
    expect(container.querySelector('[data-slot="message"]')?.getAttribute('data-align')).toBe(
      'start'
    )
    expect(container.querySelector('[data-slot="bubble"]')?.getAttribute('data-variant')).toBe(
      'muted'
    )
  })

  it('shows a completed tool call as name, input summary, and an output disclosure', () => {
    const message: UIMessage = {
      id: 'a2',
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          id: 't1',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'ls -la' }),
          state: 'complete',
          output: 'file.txt\nfile2.txt'
        }
      ]
    }

    const { container } = render(<MessageView message={message} />)

    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.getByText('ls -la')).toBeTruthy()
    expect(screen.getByText('completed')).toBeTruthy()
    expect(container.querySelector('details')).toBeTruthy()
    expect(screen.getByText(/file\.txt/)).toBeTruthy()
  })

  it('marks an in-flight tool call as running and shows no output disclosure', () => {
    const message: UIMessage = {
      id: 'a3',
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          id: 't2',
          name: 'Read',
          arguments: '',
          state: 'input-streaming'
        }
      ]
    }

    const { container } = render(<MessageView message={message} />)

    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(container.querySelector('details')).toBeNull()
  })

  it('omits tool-result parts, showing output only via the tool-call part', () => {
    const message: UIMessage = {
      id: 'a4',
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          id: 't3',
          name: 'Read',
          arguments: JSON.stringify({ file_path: '/repo/notes.md' }),
          state: 'complete',
          output: 'tool-call output'
        },
        {
          type: 'tool-result',
          toolCallId: 't3',
          content: 'duplicate result body',
          state: 'complete'
        }
      ]
    }

    render(<MessageView message={message} />)

    expect(screen.getByText('tool-call output')).toBeTruthy()
    expect(screen.queryByText('duplicate result body')).toBeNull()
  })

  it('drops an empty assistant text part rather than rendering an empty bubble', () => {
    const message: UIMessage = {
      id: 'a5',
      role: 'assistant',
      parts: [{ type: 'text', content: '   ' }]
    }

    const { container } = render(<MessageView message={message} />)

    expect(container.querySelector('[data-slot="bubble"]')).toBeNull()
  })
})
