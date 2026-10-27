// @effect-diagnostics globalDate:off -- Intl.DateTimeFormat formats a Date; no Effect runtime exists in the renderer.
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

/**
 * Formats the ISO time `iso` for a status caption in the user's locale: the time of day when it
 * falls on the same local day as `now`, otherwise the day and month.
 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const when = new Date(iso)
  return when.toDateString() === now.toDateString()
    ? timeFormat.format(when)
    : dayFormat.format(when)
}
