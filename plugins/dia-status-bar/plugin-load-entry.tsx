import {
  actions,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  usePluginList
} from '@dia/renderer-plugin'
import { CircleAlertIcon } from 'lucide-react'

/**
 * The status bar entry for plugins that failed to load. While one or more plugins are in the
 * `Failed` state it shows "1 plugin failed to load" or "N plugins failed to load", with the failed
 * plugins' names in its tooltip, and opens Settings › Plugins on click. While no plugin has failed
 * it renders nothing. Add it to `StatusBarItemsSlot`; it takes no props.
 */
export function PluginLoadEntry() {
  const { plugins } = usePluginList()
  const failed = (plugins ?? []).filter((plugin) => plugin.status._tag === 'Failed')
  if (failed.length === 0) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-ink"
            onClick={actions.openPluginsPage}
          />
        }
      >
        <CircleAlertIcon aria-hidden className="text-error" />
        {failed.length === 1
          ? '1 plugin failed to load'
          : `${failed.length} plugins failed to load`}
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono">
        {failed.map((plugin) => plugin.name).join(', ')}
      </TooltipContent>
    </Tooltip>
  )
}
