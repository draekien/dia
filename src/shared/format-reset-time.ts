// @effect-diagnostics globalDate:off -- Intl.DateTimeFormat formats a Date; the chat reducer that calls this runs outside an Effect runtime.
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekdayTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit'
})

/**
 * Formats the usage-limit time `epochMs` for the account banner, the transcript and the overview
 * in the user's locale: the time of day when it falls on the same local day as `nowMs` (epoch ms),
 * otherwise the weekday and the time.
 */
export function formatResetTime(epochMs: number, nowMs: number): string {
  const when = new Date(epochMs)
  return when.toDateString() === new Date(nowMs).toDateString()
    ? timeFormat.format(when)
    : weekdayTimeFormat.format(when)
}
