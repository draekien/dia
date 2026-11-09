// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import type * as React from 'react'

/** Props for {@link RelativeTime}. */
export type RelativeTimeProps = Omit<React.ComponentProps<'time'>, 'children' | 'dateTime'> & {
  /** The moment, as an ISO 8601 string. */
  dateTime: string
  /** The moment to measure from, as an ISO 8601 string. Pass it in so server and browser render the same text. */
  now: string
  /** The locale to format it in. Defaults to `"en"`. */
  locale?: Intl.LocalesArgument
}

const units = [
  { unit: 'minute', seconds: 60, below: 60 * 60 },
  { unit: 'hour', seconds: 60 * 60, below: 24 * 60 * 60 },
  { unit: 'day', seconds: 24 * 60 * 60, below: 7 * 24 * 60 * 60 },
  { unit: 'week', seconds: 7 * 24 * 60 * 60, below: 30 * 24 * 60 * 60 },
  { unit: 'month', seconds: 30 * 24 * 60 * 60, below: 365 * 24 * 60 * 60 },
  { unit: 'year', seconds: 365 * 24 * 60 * 60, below: Number.POSITIVE_INFINITY }
] as const

function relativeParts(dateTime: string, now: string) {
  const seconds = (Date.parse(dateTime) - Date.parse(now)) / 1000
  const size = Math.abs(seconds)
  const match = units.find(
    (entry) => Math.round(size / entry.seconds) * entry.seconds < entry.below
  )
  const { unit, seconds: unitSeconds } = match ?? units[units.length - 1]
  return { amount: Math.round(seconds / unitSeconds), unit }
}

/**
 * A moment stated relative to `now`, such as "2 hours ago". In an abbreviated `ListRowFact` it
 * switches to the narrow form, such as "2h ago".
 */
export function RelativeTime({
  dateTime,
  now,
  locale = 'en',
  className,
  ...props
}: RelativeTimeProps): React.ReactElement {
  const { amount, unit } = relativeParts(dateTime, now)
  const long = new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(amount, unit)
  const short = new Intl.RelativeTimeFormat(locale, { style: 'narrow' }).format(amount, unit)
  return (
    <time
      data-slot="relative-time"
      dateTime={dateTime}
      className={cn('whitespace-nowrap tabular-nums', className)}
      {...props}
    >
      <span data-abbreviation="long">{long}</span>
      <span data-abbreviation="short" aria-hidden="true" className="hidden">
        {short}
      </span>
    </time>
  )
}
