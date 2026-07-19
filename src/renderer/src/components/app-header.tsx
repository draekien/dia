import type { UpdateStatus } from '@shared/domain/update'
import { Loader2Icon, RotateCwIcon } from 'lucide-react'
import { useUpdateStatus } from '../hooks/use-update-status'
import { openCommandPalette } from './command-palette'
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

const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)

function CommandPaletteHint() {
  return (
    <Button
      size="xs"
      variant="ghost"
      className="gap-1.5 text-ink-muted"
      onClick={openCommandPalette}
    >
      <span>Commands</span>
      <kbd className="flex items-center gap-0.5 font-mono text-[0.6875rem] leading-none tracking-tight">
        <span>{isMac ? '⌘' : 'Ctrl'}</span>
        <span>K</span>
      </kbd>
    </Button>
  )
}

/**
 * The app's custom title bar, shown in place of the native window frame
 * (`titleBarStyle: 'hidden'`). Draggable and background-transparent so it reads
 * as one continuous surface with the app body and the OS-drawn window-control
 * overlay; hosts the dia wordmark, the background self-update state (downloading
 * progress, a restart affordance when ready), and a hint for the command-palette
 * shortcut that opens it on click. Mount once at the top of the app shell, above
 * the pane grid.
 */
export function AppHeader() {
  const status = useUpdateStatus()

  return (
    <header className="titlebar-drag flex h-10 shrink-0 items-center">
      <div
        className="flex h-full items-center gap-3 pr-3 pl-4"
        style={{ width: 'env(titlebar-area-width, 100%)' }}
      >
        <span className="select-none text-sm font-semibold tracking-tight text-ink">dia</span>
        <div className="titlebar-no-drag ml-auto flex items-center gap-2">
          <UpdateIndicator status={status} />
          <CommandPaletteHint />
        </div>
      </div>
    </header>
  )
}
