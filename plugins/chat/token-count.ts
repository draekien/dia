/**
 * A token count rounded for the transcript: the nearest thousand with a `~`
 * (`94533` → `'~95k'`), or `'<1k'` for a count below 500, which would round to
 * zero. Pair it with {@link exactTokens} for the full value.
 */
export const approximateTokens = (count: number): string =>
  count < 500 ? '<1k' : `~${Math.round(count / 1000)}k`

/**
 * A token count in full with its unit (`94533` → `'94,533 tokens'`), grouped
 * with the `en-US` locale so the text does not depend on the machine's locale.
 */
export const exactTokens = (count: number): string => `${count.toLocaleString('en-US')} tokens`
