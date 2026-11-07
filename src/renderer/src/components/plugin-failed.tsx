import { cva, type VariantProps } from 'class-variance-authority'
import { TriangleAlertIcon } from 'lucide-react'
import { openPluginsPage } from '../lib/actions'
import { Button } from './ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from './ui/empty'

const pluginFailedVariants = cva('', {
  variants: {
    size: {
      area: '',
      card: 'items-start gap-1.5 p-0 text-left'
    }
  },
  defaultVariants: { size: 'area' }
})

const reasonOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

type PluginFailedProps = VariantProps<typeof pluginFailedVariants> & {
  readonly plugin: string
  readonly error: unknown
  readonly onRetry: () => void
}

/**
 * Shown in place of a component `plugin` supplied that threw while rendering: names the plugin,
 * shows the thrown `error`, and offers `onRetry` and the Plugins page. Return it from a
 * `PluginBoundary` fallback. `size` is `area` (the default) where the component filled a region
 * of the window, and `card` inside a session rail card.
 */
export function PluginFailed({ plugin, error, onRetry, size }: PluginFailedProps) {
  const title = `The ${plugin} plugin failed to show this`
  const reason = reasonOf(error)
  if (size === 'card') {
    return (
      <Empty className={pluginFailedVariants({ size })}>
        <EmptyTitle className="flex items-center gap-1.5 font-normal text-xs">
          <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-error" />
          {title}
        </EmptyTitle>
        <EmptyDescription title={reason} className="w-full truncate pl-4.5 font-mono text-xs">
          {reason}
        </EmptyDescription>
        <Button variant="link" size="xs" className="ml-4.5 h-auto p-0" onClick={onRetry}>
          Try again
        </Button>
      </Empty>
    )
  }
  return (
    <Empty className={pluginFailedVariants({ size })}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-error/12 text-error">
          <TriangleAlertIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription
          title={reason}
          className="line-clamp-2 w-full rounded-md bg-secondary px-2 py-1.5 text-left font-mono text-xs text-ink"
        >
          {reason}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center gap-1.5">
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
        <Button variant="ghost" size="sm" onClick={openPluginsPage}>
          Open Plugins
        </Button>
      </EmptyContent>
    </Empty>
  )
}
