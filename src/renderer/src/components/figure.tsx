// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import type * as React from 'react'

/** Props for {@link Figure}. */
export type FigureProps = Omit<React.ComponentProps<'data'>, 'children' | 'value'> & {
  /** The number. */
  value: number
  /** How to format it, as `Intl.NumberFormat` options, for example `{ style: "currency", currency: "AUD" }`. */
  format?: Intl.NumberFormatOptions
  /** The locale to format it in. Defaults to `"en"` so server and browser render the same text. */
  locale?: Intl.LocalesArgument
}

/**
 * A number the caller compares down a list, in tabular figures and pushed to the end of its
 * column. In an abbreviated `ListRowFact` it switches to compact notation, such as `$13K`.
 */
export function Figure({
  value,
  format,
  locale = 'en',
  className,
  ...props
}: FigureProps): React.ReactElement {
  const long = new Intl.NumberFormat(locale, format).format(value)
  const short = new Intl.NumberFormat(locale, { ...format, notation: 'compact' }).format(value)
  return (
    <data
      data-slot="figure"
      value={String(value)}
      className={cn('ms-auto whitespace-nowrap tabular-nums', className)}
      {...props}
    >
      <span data-abbreviation="long">{long}</span>
      <span data-abbreviation="short" aria-hidden="true" className="hidden">
        {short}
      </span>
    </data>
  )
}
