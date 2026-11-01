// @vitest-environment jsdom

import { TooltipProvider } from '@dia/renderer-plugin'
import type { CompactionFailure, ContextUsage } from '@shared/domain/context-usage'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextUsageView } from './context-card'

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

const show = ({
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
      <ContextUsageView
        usage={reading}
        failure={failure}
        compacting={compacting}
        running={running}
        onCompact={onCompact}
      />
    </TooltipProvider>
  )
  return onCompact
}

const compactButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Compact conversation' })

describe('ContextUsageView', () => {
  it('shows the share, the token counts and a meter', () => {
    show({})
    expect(screen.getByText('88% of context used')).toBeTruthy()
    expect(screen.getByText('~176k of ~200k tokens').getAttribute('title')).toBe(
      '176,000 of 200,000 tokens'
    )
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('88')
  })

  it('says there is no usage before the first reading', () => {
    show({ reading: null })
    expect(screen.getByText('No usage yet')).toBeTruthy()
  })

  it('sends a compaction when Compact conversation is clicked while idle', () => {
    const onCompact = show({})
    fireEvent.click(compactButton())
    expect(onCompact).toHaveBeenCalledOnce()
  })

  it('disables Compact while a turn runs, keeping it focusable for its tooltip', () => {
    const onCompact = show({ running: true })
    fireEvent.click(compactButton())
    expect(compactButton().getAttribute('aria-disabled')).toBe('true')
    expect(onCompact).not.toHaveBeenCalled()
  })

  it('marks Compact busy while compaction runs', () => {
    show({ running: true, compacting: true })
    expect(compactButton().disabled).toBe(true)
    expect(compactButton().getAttribute('aria-busy')).toBe('true')
  })

  it('shows why the last compaction did not run', () => {
    show({ failure: { reason: 'nothingToCompact', message: 'Not enough messages to compact.' } })
    expect(screen.getByRole('status').textContent).toBe('Not enough messages to compact.')
  })
})
