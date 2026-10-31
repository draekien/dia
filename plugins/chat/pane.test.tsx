// @vitest-environment jsdom

import { type PaneMessage, TooltipProvider } from '@dia/renderer-plugin'
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
  it('shows a rewind row under an agent turn given a rewind', () => {
    const message: PaneMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', content: 'created login.tsx' }]
    }

    render(
      <MessageView
        message={message}
        rewind={{ state: { status: 'ready' }, onStart: () => {}, onDismiss: () => {} }}
      />
    )

    expect(screen.getByRole('button', { name: 'Rewind to here, press and hold' })).toBeTruthy()
  })

  it('shows no rewind control on a user turn, even one with a checkpoint', () => {
    render(<MessageView message={{ ...userMessage('add a login page'), checkpointUuid: 'cp-1' }} />)

    expect(screen.queryByRole('button', { name: /rewind/i })).toBeNull()
  })

  it('renders a user turn as an end-aligned bubble carrying the text', () => {
    const { container } = render(<MessageView message={userMessage('deploy the thing')} />)

    expect(screen.getByText('deploy the thing')).toBeTruthy()
    expect(container.querySelector('[data-slot="message"]')?.getAttribute('data-align')).toBe('end')
    expect(container.querySelector('[data-slot="bubble"]')?.getAttribute('data-variant')).toBe(
      'tinted'
    )
  })

  it('renders an assistant text turn start-aligned as plain text, with no bubble', () => {
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
    expect(container.querySelector('[data-slot="bubble"]')).toBeNull()
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

describe('MessageView: compaction notice', () => {
  const notice = (compaction: PaneMessage['compaction']): PaneMessage => ({
    id: '3:notice',
    role: 'notice',
    parts: [{ type: 'text', content: 'Context compacted' }],
    compaction
  })
  const renderNotice = (message: PaneMessage) =>
    render(
      <TooltipProvider>
        <MessageView message={message} />
      </TooltipProvider>
    )

  it('shows both counts rounded to thousands', () => {
    const { container } = renderNotice(notice({ preTokens: 94533, postTokens: 23665 }))

    const visible = [...container.querySelectorAll('[data-slot="marker-content"] *')]
      .filter((element) => !element.closest('.sr-only') && element.children.length === 0)
      .map((element) => element.textContent)
      .join('')
    expect(visible).toContain('~95k')
    expect(visible).toContain('~24k')
  })

  it('gives assistive technology the exact counts with the unit once each', () => {
    const { container } = renderNotice(notice({ preTokens: 94533, postTokens: 23665 }))

    const content = container.querySelector('[data-slot="marker-content"]')?.cloneNode(true)
    if (!(content instanceof Element)) throw new Error('no marker content')
    for (const hidden of content.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
    expect(content.textContent).toBe('Context compacted — 94,533 tokens → 23,665 tokens')
  })

  it('shows only the text when the post-compaction size is unknown', () => {
    const { container } = renderNotice(notice({ preTokens: 900 }))

    expect(container.querySelector('[data-slot="marker-content"]')?.textContent).toBe(
      'Context compacted'
    )
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
  const stillStepping: PaneMessage = { ...liveTurn, parts: liveTurn.parts.slice(0, 2) }
  const working = { kind: 'working', label: 'Pondering…', stalled: false } as const
  const live = {
    activity: working,
    onResend: () => {},
    onInterruptAndRetry: () => {}
  }

  it('collapses a finished turn’s steps behind their count and duration', () => {
    const { container } = render(<MessageView message={liveTurn} />)

    const section = container.querySelector('details')
    expect(section?.open).toBe(false)
    expect(section?.querySelector('summary')?.textContent).toBe('1 step · 11s')
  })

  it('gives a finished section’s summary an accessible name with its parts kept apart', () => {
    const { container } = render(<MessageView message={liveTurn} />)

    const spoken = container.querySelector('summary')?.cloneNode(true) as HTMLElement
    for (const hidden of spoken.querySelectorAll('[aria-hidden]')) hidden.remove()
    expect(spoken.textContent?.replace(/\s+/g, ' ')).toBe('1 step 11s')
  })

  it('keeps the text before and after the steps visible, outside the section', () => {
    render(<MessageView message={liveTurn} />)

    expect(screen.getByText('Let me look.').closest('details')).toBeNull()
    expect(screen.getByText('Fixed it.').closest('details')).toBeNull()
  })

  it('shows a running turn’s latest step on the summary line instead of the count', () => {
    const { container } = render(<MessageView message={liveTurn} live={live} nowMs={20_000} />)

    const summary = container.querySelector('summary')?.textContent
    expect(summary).toContain('Read')
    expect(summary).toContain('a.ts')
    expect(summary).not.toContain('step')
  })

  it('shows a running turn’s named state on the summary line', () => {
    const { container } = render(
      <MessageView
        message={liveTurn}
        live={{ ...live, label: 'Compacting conversation' }}
        nowMs={20_000}
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

    const { container } = render(<MessageView message={restored} />)

    expect(container.querySelector('details')).toBeNull()
    expect(screen.getByText('Read')).toBeTruthy()
  })

  it('marks a failed tool call as failed on its row and counts it on the summary', () => {
    const failing: PaneMessage = {
      id: 'a12',
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          toolCallId: 't1',
          name: 'Bash',
          state: 'done',
          input: { command: 'sleep 40' },
          output: '',
          isError: true,
          startedAt: 1_000,
          endedAt: 2_000
        }
      ]
    }

    const { container } = render(<MessageView message={failing} />)

    expect(container.querySelector('summary')?.textContent).toBe('1 step · Bash failed · 1s')
    expect(screen.getByText('failed')).toBeTruthy()
    expect(screen.queryByText('completed')).toBeNull()
  })

  it('times a running section from its first part, not from the start of the turn', () => {
    const { container } = render(
      <MessageView
        message={stillStepping}
        live={{ ...live, activity: { ...working, elapsedLabel: '25s' } }}
        nowMs={20_000}
      />
    )

    expect(container.querySelector('summary')?.textContent).toContain('18s')
  })

  it('stops a running section’s time at the text written after it', () => {
    const { container } = render(
      <MessageView
        message={liveTurn}
        live={{ ...live, activity: { ...working, elapsedLabel: '25s' } }}
        nowMs={20_000}
      />
    )

    expect(container.querySelector('summary')?.textContent).toContain('11s')
  })

  it('shows no negative time when the clock reading predates the section’s first part', () => {
    const { container } = render(
      <MessageView
        message={stillStepping}
        live={{ ...live, activity: { ...working, elapsedLabel: '25s' } }}
        nowMs={1_500}
      />
    )

    expect(container.querySelector('summary')?.textContent).toContain('0s')
    expect(container.querySelector('summary')?.textContent).not.toContain('-')
  })

  it('stops the activity dot pulsing once the turn stalls', () => {
    const { container, rerender } = render(
      <MessageView message={stillStepping} live={live} nowMs={20_000} />
    )
    expect(container.querySelector('summary .animate-pulse-slow')).not.toBeNull()

    rerender(
      <MessageView
        message={stillStepping}
        live={{ ...live, activity: { ...working, stalled: true } }}
        nowMs={20_000}
      />
    )

    expect(container.querySelector('summary .animate-pulse-slow')).toBeNull()
  })

  it('shows the stall actions outside the summary, so the disclosure holds no buttons', () => {
    const { container } = render(
      <MessageView
        message={liveTurn}
        live={{ ...live, activity: { ...working, stalled: true } }}
        nowMs={20_000}
      />
    )

    expect(container.querySelector('summary button')).toBeNull()
    expect(screen.getByRole('button', { name: 'Resend' }).closest('details')).toBeNull()
  })
})

describe('MessageView: failed steps', () => {
  const bash = (toolCallId: string, isError: boolean) =>
    ({
      type: 'tool-call',
      toolCallId,
      name: 'Bash',
      state: 'done',
      input: { command: 'make' },
      output: '',
      isError,
      startedAt: 1_000,
      endedAt: 2_000
    }) as const

  it('counts the failures instead of naming a tool when more than one call failed', () => {
    const message: PaneMessage = {
      id: 'a13',
      role: 'assistant',
      parts: [bash('t1', true), bash('t2', true), bash('t3', false)]
    }

    const { container } = render(<MessageView message={message} />)

    expect(container.querySelector('summary')?.textContent).toBe('3 steps · 2 failed · 1s')
  })

  it('offers a tool row’s full target as its title, for when the row truncates it', () => {
    const message: PaneMessage = { id: 'a14', role: 'assistant', parts: [bash('t1', false)] }

    render(<MessageView message={message} />)

    expect(screen.getByText('make').getAttribute('title')).toBe('make')
  })
})
