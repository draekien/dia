import { sameEntryKey } from '@dia/plugin'
import {
  AccountBanner,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  MAIN,
  MAIN_HEADER,
  PluginBoundary,
  PluginFailed,
  Separator,
  SIDEBAR,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  Slot,
  useList,
  useView,
  WorkspaceProblemsBanner
} from '@dia/renderer-plugin'
import { DialogsSlot, PagesSlot } from '@dia-plugin/layout/slots'
import { Effect } from 'effect'
import { useState } from 'react'

const OPEN_KEY = 'dia.sidebar.open'
const LEGACY_RAIL_KEY = 'dia.agent-overview.rail'
const WIDTH_KEY = 'dia.sidebar.width'

const DEFAULT_WIDTH = 288
const MIN_WIDTH = 224
const MAX_WIDTH = 512

const log = (message: string, annotations?: Record<string, unknown>) =>
  Effect.runSync(Effect.logDebug(message, annotations))

function readOpen(): boolean {
  const stored = localStorage.getItem(OPEN_KEY)
  if (stored !== null) return stored === '1'
  const legacyRail = localStorage.getItem(LEGACY_RAIL_KEY)
  if (legacyRail === null) return true
  const open = legacyRail !== '1'
  localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  log('Migrated the legacy rail key to the sidebar open key', { open })
  return open
}

function readWidth(): number | undefined {
  const stored = localStorage.getItem(WIDTH_KEY)
  if (stored === null) return undefined
  const width = Number(stored)
  return Number.isFinite(width) ? width : undefined
}

function NoSidebarPlugin() {
  return (
    <aside className="flex w-56 shrink-0 p-4">
      <p className="text-xs text-ink-muted">
        No sidebar plugin is loaded. Agents stay reachable from the content area.
      </p>
    </aside>
  )
}

function PageCrumb({ label }: { readonly label: string }) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate font-medium">{label}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function useOpenPage() {
  const view = useView()
  const pages = useList(PagesSlot)
  if (view?._tag !== 'PageView') return undefined
  return pages.find((page) => sameEntryKey(page.key, view))
}

/**
 * The window frame: a shadcn sidebar layout with no title bar. The `sidebar` slot fills the left
 * column; the content column holds a draggable header row (sidebar toggle, then the `main.header`
 * slot) above the `main` slot. While a page from the pages list is open, the header row shows its
 * label before the `main.header` slot and the content area shows the page instead of the `main`
 * slot. Persists the sidebar's open state and width in `localStorage`, and draws every dialog in
 * the dialogs list.
 * Fill the `root` slot with it.
 */
export function Layout() {
  const [open, setOpen] = useState(readOpen)
  const [width, setWidth] = useState(readWidth)
  const page = useOpenPage()

  const saveOpen = (next: boolean) => {
    setOpen(next)
    localStorage.setItem(OPEN_KEY, next ? '1' : '0')
  }

  const saveWidth = (next: number | undefined) => {
    setWidth(next)
    if (next === undefined) localStorage.removeItem(WIDTH_KEY)
    else localStorage.setItem(WIDTH_KEY, String(next))
    log(next === undefined ? 'Reset the sidebar width' : 'Saved the sidebar width', { width: next })
  }

  return (
    <>
      <SidebarProvider
        className="h-full min-h-0"
        open={open}
        onOpenChange={saveOpen}
        resize={{
          width,
          defaultWidth: DEFAULT_WIDTH,
          onWidthChange: saveWidth,
          minWidth: MIN_WIDTH,
          maxWidth: MAX_WIDTH
        }}
      >
        <Slot name={SIDEBAR} empty={<NoSidebarPlugin />} />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <header className="titlebar-drag flex h-8 shrink-0 items-center gap-2 px-2 pr-(--titlebar-controls-inset)">
            <SidebarTrigger />
            <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
            {page !== undefined && <PageCrumb label={page.label} />}
            <Slot name={MAIN_HEADER} />
          </header>
          <Separator />
          <AccountBanner />
          <WorkspaceProblemsBanner />
          <div className="min-h-0 flex-1">
            {page === undefined ? (
              <Slot name={MAIN} />
            ) : (
              <PluginBoundary
                plugin={page.key.plugin}
                at={PagesSlot.name}
                resetKey={page.component}
                fallback={(error, retry) => (
                  <PluginFailed plugin={page.key.plugin} error={error} onRetry={retry} />
                )}
              >
                <page.component />
              </PluginBoundary>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Dialogs />
    </>
  )
}

function Dialogs() {
  return useList(DialogsSlot).map((dialog) => (
    <PluginBoundary
      key={`${dialog.key.plugin}/${dialog.key.id}`}
      plugin={dialog.key.plugin}
      at={DialogsSlot.name}
      resetKey={dialog.component}
    >
      <dialog.component />
    </PluginBoundary>
  ))
}
