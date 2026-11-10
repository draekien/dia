import { Avatar as BaseAvatar } from '@base-ui/react/avatar'
import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import * as React from 'react'

/** Props for {@link Avatar}. */
export type AvatarProps = BaseAvatar.Root.Props & {
  /** `"default"` is 20px and `"lg"` 24px. Inside an `AvatarGroup`, the group's size sets it instead. */
  size?: 'default' | 'lg'
  /** `"circle"` for one person; `"square"` for a team or organisation. */
  shape?: 'circle' | 'square'
}

/**
 * One person or team drawn as their picture, or their initials while there is none. Compose
 * `AvatarImage` and `AvatarFallback` inside it. It is hidden from screen readers: the name beside
 * it, or the control around it, names who it is.
 */
export function Avatar({
  size = 'default',
  shape = 'circle',
  className,
  ...props
}: AvatarProps): React.ReactElement {
  return (
    <BaseAvatar.Root
      data-slot="avatar"
      aria-hidden="true"
      className={cn(
        'relative inline-flex size-(--avatar-size) [--avatar-offset:calc(var(--avatar-size)*var(--avatar-overlap))] shrink-0 select-none items-center justify-center overflow-hidden bg-muted font-medium text-micro text-muted-foreground uppercase',
        size === 'lg' ? '[--avatar-size:--spacing(6)]' : '[--avatar-size:--spacing(5)]',
        shape === 'square' ? 'rounded-floor' : 'rounded-full',
        className
      )}
      {...props}
    />
  )
}

/** The person's picture; it fills the avatar, and `AvatarFallback` shows until it loads. */
export function AvatarImage({ className, ...props }: BaseAvatar.Image.Props): React.ReactElement {
  return (
    <BaseAvatar.Image
      data-slot="avatar-image"
      className={cn('size-full object-cover', className)}
      {...props}
    />
  )
}

/** The initials shown while there is no picture, such as "MO". */
export function AvatarFallback(props: BaseAvatar.Fallback.Props): React.ReactElement {
  return <BaseAvatar.Fallback data-slot="avatar-fallback" {...props} />
}

const spreadClass = cn(
  '*:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background *:data-[slot=avatar]:transition-[margin-inline-start] *:data-[slot=avatar]:duration-quick *:data-[slot=avatar]:ease-out motion-reduce:*:data-[slot=avatar]:transition-none',
  '*:data-[slot=avatar]:not-first:-ms-(--avatar-offset)',
  '[&:is(:hover,:focus-visible,[data-popup-open],[data-spread])>[data-slot=avatar]:not(:first-child)]:ms-1',
  '[:is(a,button):is(:hover,:focus-visible,[data-popup-open])_&>[data-slot=avatar]:not(:first-child)]:ms-1'
)

/** Props for {@link AvatarGroup}. */
export type AvatarGroupProps = useRender.ComponentProps<'span'> & {
  /** How many avatars to draw before a "+N" avatar counts the rest. Defaults to 3; one more is drawn instead of "+1". */
  max?: number
  /** Sets every avatar in the group: `"default"` 20px, `"lg"` 24px. */
  size?: 'default' | 'lg'
  /** Names the group for screen readers, such as "6 watchers". Required when the group renders as a trigger, since its avatars are hidden from screen readers. */
  label?: string
}

/**
 * Several `Avatar`s overlapping by half their width. They spread 4px apart while the group, or the
 * button or link around it, is hovered, focused or open. Render it as a trigger, such as
 * `render={<Popover.Trigger />}`, so the names it hides can be reached.
 */
export function AvatarGroup({
  max = 3,
  size = 'default',
  label,
  render,
  className,
  children,
  ...props
}: AvatarGroupProps): React.ReactElement {
  const items = React.Children.toArray(children)
  const shown = items.length > max + 1 ? max : items.length
  const rest = items.length - shown
  return useRender({
    defaultTagName: 'span',
    render,
    state: { size },
    props: mergeProps<'span'>(
      {
        className: cn(
          'data-[size=default]:*:[--avatar-size:--spacing(5)] data-[size=lg]:*:[--avatar-size:--spacing(6)] inline-flex min-h-6 shrink-0 items-center outline-hidden [&:is(button,a)]:rounded-floor [&:is(button,a)]:focus-ring [&:is(button,a)]:pointer-coarse:min-h-11',
          spreadClass,
          className
        ),
        children: (
          <>
            {items.slice(0, shown)}
            {rest > 0 ? <Avatar>+{rest}</Avatar> : null}
            {label === undefined ? null : <span className="sr-only">{label}</span>}
          </>
        )
      },
      props
    )
  })
}
