import type { UpdateStatus } from '@shared/domain/update'
import { Loader2Icon, RotateCwIcon } from 'lucide-react'
import { useUpdateStatus } from '../hooks/use-update-status'
import { Button } from './ui/button'

function UpdateIndicator({ status }: { readonly status: UpdateStatus }) {
  if (status._tag === 'UpdateChecking') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Loader2Icon className="size-3.5 animate-spin" />
        Checking for updates…
      </span>
    )
  }
  if (status._tag === 'UpdateDownloading') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Loader2Icon className="size-3.5 animate-spin" />
        Updating… {Math.round(status.percent)}%
      </span>
    )
  }
  if (status._tag === 'UpdateReady') {
    return (
      <Button size="xs" variant="outline" onClick={() => window.dia.installUpdate()}>
        <RotateCwIcon />
        Restart to update
      </Button>
    )
  }
  return null
}

/**
 * The app's custom title bar, shown in place of the native window frame
 * (`titleBarStyle: 'hidden'`). Draggable, hosts the dia wordmark, and surfaces
 * the background self-update state (downloading progress, a restart affordance
 * when ready) beside the OS-drawn window-control overlay. Mount once at the top
 * of the app shell, above the pane grid.
 */
export function AppHeader() {
  const status = useUpdateStatus()

  return (
    <header className="titlebar-drag flex h-10 shrink-0 items-center border-b border-border bg-surface">
      <div
        className="flex h-full items-center gap-3 pr-3 pl-4"
        style={{ width: 'env(titlebar-area-width, 100%)' }}
      >
        <span className="select-none text-sm font-semibold tracking-tight text-ink">dia</span>
        <div className="titlebar-no-drag ml-auto flex items-center">
          <UpdateIndicator status={status} />
        </div>
      </div>
    </header>
  )
}
