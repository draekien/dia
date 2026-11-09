// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import type * as React from 'react'

/**
 * A state drawn as a dot and its name. Compose `StatusMedia`, then `StatusName`, then an optional
 * `StatusDescription`. In an abbreviated `ListRowFact` and in a `ListRowMedia` only the dot is
 * drawn, and the name and description are read by screen readers only.
 */
export function Status({ className, ...props }: React.ComponentProps<'span'>): React.ReactElement {
  return (
    <span
      data-slot="status"
      className={cn('inline-flex min-w-0 items-center gap-2', className)}
      {...props}
    />
  )
}

const dotFill = {
  none: 'border-dashed text-muted-foreground',
  half: 'bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]',
  full: 'bg-current'
} as const

/** Props for {@link StatusMedia}. */
export type StatusMediaProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  /** How much of the dot is filled: `"none"` (dashed ring) for a state not started, `"half"` in progress, `"full"` done. */
  fill: keyof typeof dotFill
}

/** A 10px dot whose fill tells states apart by shape, not colour. Hidden from screen readers. */
export function StatusMedia({ fill, className, ...props }: StatusMediaProps): React.ReactElement {
  return (
    <span
      data-slot="status-media"
      aria-hidden="true"
      className={cn(
        'size-2.5 shrink-0 rounded-full border-(length:--status-media-ring) border-current',
        dotFill[fill],
        className
      )}
      {...props}
    />
  )
}

/** The state's name, such as "In review". */
export function StatusName({
  className,
  ...props
}: React.ComponentProps<'span'>): React.ReactElement {
  return (
    <span
      data-slot="status-name"
      data-abbreviation="long"
      className={cn('truncate', className)}
      {...props}
    />
  )
}

/**
 * One line after the name saying more about the state, such as "since 3 Oct", in muted text. It
 * truncates before the name does.
 */
export function StatusDescription({
  className,
  ...props
}: React.ComponentProps<'span'>): React.ReactElement {
  return (
    <span
      data-slot="status-description"
      data-abbreviation="long"
      className={cn('min-w-0 grow basis-0 truncate text-muted-foreground', className)}
      {...props}
    />
  )
}
