import type { ListEntry } from '@dia/plugin'
import {
  Button,
  openSettings,
  PluginBoundary,
  PluginFailed,
  pluginStatusLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  Skeleton,
  useList,
  usePluginList
} from '@dia/renderer-plugin'
import { type AdapterPanel, AdapterPanelsSlot } from '@dia-plugin/adapters/slots'
import type { SettingsPageProps } from '@dia-plugin/settings/slots'
import type { PluginInfo } from '@shared/plugin/manifest'
import { useEffect } from 'react'

type Panel = ListEntry<AdapterPanel>

function AdapterRow({
  plugin,
  panel,
  selected,
  onSelect
}: {
  readonly plugin: PluginInfo
  readonly panel: Panel | undefined
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" isActive={selected} onClick={onSelect}>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-ink">
            {panel?.label ?? plugin.name}
          </span>
          <span className="truncate text-xs text-ink-muted">
            {panel === undefined ? (
              pluginStatusLabel(plugin.status)
            ) : (
              <PluginBoundary
                plugin={panel.key.plugin}
                at={AdapterPanelsSlot.name}
                resetKey={panel.statusLine}
              >
                <panel.statusLine />
              </PluginBoundary>
            )}
          </span>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * The Adapters settings page: one row per adapter plugin with its status line, and the panel of
 * the selected adapter from `AdapterPanelsSlot`. The selected adapter is `requestedSection` when
 * it is loaded, else `lastSection` when it is still loaded, else the first adapter. Add it to
 * `SettingsPagesSlot`.
 */
export function AdapterSettings({
  requestedSection,
  lastSection,
  onSectionShown
}: SettingsPageProps) {
  const { plugins } = usePluginList()
  const panels = useList(AdapterPanelsSlot)
  const adapters = plugins?.filter((plugin) => plugin.category === 'adapter')
  const names = adapters?.map((plugin) => plugin.name) ?? []
  const selected =
    [requestedSection, lastSection].find((name) => name !== undefined && names.includes(name)) ??
    names[0]
  const panelOf = (name: string | undefined) => panels.find((panel) => panel.id === name)
  const labelOf = (name: string) => panelOf(name)?.label ?? name

  useEffect(() => {
    if (plugins === undefined || selected === lastSection) return
    onSectionShown(selected === undefined ? undefined : { id: selected, label: labelOf(selected) })
  })

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
        <Button
          size="xs"
          variant="outline"
          onClick={() => openSettings({ plugin: 'settings', id: 'plugins' })}
        >
          Open Plugins
        </Button>
      </div>
    )
  }

  const panel = panelOf(selected)

  return (
    <div className="flex flex-col">
      <SidebarMenu className="border-b p-2" aria-label="Adapters">
        {adapters.map((plugin) => (
          <AdapterRow
            key={plugin.name}
            plugin={plugin}
            panel={panelOf(plugin.name)}
            selected={plugin.name === selected}
            onSelect={() => onSectionShown({ id: plugin.name, label: labelOf(plugin.name) })}
          />
        ))}
      </SidebarMenu>
      {panel === undefined ? (
        <p className="px-4 py-6 text-sm text-ink-muted">This adapter has no settings.</p>
      ) : (
        <PluginBoundary
          key={panel.id}
          plugin={panel.key.plugin}
          at={AdapterPanelsSlot.name}
          resetKey={panel.component}
          fallback={(error, retry) => (
            <PluginFailed plugin={panel.key.plugin} error={error} onRetry={retry} />
          )}
        >
          <panel.component />
        </PluginBoundary>
      )}
    </div>
  )
}
