// @vitest-environment jsdom

import type { TokenUsage } from '@dia/plugin'
import { TooltipProvider } from '@dia/renderer-plugin'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Option, Stream } from 'effect'
import { Atom } from 'effect/reactivity'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunUsage } from './calls'
import { spokenUsage, TurnUsageLine, TurnUsageView } from './turn-usage-line'
import type { UsageAtoms } from './usage-card'

afterEach(cleanup)

const turn: TokenUsage = {
  inputTokens: 4,
  outputTokens: 759,
  cacheReadTokens: 92_484,
  cacheWriteTokens: 1_613
}

const show = (usage: TokenUsage) =>
  render(
    <TooltipProvider>
      <TurnUsageView usage={usage} />
    </TooltipProvider>
  )

describe('TurnUsageView', () => {
  it('shows the sum of the four counts rounded to the nearest thousand', () => {
    show(turn)

    expect(screen.getByText('~95k tokens')).toBeTruthy()
  })

  it('shows each count when the line has focus', async () => {
    show(turn)

    fireEvent.focus(screen.getByText('~95k tokens').parentElement as HTMLElement)

    expect(await screen.findByText('92,484')).toBeTruthy()
  })

  it('renders nothing for a turn that used no tokens', () => {
    const { container } = show({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    })

    expect(container.textContent).toBe('')
  })
})

describe('spokenUsage', () => {
  it('reads the exact total, then each count with its label', () => {
    expect(spokenUsage(turn)).toBe(
      '94,860 tokens: 4 in, 759 out, 92,484 cache read, 1,613 cache write'
    )
  })
})

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

const followed = (usage: RunUsage) =>
  Atom.family((_runId: string) =>
    Atom.make(Stream.make(Option.some(usage)))
  ) as unknown as UsageAtoms

const later: TokenUsage = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 300_000,
  cacheWriteTokens: 4
}

describe('TurnUsageLine', () => {
  it("shows the tokens of the turn the transcript's user messages started", async () => {
    const usageAtoms = followed({
      turns: [
        { messageIds: ['first'], usage: turn },
        { messageIds: ['second'], usage: later }
      ],
      total: turn
    })

    render(
      <TooltipProvider>
        <TurnUsageLine runId={RUN} messageIds={['second']} usageAtoms={usageAtoms} />
      </TooltipProvider>
    )

    expect(await screen.findByText('~300k tokens')).toBeTruthy()
  })
})
