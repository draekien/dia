import type { ActivityInfoJson } from '@shared/ipc/contract'
import {
  formatMegabytes,
  PLUGIN_MEMORY_LIMIT,
  type PluginInfo,
  type PluginStatus
} from '@shared/plugin/manifest'
import { ByteSize } from 'effect'
import { FolderIcon, Loader2Icon, PlayIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useActivities } from '../../hooks/use-activities'
import { type OverrideRejection, usePlugins } from '../../hooks/use-plugins'
import { formatWhen } from '../../lib/format-when'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'

const limitBytes = ByteSize.toNumberUnsafe(PLUGIN_MEMORY_LIMIT)

/** The short label for a plugin's load state, such as "Loaded" or "Failed to load". */
export const statusLabel = (status: PluginStatus): string => {
  switch (status._tag) {
    case 'Unloaded':
      return 'Not loaded'
    case 'Loading':
      return 'Loading…'
    case 'Loaded':
      return status.reloadError === undefined ? 'Loaded' : 'Loaded · last reload failed'
    case 'Failed':
      return 'Failed to load'
    case 'Waiting':
      return `Waiting for ${status.missing.join(', ')}`
    case 'RestartRequired':
      return 'Restart dia to reload'
  }
}

const statusDetail = (status: PluginStatus): string | undefined => {
  switch (status._tag) {
    case 'Loaded':
      return status.reloadError
    case 'Failed':
    case 'RestartRequired':
      return status.message
    default:
      return undefined
  }
}

const activityLabel = ({ status }: ActivityInfoJson): string => {
  if (status._tag === 'Running') return 'Running…'
  const next = formatWhen(status.nextRunAt)
  switch (status.lastRun?._tag) {
    case undefined:
      return `Not run yet · due ${next}`
    case 'RunSucceeded':
      return `Ran ${formatWhen(status.lastRun.at)} · next ${next}`
    case 'RunFailed':
      return `Failed ${formatWhen(status.lastRun.at)} · retries ${next}`
  }
}

const activityKey = (activity: ActivityInfoJson): string => `${activity.plugin}/${activity.id}`

const runOutcome = (activity: ActivityInfoJson): string =>
  activity.status.lastRun?._tag === 'RunFailed'
    ? `${activity.label} failed`
    : `${activity.label} finished`

function useActivityAnnouncement(activities: ReadonlyArray<ActivityInfoJson> | undefined): string {
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef(new Map<string, ActivityInfoJson['status']['_tag']>())

  useEffect(() => {
    if (activities === undefined) return
    for (const activity of activities) {
      const before = previous.current.get(activityKey(activity))
      const now = activity.status._tag
      if (before === 'Scheduled' && now === 'Running') setAnnouncement(`${activity.label} running`)
      if (before === 'Running' && now === 'Scheduled') setAnnouncement(runOutcome(activity))
    }
    previous.current = new Map(
      activities.map((activity) => [activityKey(activity), activity.status._tag])
    )
  }, [activities])

  return announcement
}

interface ActivityRowProps {
  readonly activity: ActivityInfoJson
  readonly onRun: () => void
}

function ActivityRow({ activity, onRun }: ActivityRowProps) {
  const running = activity.status._tag === 'Running'
  const lastRun = activity.status.lastRun

  return (
    <li className="flex flex-col gap-1" data-activity={activity.id}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="text-sm text-ink">{activity.label}</span>
          <span className="text-xs text-ink-muted tabular-nums">{activityLabel(activity)}</span>
        </div>
        <Button
          size="xs"
          variant="outline"
          aria-label={`Run ${activity.label} for ${activity.plugin}`}
          aria-disabled={running}
          onClick={running ? undefined : onRun}
        >
          {running ? <Loader2Icon className="motion-safe:animate-spin" /> : <PlayIcon />}
          Run now
        </Button>
      </div>
      {lastRun?._tag === 'RunFailed' ? (
        <p className="max-h-32 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-ink">
          {lastRun.message}
        </p>
      ) : null}
    </li>
  )
}

interface PluginRowProps {
  readonly plugin: PluginInfo
  readonly activities: ReadonlyArray<ActivityInfoJson>
  readonly onRunActivity: (id: string) => void
  readonly busy: boolean
  readonly rejection: OverrideRejection | undefined
  readonly onReload: () => void
  readonly onUnload: () => void
  readonly onChooseOverride: () => void
  readonly onClearOverride: () => void
}

function PluginRow({
  plugin,
  activities,
  onRunActivity,
  busy,
  rejection,
  onReload,
  onUnload,
  onChooseOverride,
  onClearOverride
}: PluginRowProps) {
  const detail = statusDetail(plugin.status)
  const loading = plugin.status._tag === 'Loading'
  const unloaded = plugin.status._tag === 'Unloaded' || loading
  const disabled = busy || loading
  const overridden = plugin.origin === 'override'
  const adapter = plugin.category === 'adapter'
  const reloadLocked = adapter && plugin.status._tag !== 'Failed'

  return (
    <li className="flex flex-col gap-1.5 px-4 py-3" data-plugin={plugin.name}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="text-sm font-medium text-ink">{plugin.name}</span>
          <span className="text-xs text-ink-muted">{statusLabel(plugin.status)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || reloadLocked}
            onClick={onReload}
          >
            {disabled ? <Loader2Icon className="motion-safe:animate-spin" /> : <RefreshCwIcon />}
            {unloaded ? 'Load' : 'Reload'}
          </Button>
          {unloaded ? null : (
            <Button size="xs" variant="ghost" disabled={disabled || adapter} onClick={onUnload}>
              Unload
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || adapter}
            onClick={onChooseOverride}
          >
            <FolderIcon />
            Set folder
          </Button>
          {overridden ? (
            <Button size="xs" variant="ghost" disabled={disabled} onClick={onClearOverride}>
              Use bundled
            </Button>
          ) : null}
        </div>
      </div>
      <p className="flex min-w-0 items-baseline gap-2 text-xs text-ink-muted">
        <span className="shrink-0">{overridden ? 'Folder' : 'Bundled'}</span>
        <span className="min-w-0 font-mono break-all" title={plugin.root}>
          {plugin.root}
        </span>
      </p>
      {adapter ? (
        <p className="text-xs text-ink-muted">
          Adapter: it loads at startup from the bundled copy. Restart dia to apply a change.
        </p>
      ) : null}
      {detail === undefined ? null : (
        <p className="max-h-32 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-ink">
          {detail}
        </p>
      )}
      {rejection === undefined ? null : (
        <p className="max-h-32 overflow-y-auto text-xs break-words text-ink">
          Not applied: <span className="font-mono whitespace-pre-wrap">{rejection.message}</span>
        </p>
      )}
      {loading ? <Skeleton className="h-3 w-40" /> : null}
      {plugin.memoryBytes > 0 ? (
        <p className="text-xs text-ink-muted tabular-nums">
          Memory {formatMegabytes(plugin.memoryBytes)} of {formatMegabytes(limitBytes)}
        </p>
      ) : null}
      {activities.length === 0 ? null : (
        <ul
          className="mt-1 flex flex-col gap-2 border-t pt-2"
          aria-label={`Background activities of ${plugin.name}`}
        >
          {activities.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              onRun={() => onRunActivity(activity.id)}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

const SKELETON_ROWS = ['first', 'second', 'third']

function PluginListSkeleton() {
  return (
    <ul className="divide-y" aria-busy="true" aria-label="Loading plugins">
      {SKELETON_ROWS.map((row) => (
        <li key={row} className="flex flex-col gap-1.5 px-4 py-3">
          <div className="flex items-baseline gap-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-3 w-64 max-w-full" />
        </li>
      ))}
    </ul>
  )
}

/**
 * The plugin list: every plugin with its state, the folder it loads from, the reason for its last
 * failed reload, and its memory use against the limit, with actions to load, reload and unload it
 * and to point it at a folder on disk or back at the bundled copy. Render it inside a scrolling
 * container; it sizes to its content.
 */
export function PluginSettings() {
  const { plugins, pending, rejection, reload, unload, chooseOverride, clearOverride } =
    usePlugins()
  const { activities, run } = useActivities()
  const announcement = useActivityAnnouncement(activities)

  return (
    <>
      {plugins === undefined ? (
        <PluginListSkeleton />
      ) : plugins.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">No plugins found.</p>
      ) : (
        <ul className="divide-y">
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.name}
              plugin={plugin}
              activities={activities?.filter((activity) => activity.plugin === plugin.name) ?? []}
              onRunActivity={(id) => run(plugin.name, id)}
              busy={pending.has(plugin.name)}
              rejection={rejection?.name === plugin.name ? rejection : undefined}
              onReload={() => void reload(plugin.name)}
              onUnload={() => void unload(plugin.name)}
              onChooseOverride={() => void chooseOverride(plugin.name)}
              onClearOverride={() => void clearOverride(plugin.name)}
            />
          ))}
        </ul>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  )
}
