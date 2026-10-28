import { usePluginList } from '@renderer/hooks/use-plugin-list'
import type { PluginInfo } from '@shared/plugin/manifest'
import { type ComponentType, useEffect } from 'react'
import { Button } from '../ui/button'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '../ui/sidebar'
import { Skeleton } from '../ui/skeleton'
import { ClaudeCodeHealthLabel, ClaudeCodeSettings } from './claude-code-settings'
import { statusLabel } from './plugin-settings'

interface AdapterPage {
  readonly label: string
  readonly Page: ComponentType
  readonly StatusLine: ComponentType
}

/**
 * The settings page of each adapter plugin that has one, keyed by plugin name. An adapter plugin
 * missing from the map shows its plugin name and "This adapter has no settings."
 */
export const ADAPTER_PAGES: ReadonlyMap<string, AdapterPage> = new Map([
  [
    'claude-code',
    { label: 'Claude Code', Page: ClaudeCodeSettings, StatusLine: ClaudeCodeHealthLabel }
  ]
])

/** The name shown for adapter plugin `name`: its page label, or the plugin name when it has none. */
export const adapterLabel = (name: string): string => ADAPTER_PAGES.get(name)?.label ?? name

function PluginStatusLine({ plugin }: { readonly plugin: PluginInfo }) {
  return <span>{statusLabel(plugin.status)}</span>
}

function AdapterRow({
  plugin,
  selected,
  onSelect
}: {
  readonly plugin: PluginInfo
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  const page = ADAPTER_PAGES.get(plugin.name)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" isActive={selected} onClick={onSelect}>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-ink">{adapterLabel(plugin.name)}</span>
          <span className="truncate text-xs text-ink-muted">
            {page === undefined ? <PluginStatusLine plugin={plugin} /> : <page.StatusLine />}
          </span>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * The Adapters settings page: one row per adapter plugin with its status line, and the settings
 * of the selected adapter. The selected adapter is `requested` when it is loaded, else
 * `lastViewed` when it is still loaded, else the first adapter. `onView` receives the selected
 * adapter whenever it differs from `lastViewed`; `onSelect` receives the adapter a user clicks.
 * `onOpenPlugins` runs from the button shown when no adapter plugin is installed. Render it inside
 * a scrolling container.
 */
export function AdapterSettings({
  requested,
  lastViewed,
  onView,
  onSelect,
  onOpenPlugins
}: {
  readonly requested: string | undefined
  readonly lastViewed: string | undefined
  readonly onView: (adapter: string) => void
  readonly onSelect: (adapter: string) => void
  readonly onOpenPlugins: () => void
}) {
  const { plugins } = usePluginList()
  const adapters = plugins?.filter((plugin) => plugin.category === 'adapter')
  const names = adapters?.map((plugin) => plugin.name) ?? []
  const selected =
    [requested, lastViewed].find((name) => name !== undefined && names.includes(name)) ?? names[0]

  useEffect(() => {
    if (selected !== undefined && selected !== lastViewed) onView(selected)
  }, [selected, lastViewed, onView])

  if (adapters === undefined) {
    return (
      <div
        role="status"
        className="flex flex-col gap-2 px-4 py-6"
        aria-busy="true"
        aria-label="Loading adapters"
      >
        <Skeleton className="h-10 w-full max-w-xs" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
    )
  }

  if (adapters.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-6">
        <p className="text-sm text-ink-muted">No adapter plugin is installed</p>
        <Button size="xs" variant="outline" onClick={onOpenPlugins}>
          Open Plugins
        </Button>
      </div>
    )
  }

  const Page = selected === undefined ? undefined : ADAPTER_PAGES.get(selected)?.Page

  return (
    <div className="flex flex-col">
      <SidebarMenu className="border-b p-2" aria-label="Adapters">
        {adapters.map((plugin) => (
          <AdapterRow
            key={plugin.name}
            plugin={plugin}
            selected={plugin.name === selected}
            onSelect={() => onSelect(plugin.name)}
          />
        ))}
      </SidebarMenu>
      {Page === undefined ? (
        <p className="px-4 py-6 text-sm text-ink-muted">This adapter has no settings.</p>
      ) : (
        <Page />
      )}
    </div>
  )
}
