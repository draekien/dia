import type { UpdateStatus } from '@shared/domain/update'
import { Loader2Icon, RotateCwIcon } from 'lucide-react'
import { useUpdateStatus } from '../hooks/use-update-status'
import { openCommandPalette } from './command-palette'
import { PluginLoadIndicator } from './plugin-load-indicator'
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
 * The window-wide status items: plugin loading progress, the background self-update state (a
 * restart button when an update is ready) and a hint that opens the command palette. Render it at
 * the right end of a `titlebar-drag` header row; its buttons are excluded from the drag region.
 */
export function WindowStatus() {
  const status = useUpdateStatus()

  return (
    <div className="flex items-center gap-2">
      <PluginLoadIndicator />
      <UpdateIndicator status={status} />
      <CommandPaletteHint />
    </div>
  )
}
