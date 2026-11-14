import type { StoredEvent, TokenUsage } from '@dia/plugin'
import type { Array as Arr } from 'effect'
import type { RunUsage } from './calls'

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

/**
 * The usage after run event `event`, given in sequence order. Each `PaneUserMessagesSent` starts
 * a turn with no tokens, keyed by the ids of its messages; each `PaneTurnUsageReported` adds its
 * tokens to the latest turn, or to a new turn with no messages when none has started. Every other event leaves `usage` unchanged.
 */
export const foldUsage = (usage: RunUsage, event: StoredEvent): RunUsage => {
  switch (event._tag) {
    case 'PaneUserMessagesSent':
      return {
        ...usage,
        turns: [
          ...usage.turns,
          { messageIds: event.messages.map((message) => message.id), usage: noTokens }
        ]
      }
    case 'PaneTurnUsageReported': {
      const latest = usage.turns.at(-1) ?? { messageIds: [], usage: noTokens }
      return {
        turns: [...usage.turns.slice(0, -1), { ...latest, usage: add(latest.usage, event.usage) }],
        total: add(usage.total, event.usage)
      }
    }
    default:
      return usage
  }
}

/** The sum of the four counts of `usage`: every token the main agent loop read or wrote. */
export const tokenTotal = (usage: TokenUsage): number =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

/**
 * The tokens of the turns of `usage` started by any of the messages `messageIds`, summed; 0 tokens
 * when no turn matches. Pass the ids of the user messages that open one stretch of the transcript.
 */
export const usageOfMessages = (usage: RunUsage, messageIds: ReadonlyArray<string>): TokenUsage =>
  usage.turns
    .filter((turn) => turn.messageIds.some((id) => messageIds.includes(id)))
    .reduce((sum, turn) => add(sum, turn.usage), noTokens)
