import { PreviewCard as BasePreviewCard } from '@base-ui/react/preview-card'
// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import type * as React from 'react'

/**
 * Rank 4: more about one entity or property already on screen, such as a person or a stage, in a
 * hover card on that value. Opens 300ms after the pointer enters its trigger and closes as soon as
 * it leaves. Every field in it must also appear in peek and on the item's page.
 */
export function PreviewCard(props: BasePreviewCard.Root.Props): React.ReactElement {
  return <BasePreviewCard.Root {...props} />
}

/**
 * The value that opens its `PreviewCard` on hover. It is not focusable; peek and the item's page are
 * the keyboard and touch routes to the same fields.
 */
export function PreviewCardTrigger({
  className,
  ...props
}: BasePreviewCard.Trigger.Props): React.ReactElement {
  return (
    <BasePreviewCard.Trigger
      data-slot="preview-card-trigger"
      delay={300}
      closeDelay={0}
      render={<span />}
      className={cn(
        'inline-flex min-h-6 min-w-6 max-w-full items-center justify-center',
        className
      )}
      {...props}
    />
  )
}

/** Props for {@link PreviewCardContent}. */
export type PreviewCardContentProps = BasePreviewCard.Popup.Props &
  Pick<BasePreviewCard.Positioner.Props, 'align' | 'side' | 'sideOffset' | 'collisionAvoidance'> &
  Pick<BasePreviewCard.Portal.Props, 'container'>

/**
 * The card drawn below its trigger. It may hold links. It renders into `<body>` unless `container`
 * names another element, such as a scaled or panned canvas the card must move with. A click inside
 * it does not reach the trigger's ancestors, so it never activates the row link around the trigger.
 */
export function PreviewCardContent({
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  collisionAvoidance,
  container,
  className,
  onClick,
  ...props
}: PreviewCardContentProps): React.ReactElement {
  return (
    <BasePreviewCard.Portal container={container}>
      <BasePreviewCard.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionAvoidance={collisionAvoidance}
        className="z-popover"
      >
        <BasePreviewCard.Popup
          data-slot="preview-card-content"
          className={cn(
            'w-60 origin-(--transform-origin) rounded-lg border bg-popover p-3 text-popover-foreground text-xs shadow-popover transition-[opacity,scale] duration-quick ease-out data-ending-style:opacity-0 data-ending-style:duration-0 data-starting-style:scale-(--preview-card-enter-scale) data-starting-style:opacity-0 motion-reduce:transition-none',
            className
          )}
          onClick={(event) => {
            event.stopPropagation()
            onClick?.(event)
          }}
          {...props}
        />
      </BasePreviewCard.Positioner>
    </BasePreviewCard.Portal>
  )
}
