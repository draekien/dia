// @vitest-environment jsdom

import type { TokenUsage } from '@dia/plugin'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { followed, RUN } from './usage.fake'
import { UsageCard } from './usage-card'

afterEach(cleanup)

const total: TokenUsage = {
  inputTokens: 620_000,
  outputTokens: 773,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}

describe('UsageCard', () => {
  it('separates the token count from "main agent" with a space, not a character', async () => {
    render(<UsageCard runId={RUN} usageAtoms={followed({ turns: [], total })} />)

    const line = (await screen.findByText('main agent')).parentElement

    expect(line?.textContent).toBe('620,773 tokens main agent')
  })
})
