import type { EffortLevel, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk'
import type { ThinkingLevel } from '@shared/domain/pane'

/**
 * Maps a user-facing {@link ThinkingLevel} to the Agent SDK query options that
 * enact it: `off` disables extended thinking, `adaptive` lets the model decide,
 * and `low`/`medium`/`high` run adaptive thinking capped at that reasoning
 * effort. Spread the result into a query's `options`.
 */
export const thinkingOptions = (
  level: ThinkingLevel
): { readonly thinking: ThinkingConfig; readonly effort?: EffortLevel } => {
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
