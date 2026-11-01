import type { ContextUsage } from '@shared/domain/context-usage'

const AMBER_START = 0.5
const AMBER_FULL = 0.75
const RED_WITHOUT_THRESHOLD = 0.9

const NEUTRAL = 'var(--ink-muted)'
const AMBER = 'var(--pulse-amber)'
const RED = 'var(--pulse-red)'

/** The share of the context window `usage` fills, from 0 to 1. */
export const contextFraction = (usage: ContextUsage): number =>
  usage.maxTokens === 0 ? 0 : Math.min(1, usage.totalTokens / usage.maxTokens)

const redEnd = (usage: ContextUsage): number =>
  usage.autoCompactThreshold === undefined || usage.maxTokens === 0
    ? RED_WITHOUT_THRESHOLD
    : usage.autoCompactThreshold / usage.maxTokens

const blend = (space: 'oklab' | 'oklch', to: string, from: string, share: number): string =>
  `color-mix(in ${space}, ${to} ${Math.round(share * 100)}%, ${from})`

/**
 * The CSS colour of the context meter for `usage`. It is neutral up to 50%, blends to amber at
 * 75% (in OKLab, because the near-grey neutral has no hue to interpolate from), then to red at the
 * auto-compact threshold (90% when `usage` has none) in OKLCH, and stays red from there. `compactFailed` makes it red at any usage. Use the result as a CSS `color` or `stroke`.
 */
export const contextColor = (usage: ContextUsage, compactFailed: boolean): string => {
  const fraction = contextFraction(usage)
  const red = redEnd(usage)
  if (compactFailed || fraction >= red) return RED
  if (fraction <= AMBER_START) return NEUTRAL
  if (fraction < AMBER_FULL) {
    return blend('oklab', AMBER, NEUTRAL, (fraction - AMBER_START) / (AMBER_FULL - AMBER_START))
  }
  if (fraction === AMBER_FULL) return AMBER
  return blend('oklch', RED, AMBER, (fraction - AMBER_FULL) / (red - AMBER_FULL))
}

/** The whole percentage of the context window `usage` fills, for example `88`. */
export const contextPercent = (usage: ContextUsage): number =>
  Math.round(contextFraction(usage) * 100)

const thousands = (count: number): string => `${Math.round(count / 1000)}k`

/** The token line for `usage` in thousands, for example `176k of 200k tokens`. */
export const contextTokensLine = (usage: ContextUsage): string =>
  `${thousands(usage.totalTokens)} of ${thousands(usage.maxTokens)} tokens`

/** The token line for `usage` in full, for example `176,000 of 200,000 tokens`. */
export const contextTokensExact = (usage: ContextUsage): string =>
  `${usage.totalTokens.toLocaleString('en-US')} of ${usage.maxTokens.toLocaleString('en-US')} tokens`
