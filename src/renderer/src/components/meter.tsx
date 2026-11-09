import { Meter as BaseMeter } from '@base-ui/react/meter'
// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import type * as React from 'react'

/** Props for {@link Meter}. */
export type MeterProps = Omit<BaseMeter.Root.Props, 'children' | 'locale'> & {
  /** The locale to format the value in. Defaults to `"en"` so server and browser render the same text. */
  locale?: Intl.LocalesArgument
}

/**
 * A measurement within a known range, drawn as a 64px bar and its value, such as how much of an
 * invoice is paid. Name it with `aria-label`. In an abbreviated `ListRowFact` the bar is dropped
 * and the value stays.
 */
export function Meter({ locale = 'en', className, ...props }: MeterProps): React.ReactElement {
  return (
    <BaseMeter.Root
      data-slot="meter"
      locale={locale}
      className={cn('inline-flex items-center gap-2', className)}
      {...props}
    >
      <BaseMeter.Track
        data-abbreviation="long"
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
      >
        <BaseMeter.Indicator className="h-full rounded-full bg-foreground/70" />
      </BaseMeter.Track>
      <BaseMeter.Value className="min-w-(--meter-value-min) text-end text-xs tabular-nums" />
    </BaseMeter.Root>
  )
}
