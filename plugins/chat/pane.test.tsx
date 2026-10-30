// @vitest-environment jsdom

import type { PaneMessage } from '@dia/renderer-plugin'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { dirName, MessageView } from './pane'

afterEach(cleanup)

const userMessage = (content: string): PaneMessage => ({
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
    const message: PaneMessage = {
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
    const message: PaneMessage = {
      id: 'a2',
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          toolCallId: 't1',
          name: 'Bash',
          state: 'done',
          input: { command: 'ls -la' },
          output: 'file.txt\nfile2.txt',
          isError: false
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
    const message: PaneMessage = {
      id: 'a3',
      role: 'assistant',
      parts: [{ type: 'tool-call', toolCallId: 't2', name: 'Read', state: 'running' }]
    }

    const { container } = render(<MessageView message={message} />)

    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(container.querySelector('details')).toBeNull()
  })

  it('shows no output disclosure for a completed tool call that produced empty output', () => {
    const message: PaneMessage = {
      id: 'a4',
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          toolCallId: 't3',
          name: 'Read',
          state: 'done',
          input: { file_path: '/repo/notes.md' },
          output: '',
          isError: false
        }
      ]
    }

    const { container } = render(<MessageView message={message} />)

    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('completed')).toBeTruthy()
    expect(container.querySelector('details')).toBeNull()
  })

  it('renders a thinking part as a collapsed disclosure carrying the reasoning text', () => {
    const message: PaneMessage = {
      id: 'a6',
      role: 'assistant',
      parts: [{ type: 'thinking', content: 'weighing the trade-offs' }]
    }

    const { container } = render(<MessageView message={message} />)

    const details = container.querySelector('details')
    expect(details).toBeTruthy()
    expect(details?.querySelector('summary')?.textContent).toBe('Thinking')
    expect(screen.getByText('weighing the trade-offs')).toBeTruthy()
  })

  it('drops an empty thinking part rather than rendering an empty disclosure', () => {
    const message: PaneMessage = {
      id: 'a7',
      role: 'assistant',
      parts: [{ type: 'thinking', content: '   ' }]
    }

    const { container } = render(<MessageView message={message} />)

    expect(container.querySelector('details')).toBeNull()
  })

  it('drops an empty assistant text part rather than rendering an empty bubble', () => {
    const message: PaneMessage = {
      id: 'a5',
      role: 'assistant',
      parts: [{ type: 'text', content: '   ' }]
    }

    const { container } = render(<MessageView message={message} />)

    expect(container.querySelector('[data-slot="bubble"]')).toBeNull()
  })
})

describe('MessageView: turn steps', () => {
  const liveTurn: PaneMessage = {
    id: 'a10',
    role: 'assistant',
    parts: [
      { type: 'text', content: 'Let me look.', startedAt: 1_000 },
      {
        type: 'tool-call',
        toolCallId: 't1',
        name: 'Read',
        state: 'done',
        input: { file_path: '/repo/a.ts' },
        output: '',
        startedAt: 2_000,
        endedAt: 3_000
      },
      { type: 'text', content: 'Fixed it.', startedAt: 13_000 }
    ]
  }
  const working = { kind: 'working', label: 'Pondering…', stalled: false } as const
  const live = { activity: working, onResend: () => {}, onInterruptAndRetry: () => {} }

  it('collapses a finished turn’s steps behind their count and duration, and shows the answer', () => {
    const { container } = render(<MessageView message={liveTurn} mode="answer-only" />)

    const section = container.querySelector('details')
    expect(section?.open).toBe(false)
    expect(section?.querySelector('summary')?.textContent).toBe('1 step · 12s')
    expect(section?.textContent).toContain('Let me look.')
    expect(screen.getByText('Fixed it.').closest('details')).toBeNull()
  })

  it('keeps the text between steps visible in all-text mode', () => {
    render(<MessageView message={liveTurn} mode="all-text" />)

    expect(screen.getByText('Let me look.').closest('details')).toBeNull()
  })

  it('shows a running turn’s latest step on the summary line instead of the count', () => {
    const { container } = render(<MessageView message={liveTurn} mode="answer-only" live={live} />)

    const summary = container.querySelector('summary')?.textContent
    expect(summary).toContain('Read')
    expect(summary).toContain('a.ts')
    expect(summary).not.toContain('step')
  })

  it('shows a running turn’s named state on the summary line', () => {
    const { container } = render(
      <MessageView
        message={liveTurn}
        mode="answer-only"
        live={{ ...live, label: 'Compacting conversation' }}
      />
    )

    expect(container.querySelector('summary')?.textContent).toContain('Compacting conversation')
  })

  it('shows every part of a turn restored from history, with no steps section', () => {
    const restored: PaneMessage = {
      id: 'a11',
      role: 'assistant',
      parts: [
        { type: 'tool-call', toolCallId: 't1', name: 'Read', state: 'running' },
        { type: 'text', content: 'Fixed it.' }
      ]
    }

    const { container } = render(<MessageView message={restored} mode="answer-only" />)

    expect(container.querySelector('details')).toBeNull()
    expect(screen.getByText('Read')).toBeTruthy()
  })
})
