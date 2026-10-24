import type { EffortLevel, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk'
import type { ThinkingLevel } from '@shared/domain/pane'

/**
 * The Agent SDK query options that enact a thinking level. Spread the result into a query's
 * `options`; an absent field leaves the SDK's own default in effect.
 */
export interface ThinkingOptions {
  readonly thinking?: ThinkingConfig
  readonly effort?: EffortLevel
}

/**
 * Maps a user-facing {@link ThinkingLevel} to the Agent SDK query options that
 * enact it: `off` disables extended thinking, `adaptive` lets the model decide,
 * and `low`/`medium`/`high` run adaptive thinking capped at that reasoning
 * effort. Spread the result into a query's `options`.
 */
export const thinkingOptions = (level: ThinkingLevel): ThinkingOptions => {
  switch (level) {
    case 'off':
      return { thinking: { type: 'disabled' } }
    case 'adaptive':
      return { thinking: { type: 'adaptive' } }
    case 'low':
    case 'medium':
    case 'high':
      return { thinking: { type: 'adaptive' }, effort: level }
  }
}
