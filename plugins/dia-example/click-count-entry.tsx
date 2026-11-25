import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@dia/renderer-plugin'
import { useAtom } from '@effect/atom-react'
import type { Atom } from 'effect/reactivity'

/**
 * The example plugin's status bar entry: shows how many times it was clicked, and counts one more
 * on each click. `clicks` holds the count; the plugin creates it in setup, so the count lasts
 * until the plugin itself unloads. Add it to `StatusBarItemsSlot`.
 */
export function ClickCountEntry({ clicks }: { readonly clicks: Atom.Writable<number> }) {
  const [count, setCount] = useAtom(clicks)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-ink-muted"
            onClick={() => setCount(count + 1)}
          />
        }
      >
        {count === 1 ? 'Example: 1 click' : `Example: ${count} clicks`}
      </TooltipTrigger>
      <TooltipContent side="top">The example plugin counts clicks on this entry</TooltipContent>
    </Tooltip>
  )
}
