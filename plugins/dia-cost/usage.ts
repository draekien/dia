import type { StoredEvent, TokenUsage } from '@dia/plugin'
import type { Array as Arr } from 'effect'
import type { RunUsage } from './calls'

const PROMPT_LIMIT = 120

/** The run event tags {@link foldUsage} reads: a turn's messages and its reported usage. */
export const USAGE_TAGS = [
  'PaneUserMessagesSent',
  'PaneTurnUsageReported'
] as const satisfies Arr.NonEmptyReadonlyArray<StoredEvent['_tag']>

const noTokens: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}

/** The usage of a run with no events: no turns and a total of 0. */
export const emptyRunUsage: RunUsage = { turns: [], total: noTokens }

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
})

const promptOf = (text: string) =>
  (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  ).slice(0, PROMPT_LIMIT)

/**
 * The usage after run event `event`, given in sequence order. Each `PaneUserMessagesSent` starts
 * a turn with no tokens, named by the first line of its first message; each
 * `PaneTurnUsageReported` adds its tokens to the latest turn, or to a new unnamed turn when none
 * has started. Every other event leaves `usage` unchanged.
 */
export const foldUsage = (usage: RunUsage, event: StoredEvent): RunUsage => {
  switch (event._tag) {
    case 'PaneUserMessagesSent':
      return {
        ...usage,
        turns: [
          ...usage.turns,
          {
            turn: usage.turns.length + 1,
            prompt: promptOf(event.messages[0]?.text ?? ''),
            usage: noTokens
          }
        ]
      }
    case 'PaneTurnUsageReported': {
      const latest = usage.turns.at(-1) ?? { turn: 1, prompt: '', usage: noTokens }
      return {
        turns: [
          ...usage.turns.slice(0, latest.turn - 1),
          { ...latest, usage: add(latest.usage, event.usage) }
        ],
        total: add(usage.total, event.usage)
      }
    }
    default:
      return usage
  }
}
