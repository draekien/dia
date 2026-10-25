import { MAIN, SIDEBAR, Slot } from '@dia/renderer-plugin'

function NoSidebarPlugin() {
  return (
    <aside className="flex w-56 shrink-0 p-4">
      <p className="text-xs text-ink-muted">
        No sidebar plugin is loaded. Agents stay reachable from the content area.
      </p>
    </aside>
  )
}

/**
 * The window frame below the title bar: the `sidebar` slot in a column sized to its content, and
 * the `main` slot filling the rest, divided by a hairline.
 */
export function Layout() {
  return (
    <div className="flex h-full min-h-0">
      <Slot name={SIDEBAR} empty={<NoSidebarPlugin />} />
      <main className="min-w-0 flex-1 border-l border-border">
        <Slot name={MAIN} />
      </main>
    </div>
  )
}
