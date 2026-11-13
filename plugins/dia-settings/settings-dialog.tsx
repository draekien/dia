import { sameEntryKey } from '@dia/plugin'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  OPEN_SETTINGS_EVENT,
  type PageKey,
  PluginBoundary,
  PluginFailed,
  type SettingsLocation,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useList
} from '@dia/renderer-plugin'
import { SettingsPagesSlot, type SettingsSection } from '@dia-plugin/dia-settings/slots'
import { Effect } from 'effect'
import { type CSSProperties, Fragment, useCallback, useEffect, useRef, useState } from 'react'

const pageId = (key: PageKey): string => `${key.plugin}/${key.id}`

type PageSections = {
  readonly requested: ReadonlyMap<string, string | undefined>
  readonly shown: ReadonlyMap<string, SettingsSection | undefined>
}

const NO_SECTIONS: PageSections = { requested: new Map(), shown: new Map() }

/**
 * The Settings dialog: a nav of the pages in `SettingsPagesSlot` beside the selected page under a
 * breadcrumb of `Settings`, the page label and the section the page reports. Add it to the dialogs
 * list; it opens when `openSettings` is called and reopens on the page and section last viewed.
 */
export function SettingsDialog() {
  const pages = useList(SettingsPagesSlot)
  const pagesRef = useRef(pages)
  useEffect(() => {
    pagesRef.current = pages
  })
  const [open, setOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState<PageKey | undefined>(undefined)
  const [sections, setSections] = useState<PageSections>(NO_SECTIONS)

  useEffect(() => {
    const onOpen = (event: Event) => {
      const location =
        (event as CustomEvent<SettingsLocation | null | undefined>).detail ?? undefined
      if (location !== undefined) {
        const known = pagesRef.current.some((page) => sameEntryKey(page.key, location))
        if (!known) {
          Effect.runFork(
            Effect.logWarning('Settings has no page at the requested location', { location })
          )
        }
        const key = { plugin: location.plugin, id: location.id }
        setSelectedKey(key)
        setSections((current) => ({
          ...current,
          requested: new Map(current.requested).set(pageId(key), location.section)
        }))
      }
      Effect.runFork(Effect.logDebug('Settings opened', { location }))
      setOpen(true)
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen)
  }, [])

  const selected =
    (selectedKey === undefined
      ? undefined
      : pages.find((page) => sameEntryKey(page.key, selectedKey))) ?? pages[0]
  const selectedId = selected === undefined ? undefined : pageId(selected.key)

  const onSectionShown = useCallback(
    (section: SettingsSection | undefined) => {
      if (selectedId === undefined) return
      setSections((current) => ({
        requested: new Map(current.requested).set(selectedId, section?.id),
        shown: new Map(current.shown).set(selectedId, section)
      }))
    },
    [selectedId]
  )

  const sectionLabel = selectedId === undefined ? undefined : sections.shown.get(selectedId)?.label
  const crumbs = [
    'Settings',
    ...(selected === undefined ? [] : [selected.label]),
    ...(sectionLabel === undefined ? [] : [sectionLabel])
  ]

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="h-[min(40rem,85vh)] overflow-hidden p-0 sm:max-w-4xl">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Change how dia looks, behaves, which plugins it runs and where it pushes the meta repo.
        </DialogDescription>
        <SidebarProvider
          className="h-full min-h-0 items-start"
          style={{ '--sidebar-width': '12rem' } as CSSProperties}
        >
          <Sidebar collapsible="none" className="h-full border-r">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu aria-label="Settings sections">
                    {pages.map((page) => (
                      <SidebarMenuItem key={pageId(page.key)}>
                        <SidebarMenuButton
                          isActive={selected !== undefined && sameEntryKey(page.key, selected.key)}
                          onClick={() => setSelectedKey(page.key)}
                        >
                          <PluginBoundary
                            plugin={page.key.plugin}
                            at={SettingsPagesSlot.name}
                            resetKey={page.icon}
                          >
                            <page.icon />
                          </PluginBoundary>
                          <span>{page.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <section aria-label="Settings page" className="flex h-full min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center border-b px-4 pr-12">
              <Breadcrumb>
                <BreadcrumbList>
                  {crumbs.map((crumb, index) => (
                    <Fragment key={crumb}>
                      {index === 0 ? null : <BreadcrumbSeparator />}
                      <BreadcrumbItem>
                        {index === crumbs.length - 1 ? (
                          <BreadcrumbPage>{crumb}</BreadcrumbPage>
                        ) : (
                          crumb
                        )}
                      </BreadcrumbItem>
                    </Fragment>
                  ))}
                </BreadcrumbList>
              </Breadcrumb>
            </header>
            <div className="relative min-h-0 flex-1 overflow-auto">
              {selected === undefined || selectedId === undefined ? null : (
                <PluginBoundary
                  key={selectedId}
                  plugin={selected.key.plugin}
                  at={SettingsPagesSlot.name}
                  resetKey={selected.component}
                  fallback={(error, retry) => (
                    <PluginFailed plugin={selected.key.plugin} error={error} onRetry={retry} />
                  )}
                >
                  <selected.component
                    requestedSection={sections.requested.get(selectedId)}
                    lastSection={sections.shown.get(selectedId)?.id}
                    onSectionShown={onSectionShown}
                  />
                </PluginBoundary>
              )}
            </div>
          </section>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
