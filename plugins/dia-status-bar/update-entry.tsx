import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useUpdateStatus
} from '@dia/renderer-plugin'
import { DownloadIcon, Loader2Icon } from 'lucide-react'

/**
 * The status bar entry for dia's self-update. While an update downloads it shows the progress;
 * once one is downloaded it shows "Restart to update", which installs it on click. In every other
 * update state it renders nothing. Add it to `StatusBarItemsSlot`; it takes no props.
 */
export function UpdateEntry() {
  const status = useUpdateStatus()
  if (status._tag === 'UpdateDownloading') {
    return (
      <span className="flex h-6 items-center gap-1 px-1.5 text-xs font-medium text-ink-muted">
        <Loader2Icon aria-hidden className="size-3 animate-spin" />
        Updating… {Math.round(status.percent)}%
      </span>
    )
  }
  if (status._tag !== 'UpdateReady') return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-ink"
            onClick={() => window.dia.installUpdate()}
          />
        }
      >
        <DownloadIcon aria-hidden className="text-primary" />
        Restart to update
      </TooltipTrigger>
      <TooltipContent side="top">Version {status.version} is ready to install.</TooltipContent>
    </Tooltip>
  )
}
