import {
  actions,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  usePluginList
} from '@dia/renderer-plugin'
import { Effect } from 'effect'
import { CircleAlertIcon } from 'lucide-react'
import { useEffect } from 'react'

const log = (message: string, annotations?: Record<string, unknown>) =>
  Effect.runSync(Effect.logDebug(message, annotations))

/**
 * The status bar entry for plugins that failed to load. While one or more plugins are in the
 * `Failed` state it shows "1 plugin failed to load" or "N plugins failed to load", with the failed
 * plugins' names in its tooltip, and opens Settings › Plugins on click. While no plugin has failed
 * it renders nothing. Add it to `StatusBarItemsSlot`; it takes no props.
 */
export function PluginLoadEntry() {
  const { plugins } = usePluginList()
  const failed = (plugins ?? []).filter((plugin) => plugin.status._tag === 'Failed')
  const failedNames = failed.map((plugin) => plugin.name).join(', ')
  useEffect(() => {
    if (failedNames === '') return
    log('Showed the failed plugins in the status bar', { plugins: failedNames })
  }, [failedNames])
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
        {`${failed.length} plugin${failed.length === 1 ? '' : 's'} failed to load`}
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono">
        {failedNames}
      </TooltipContent>
    </Tooltip>
  )
}
