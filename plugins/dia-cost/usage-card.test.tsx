// @vitest-environment jsdom

import type { TokenUsage } from '@dia/plugin'
import { cleanup, render, screen } from '@testing-library/react'
import { Option, Stream } from 'effect'
import { Atom } from 'effect/reactivity'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunUsage } from './calls'
import { type UsageAtoms, UsageCard } from './usage-card'

afterEach(cleanup)

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

const followed = (usage: RunUsage) =>
  Atom.family((_runId: string) =>
    Atom.make(Stream.make(Option.some(usage)))
  ) as unknown as UsageAtoms

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
