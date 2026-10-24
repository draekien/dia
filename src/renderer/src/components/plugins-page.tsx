import {
  formatMegabytes,
  PLUGIN_MEMORY_LIMIT,
  type PluginInfo,
  type PluginStatus
} from '@shared/plugin/manifest'
import { ByteSize } from 'effect'
import { ArrowLeftIcon, FolderIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { useEffect } from 'react'
import { type OverrideRejection, usePlugins } from '../hooks/use-plugins'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { Skeleton } from './ui/skeleton'

const OPEN_EVENT = 'dia:open-plugins-page'

/**
 * Asks the app shell to show the plugin management page, from anywhere in the renderer (the
 * command palette uses it). A mounted shell that listens with {@link onPluginsPageRequested}
 * responds.
 */
export function openPluginsPage(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

/**
 * Calls `listener` whenever {@link openPluginsPage} is called. Returns a function that stops
 * listening.
 */
export function onPluginsPageRequested(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener)
  return () => window.removeEventListener(OPEN_EVENT, listener)
}

const limitBytes = ByteSize.toNumberUnsafe(PLUGIN_MEMORY_LIMIT)

const statusLabel = (status: PluginStatus): string => {
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

interface PluginRowProps {
  readonly plugin: PluginInfo
  readonly busy: boolean
  readonly rejection: OverrideRejection | undefined
  readonly onReload: () => void
  readonly onUnload: () => void
  readonly onChooseOverride: () => void
  readonly onClearOverride: () => void
}

function PluginRow({
  plugin,
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
            Set folder…
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
 * The plugin management page: every plugin with its state, the folder it loads from, the reason
 * for its last failed reload, and its memory use against the limit, with actions to load, reload
 * and unload it and to point it at a folder on disk or back at the bundled copy. Pressing Escape
 * calls `onClose`. Render it in place of the pane area; it fills the space it is given.
 */
export function PluginsPage({ onClose }: { readonly onClose: () => void }) {
  const { plugins, pending, rejection, reload, unload, chooseOverride, clearOverride } =
    usePlugins()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="plugins-heading">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Button size="xs" variant="ghost" onClick={onClose}>
          <ArrowLeftIcon />
          Agents
        </Button>
        <h1 id="plugins-heading" className="text-base font-semibold tracking-tight text-ink">
          Plugins
        </h1>
      </div>
      <ScrollArea className="min-h-0 flex-1">
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
      </ScrollArea>
    </section>
  )
}
