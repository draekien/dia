import { Effect } from 'effect'
import { BlocksIcon, PuzzleIcon, SlidersHorizontalIcon } from 'lucide-react'
import {
  type ComponentType,
  type CSSProperties,
  Fragment,
  useCallback,
  useEffect,
  useState
} from 'react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '../ui/breadcrumb'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from '../ui/sidebar'
import { AdapterSettings, adapterLabel } from './adapter-settings'
import { GeneralSettings } from './general-settings'
import { PluginSettings } from './plugin-settings'

const OPEN_EVENT = 'dia:open-settings'

/** A page of the Settings dialog; `adapter` names an adapter plugin (`PluginInfo.name`). */
export type SettingsLocation =
  | { readonly page: 'general' }
  | { readonly page: 'adapters'; readonly adapter?: string }
  | { readonly page: 'plugins' }

const GENERAL: SettingsLocation = { page: 'general' }

/**
 * Opens the Settings dialog on `location`, or on the page last viewed when omitted. Call it from
 * anywhere in the renderer; a mounted {@link SettingsDialog} responds.
 */
export function openSettings(location?: SettingsLocation): void {
  Effect.runSync(Effect.logDebug('Opening Settings', { location }))
  window.dispatchEvent(
    new CustomEvent<SettingsLocation | undefined>(OPEN_EVENT, { detail: location })
  )
}

interface NavItem {
  readonly page: SettingsLocation['page']
  readonly label: string
  readonly icon: ComponentType
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { page: 'general', label: 'General', icon: SlidersHorizontalIcon },
  { page: 'adapters', label: 'Adapters', icon: BlocksIcon },
  { page: 'plugins', label: 'Plugins', icon: PuzzleIcon }
]

const pageLabel = (page: SettingsLocation['page']): string =>
  NAV_ITEMS.find((item) => item.page === page)?.label ?? page

/**
 * The Settings dialog: a nav of General, Adapters and Plugins beside the selected page under a
 * breadcrumb. Mount it once near the app root, inside a `TooltipProvider` and the theme provider;
 * it opens when {@link openSettings} is called and reopens on the page and adapter last viewed.
 */
export function SettingsDialog() {
  const [open, setOpen] = useState(false)
  const [location, setLocation] = useState<SettingsLocation>(GENERAL)
  const [lastAdapter, setLastAdapter] = useState<string | undefined>(undefined)

  useEffect(() => {
    const onOpen = (event: Event) => {
      const requested = (event as CustomEvent<SettingsLocation | null>).detail
      if (requested !== null) setLocation(requested)
      setOpen(true)
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  const showPlugins = useCallback(() => setLocation({ page: 'plugins' }), [])
  const selectAdapter = useCallback((adapter: string) => {
    setLastAdapter(adapter)
    setLocation({ page: 'adapters', adapter })
  }, [])

  const crumbs = [
    'Settings',
    pageLabel(location.page),
    ...(location.page === 'adapters' && lastAdapter !== undefined
      ? [adapterLabel(lastAdapter)]
      : [])
  ]

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="h-[min(40rem,85vh)] overflow-hidden p-0 sm:max-w-4xl">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Change how dia looks, behaves and which plugins it runs.
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
                    {NAV_ITEMS.map((item) => (
                      <SidebarMenuItem key={item.page}>
                        <SidebarMenuButton
                          isActive={location.page === item.page}
                          onClick={() =>
                            setLocation(
                              item.page === 'adapters'
                                ? { page: 'adapters', adapter: lastAdapter }
                                : ({ page: item.page } as SettingsLocation)
                            )
                          }
                        >
                          <item.icon />
                          <span>{item.label}</span>
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
            <div className="min-h-0 flex-1 overflow-auto">
              {location.page === 'general' ? <GeneralSettings /> : null}
              {location.page === 'adapters' ? (
                <AdapterSettings
                  requested={location.adapter}
                  lastViewed={lastAdapter}
                  onView={setLastAdapter}
                  onSelect={selectAdapter}
                  onOpenPlugins={showPlugins}
                />
              ) : null}
              {location.page === 'plugins' ? <PluginSettings /> : null}
            </div>
          </section>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
