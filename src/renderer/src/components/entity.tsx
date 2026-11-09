// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { Avatar, type AvatarProps } from '@renderer/components/avatar'
// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import type * as React from 'react'

/**
 * A person, team or organisation drawn as its initials or picture, then its name. Compose
 * `EntityMedia`, then `EntityName`, then an optional `EntityDescription`. In an abbreviated
 * `ListRowFact` and in a `ListRowMedia` only the media is drawn, and the name and description
 * are read by screen readers only.
 */
export function Entity({ className, ...props }: React.ComponentProps<'span'>): React.ReactElement {
  return (
    <span
      data-slot="entity"
      className={cn('inline-flex min-w-0 items-center gap-2', className)}
      {...props}
    />
  )
}

/**
 * A 24px `Avatar` holding the entity's initials, such as "MO", or an `AvatarImage` and an
 * `AvatarFallback`. Pass `shape="square"` for a team or organisation. Hidden from screen readers,
 * so `EntityName` carries the name.
 */
export function EntityMedia({ size = 'lg', className, ...props }: AvatarProps): React.ReactElement {
  return (
    <Avatar
      size={size}
      className={cn('[&_img]:size-full [&_img]:object-cover', className)}
      {...props}
    />
  )
}

/** The entity's name, such as "Mara Okafor". */
export function EntityName({
  className,
  ...props
}: React.ComponentProps<'span'>): React.ReactElement {
  return (
    <span
      data-slot="entity-name"
      data-abbreviation="long"
      className={cn('truncate', className)}
      {...props}
    />
  )
}

/**
 * One line after the name saying more about the entity, such as their team, in muted text. It
 * truncates before the name does.
 */
export function EntityDescription({
  className,
  ...props
}: React.ComponentProps<'span'>): React.ReactElement {
  return (
    <span
      data-slot="entity-description"
      data-abbreviation="long"
      className={cn('min-w-0 grow basis-0 truncate text-muted-foreground', className)}
      {...props}
    />
  )
}
