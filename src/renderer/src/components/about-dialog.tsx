import type { UpdateStatus } from '@shared/domain/update'
import { useQuery } from '@tanstack/react-query'
import { RotateCwIcon } from 'lucide-react'
import { useUpdateStatus } from '../hooks/use-update-status'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

function describeUpdateStatus(status: UpdateStatus): string {
  switch (status._tag) {
    case 'UpdateChecking':
      return 'Checking for updates…'
    case 'UpdateDownloading':
      return `Downloading update… ${Math.round(status.percent)}%`
    case 'UpdateReady':
      return `Version ${status.version} is ready to install.`
    case 'UpdateUpToDate':
      return "You're on the latest version."
    case 'UpdateError':
      return "Couldn't check for updates."
    case 'UpdateIdle':
      return ''
  }
}

const BUSY_TAGS: ReadonlySet<UpdateStatus['_tag']> = new Set([
  'UpdateChecking',
  'UpdateDownloading'
])

/**
 * The "About dia" dialog, opened from the command palette. Shows the running
 * version and the current self-update state, with a "Check for updates" action
 * (or "Restart to update" once one is downloaded). Controlled by `open` /
 * `onOpenChange` from its host.
 */
export function AboutDialog({
  open,
  onOpenChange
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { data: version } = useQuery({
    queryKey: ['appVersion'],
    queryFn: () => window.dia.getAppVersion()
  })
  const status = useUpdateStatus()
  const description = describeUpdateStatus(status)
  const busy = BUSY_TAGS.has(status._tag)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>About dia</DialogTitle>
          <DialogDescription>
            A personal desktop app that drives your local Claude installation via the Agent SDK.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-ink-muted">Version</span>
            <span className="font-mono text-sm text-ink">{version ? `v${version}` : '—'}</span>
          </div>
          {description !== '' && <p className="text-sm text-ink-muted">{description}</p>}
        </div>
        <DialogFooter>
          {status._tag === 'UpdateReady' ? (
            <Button onClick={() => window.dia.installUpdate()}>
              <RotateCwIcon />
              Restart to update
            </Button>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => window.dia.checkForUpdates()}>
              Check for updates
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
