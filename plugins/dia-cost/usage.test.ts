import { PaneEvents, type StoredEvent, type TokenUsage } from '@dia/plugin'
import { describe, expect, it } from 'vitest'
import { emptyRunUsage, foldUsage, tokenTotal, usageOfMessages } from './usage'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

const sent = (...texts: ReadonlyArray<string>) =>
  PaneEvents.PaneUserMessagesSent.make({
    paneId: RUN,
    messages: texts.map((text) => ({ id: `id:${text}`, text }))
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
        { messageIds: ['id:fix the bug'], usage: a },
        { messageIds: ['id:next'], usage: b }
      ],
      total: { inputTokens: 6, outputTokens: 80, cacheReadTokens: 1_000, cacheWriteTokens: 12 }
    })
  })

  it('starts a turn at each message sent, as dia-checkpoints numbers turns', () => {
    const usage = usageOf([sent('first'), sent('steered'), reported(a)])

    expect(usage.turns).toEqual([
      { messageIds: ['id:first'], usage: none },
      { messageIds: ['id:steered'], usage: a }
    ])
  })

  it('adds a second report to the latest turn, as when a parked turn resumes', () => {
    const usage = usageOf([sent('first'), reported(a), reported(b)])

    expect(usage.turns).toEqual([
      {
        messageIds: ['id:first'],
        usage: { inputTokens: 6, outputTokens: 80, cacheReadTokens: 1_000, cacheWriteTokens: 12 }
      }
    ])
  })

  it('keeps a turn that reported no usage at 0 tokens', () => {
    const usage = usageOf([sent('refused'), sent('next'), reported(b)])

    expect(usage.turns.map(({ usage }) => usage)).toEqual([none, b])
  })

  it('puts usage reported before any message in a turn with no messages', () => {
    expect(usageOf([reported(a)]).turns).toEqual([{ messageIds: [], usage: a }])
  })

  it('has no turns and a zero total for a run with no events', () => {
    expect(usageOf([])).toEqual({ turns: [], total: none })
  })
})

describe('foldUsage: message ids', () => {
  it('records every message of a send as starting its turn', () => {
    const usage = usageOf([sent('first', 'second'), reported(a)])

    expect(usage.turns[0]?.messageIds).toEqual(['id:first', 'id:second'])
  })
})

describe('usageOfMessages', () => {
  it('gives the tokens of the turn a message started', () => {
    const usage = usageOf([sent('fix the bug'), reported(a), sent('next'), reported(b)])

    expect(usageOfMessages(usage, ['id:next'])).toEqual(b)
  })

  it('matches a turn by any message of its send, not only the first', () => {
    const usage = usageOf([sent('first', 'second'), reported(a)])

    expect(usageOfMessages(usage, ['id:second'])).toEqual(a)
  })

  it('sums the turns of consecutive messages that each started a turn', () => {
    const usage = usageOf([sent('fix the bug'), reported(a), sent('next'), reported(b)])

    expect(usageOfMessages(usage, ['id:fix the bug', 'id:next'])).toEqual({
      inputTokens: 6,
      outputTokens: 80,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 12
    })
  })

  it('gives 0 tokens for a message that started no turn of the run', () => {
    const usage = usageOf([sent('fix the bug'), reported(a)])

    expect(usageOfMessages(usage, ['id:from another run'])).toEqual(none)
  })
})

describe('tokenTotal', () => {
  it('adds input, output, cache read and cache write', () => {
    expect(
      tokenTotal({
        inputTokens: 4,
        outputTokens: 759,
        cacheReadTokens: 92_484,
        cacheWriteTokens: 1_613
      })
    ).toBe(94_860)
  })
})
