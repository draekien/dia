import { PaneEvents, type StoredEvent, type TokenUsage } from '@dia/plugin'
import { describe, expect, it } from 'vitest'
import { emptyRunUsage, foldUsage } from './usage'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

const sent = (...texts: ReadonlyArray<string>) =>
  PaneEvents.PaneUserMessagesSent.make({
    paneId: RUN,
    messages: texts.map((text, index) => ({ id: `m${index}`, text }))
  })

const reported = (usage: TokenUsage) =>
  PaneEvents.PaneTurnUsageReported.make({ paneId: RUN, usage })

const usageOf = (events: ReadonlyArray<StoredEvent>) => events.reduce(foldUsage, emptyRunUsage)

const a: TokenUsage = {
  inputTokens: 1,
  outputTokens: 20,
  cacheReadTokens: 300,
  cacheWriteTokens: 4
}
const b: TokenUsage = {
  inputTokens: 5,
  outputTokens: 60,
  cacheReadTokens: 700,
  cacheWriteTokens: 8
}

const none: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}

describe('foldUsage', () => {
  it('lists each turn with its usage and the total of both', () => {
    const usage = usageOf([sent('fix the bug'), reported(a), sent('next'), reported(b)])

    expect(usage).toEqual({
      turns: [
        { turn: 1, prompt: 'fix the bug', usage: a },
        { turn: 2, prompt: 'next', usage: b }
      ],
      total: { inputTokens: 6, outputTokens: 80, cacheReadTokens: 1_000, cacheWriteTokens: 12 }
    })
  })

  it('names a turn by the first non-blank line of its first message', () => {
    const usage = usageOf([sent('\n  fix the bug  \nmore detail', 'second message'), reported(a)])

    expect(usage.turns[0]?.prompt).toBe('fix the bug')
  })

  it('cuts a prompt to 120 characters', () => {
    const usage = usageOf([sent('x'.repeat(121)), reported(a)])

    expect(usage.turns[0]?.prompt).toBe('x'.repeat(120))
  })

  it('starts a turn at each message sent, as the Changes card numbers turns', () => {
    const usage = usageOf([sent('first'), sent('steered'), reported(a)])

    expect(usage.turns).toEqual([
      { turn: 1, prompt: 'first', usage: none },
      { turn: 2, prompt: 'steered', usage: a }
    ])
  })

  it('adds a second report to the latest turn, as when a parked turn resumes', () => {
    const usage = usageOf([sent('first'), reported(a), reported(b)])

    expect(usage.turns).toEqual([
      {
        turn: 1,
        prompt: 'first',
        usage: { inputTokens: 6, outputTokens: 80, cacheReadTokens: 1_000, cacheWriteTokens: 12 }
      }
    ])
  })

  it('keeps a turn that reported no usage at 0 tokens, so later turns keep their numbers', () => {
    const usage = usageOf([sent('refused'), sent('next'), reported(b)])

    expect(usage.turns.map(({ turn, usage }) => [turn, usage])).toEqual([
      [1, none],
      [2, b]
    ])
  })

  it('puts usage reported before any message in an unnamed first turn', () => {
    expect(usageOf([reported(a)]).turns).toEqual([{ turn: 1, prompt: '', usage: a }])
  })

  it('has no turns and a zero total for a run with no events', () => {
    expect(usageOf([])).toEqual({ turns: [], total: none })
  })
})
