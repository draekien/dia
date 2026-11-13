/**
 * A token count rounded for the transcript: the nearest thousand with a `~`
 * (`94533` → `'~95k'`), `'<1k'` for a count below 500, which would round to
 * zero, and millions to one decimal from 999,500 (`1250000` → `'~1.3M'`). Pair
 * it with {@link exactTokens} for the full value.
 */
export const approximateTokens = (count: number): string => {
  if (count < 500) return '<1k'
  if (count < 999_500) return `~${Math.round(count / 1000)}k`
  return `~${Math.round(count / 100_000) / 10}M`
}

/**
 * A token count in full with its unit (`94533` → `'94,533 tokens'`), grouped
 * with the `en-US` locale so the text does not depend on the machine's locale.
 */
export const exactTokens = (count: number): string => `${count.toLocaleString('en-US')} tokens`
