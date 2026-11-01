// @vitest-environment jsdom

import { TooltipProvider } from '@dia/renderer-plugin'
import type { CompactionFailure, ContextUsage } from '@shared/domain/context-usage'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextDonut } from './context-donut'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const usage: ContextUsage = { totalTokens: 176_000, maxTokens: 200_000 }

const open = ({
  reading = usage,
  failure = null,
  compacting = false,
  running = false
}: {
  reading?: ContextUsage | null
  failure?: CompactionFailure | null
  compacting?: boolean
  running?: boolean
}) => {
  const onCompact = vi.fn()
  render(
    <TooltipProvider>
      <ContextDonut
        usage={reading}
        failure={failure}
        compacting={compacting}
        running={running}
        onCompact={onCompact}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /^Context/ }))
  return onCompact
}

const compactButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Compact conversation' })

describe('ContextDonut', () => {
  it('names the share of context used', () => {
    open({})
    expect(screen.getByRole('button', { name: 'Context 88% used' })).toBeTruthy()
  })

  it('shows the numbers and a meter in the popover', () => {
    open({})
    expect(screen.getByText('88% of context used')).toBeTruthy()
    expect(screen.getByText('~176k of ~200k tokens').getAttribute('title')).toBe(
      '176,000 of 200,000 tokens'
    )
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('88')
  })

  it('explains that there is no reading before the first turn', () => {
    open({ reading: null })
    expect(screen.getByText('Context usage appears after the first turn')).toBeTruthy()
  })

  it('sends a compaction when Compact conversation is clicked while idle', () => {
    const onCompact = open({})
    fireEvent.click(compactButton())
    expect(onCompact).toHaveBeenCalledOnce()
  })

  it('disables Compact while a turn runs, keeping it focusable for its tooltip', () => {
    const onCompact = open({ running: true })
    fireEvent.click(compactButton())
    expect(compactButton().getAttribute('aria-disabled')).toBe('true')
    expect(onCompact).not.toHaveBeenCalled()
  })

  it('marks Compact busy while compaction runs', () => {
    open({ running: true, compacting: true })
    expect(compactButton().disabled).toBe(true)
    expect(compactButton().getAttribute('aria-busy')).toBe('true')
  })

  it('shows why the last compaction did not run', () => {
    open({ failure: { reason: 'nothingToCompact', message: 'Not enough messages to compact.' } })
    expect(screen.getByRole('status').textContent).toBe('Not enough messages to compact.')
  })
})
