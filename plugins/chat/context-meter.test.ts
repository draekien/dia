import { describe, expect, it } from 'vitest'
import {
  contextColor,
  contextNeedsAttention,
  contextPercent,
  contextTokensExact,
  contextTokensLine
} from './context-meter'

const MAX = 400_000
const THRESHOLD = 367_000

const at = (share: number, autoCompactThreshold?: number) => ({
  totalTokens: Math.round(share * MAX),
  maxTokens: MAX,
  ...(autoCompactThreshold !== undefined ? { autoCompactThreshold } : {})
})

const NEUTRAL = 'var(--ink-muted)'
const AMBER = 'var(--pulse-amber)'
const RED = 'var(--pulse-red)'

describe('contextColor with an auto-compact threshold (91.75%)', () => {
  it.each([
    ['0%', 0, NEUTRAL],
    ['50%', 0.5, NEUTRAL],
    ['62%, 48% of the way from 50% to 75%', 0.62, `color-mix(in oklab, ${AMBER} 48%, ${NEUTRAL})`],
    ['75%', 0.75, AMBER],
    ['85%, 60% of the way from 75% to 91.75%', 0.85, `color-mix(in oklch, ${RED} 60%, ${AMBER})`],
    ['the threshold', THRESHOLD / MAX, RED],
    ['100%', 1, RED]
  ])('is %s', (_name, share, colour) => {
    expect(contextColor(at(share, THRESHOLD), false)).toBe(colour)
  })
})

describe('contextColor without a threshold (red at 90%)', () => {
  it.each([
    ['0%', 0, NEUTRAL],
    ['50%', 0.5, NEUTRAL],
    ['62%', 0.62, `color-mix(in oklab, ${AMBER} 48%, ${NEUTRAL})`],
    ['75%', 0.75, AMBER],
    [
      '85%, two thirds of the way from 75% to 90%',
      0.85,
      `color-mix(in oklch, ${RED} 67%, ${AMBER})`
    ],
    ['90%', 0.9, RED],
    ['100%', 1, RED]
  ])('is %s', (_name, share, colour) => {
    expect(contextColor(at(share), false)).toBe(colour)
  })
})

describe('contextColor after a failed compaction', () => {
  it('is red at low usage', () => {
    expect(contextColor(at(0.1, THRESHOLD), true)).toBe(RED)
  })
})

describe('context meter text', () => {
  const usage = { totalTokens: 176_000, maxTokens: 200_000 }

  it('rounds the percentage', () => {
    expect(contextPercent(usage)).toBe(88)
  })

  it('reads tokens in thousands', () => {
    expect(contextTokensLine(usage)).toBe('~176k of ~200k tokens')
  })

  it('reads tokens in full', () => {
    expect(contextTokensExact(usage)).toBe('176,000 of 200,000 tokens')
  })

  it('caps the percentage at 100 when the reading exceeds the window', () => {
    expect(contextPercent({ totalTokens: 210_000, maxTokens: 200_000 })).toBe(100)
  })
})

describe('contextNeedsAttention', () => {
  const at = (totalTokens: number) => ({ totalTokens, maxTokens: 200_000 })

  it('stays quiet just below full amber', () => {
    expect(contextNeedsAttention(at(149_999), false)).toBe(false)
  })

  it('warns from full amber, 75% of the window', () => {
    expect(contextNeedsAttention(at(150_000), false)).toBe(true)
  })

  it('warns at any usage after a failed compaction', () => {
    expect(contextNeedsAttention(at(10_000), true)).toBe(true)
  })
})
