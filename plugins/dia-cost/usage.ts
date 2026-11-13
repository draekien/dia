import type { StoredEvent, TokenUsage } from '@dia/plugin'
import { type Array as Arr, Option } from 'effect'
import type { RunUsage } from './calls'

const PROMPT_LIMIT = 120

/** The run event tags {@link foldUsage} reads: a turn's messages and its reported usage. */
export const USAGE_TAGS = [
  'PaneUserMessagesSent',
  'PaneTurnUsageReported'
] as const satisfies Arr.NonEmptyReadonlyArray<StoredEvent['_tag']>

/**
 * A run's usage after some of its events, and the prompt of the turn in progress, which names the
 * next turn that reports usage. Start from {@link emptyUsageFold}; read `usage`.
 */
export interface UsageFold {
  readonly usage: RunUsage
  readonly pendingPrompt: Option.Option<string>
}

const noTokens: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}

/** The usage of a run with no events: no turns and a total of 0. */
export const emptyUsageFold: UsageFold = {
  usage: { turns: [], total: noTokens },
  pendingPrompt: Option.none()
}

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
 * The fold after run event `event`, given in sequence order. Each `PaneTurnUsageReported` adds a
 * turn named by the first `PaneUserMessagesSent` since the previous one; every other event leaves
 * `fold` unchanged.
 */
export const foldUsage = (fold: UsageFold, event: StoredEvent): UsageFold => {
  switch (event._tag) {
    case 'PaneUserMessagesSent':
      return Option.isSome(fold.pendingPrompt)
        ? fold
        : { ...fold, pendingPrompt: Option.some(promptOf(event.messages[0]?.text ?? '')) }
    case 'PaneTurnUsageReported':
      return {
        usage: {
          turns: [
            ...fold.usage.turns,
            {
              turn: fold.usage.turns.length + 1,
              prompt: Option.getOrElse(fold.pendingPrompt, () => ''),
              usage: event.usage
            }
          ],
          total: add(fold.usage.total, event.usage)
        },
        pendingPrompt: Option.none()
      }
    default:
      return fold
  }
}
