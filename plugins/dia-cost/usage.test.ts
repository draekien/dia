import { PaneEvents, type StoredEvent, type TokenUsage } from '@dia/plugin'
import { describe, expect, it } from 'vitest'
import { emptyUsageFold, foldUsage } from './usage'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

const sent = (...texts: ReadonlyArray<string>) =>
  PaneEvents.PaneUserMessagesSent.make({
    paneId: RUN,
    messages: texts.map((text, index) => ({ id: `m${index}`, text }))
  })

const reported = (usage: TokenUsage) =>
  PaneEvents.PaneTurnUsageReported.make({ paneId: RUN, usage })

const usageOf = (events: ReadonlyArray<StoredEvent>) =>
  events.reduce(foldUsage, emptyUsageFold).usage

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

describe('foldUsage', () => {
  it('lists each reported turn with its usage and the total of both', () => {
    const usage = usageOf([sent('fix the bug'), reported(a), sent('next'), reported(b)])

    expect(usage).toEqual({
      turns: [
        { turn: 1, prompt: 'fix the bug', usage: a },
        { turn: 2, prompt: 'next', usage: b }
      ],
      total: { inputTokens: 6, outputTokens: 80, cacheReadTokens: 1_000, cacheWriteTokens: 12 }
    })
  })

  it("names a turn by the first non-blank line of its prompt's first message", () => {
    const usage = usageOf([sent('\n  fix the bug  \nmore detail', 'second message'), reported(a)])

    expect(usage.turns[0]?.prompt).toBe('fix the bug')
  })

  it('names a turn by the first message sent since the previous turn', () => {
    const usage = usageOf([sent('first'), sent('steered'), reported(a)])

    expect(usage.turns[0]?.prompt).toBe('first')
  })

  it('cuts a prompt to 120 characters', () => {
    const usage = usageOf([sent('x'.repeat(121)), reported(a)])

    expect(usage.turns[0]?.prompt).toBe('x'.repeat(120))
  })

  it('leaves the prompt empty for a turn with no message of its own', () => {
    const usage = usageOf([sent('first'), reported(a), reported(b)])

    expect(usage.turns.map((turn) => turn.prompt)).toEqual(['first', ''])
  })

  it('has no turns and a zero total for a run with no usage', () => {
    expect(usageOf([sent('pending')])).toEqual(emptyUsageFold.usage)
  })
})
