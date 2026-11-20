import { usePrevious } from '@renderer/hooks/use-previous'
import { MAIN_TAB, Slot } from '../lib/slots'
import { TabOpenedFromNewAgent } from '../lib/tab-opened-from-new-agent'
import { useView, useWorkspace } from '../plugin-api'
import { StartupStream } from './startup-stream'
import { WindowStatus } from './window-status'

function NoChatPlugin() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-start gap-3">
        <h1 className="text-base font-semibold text-ink">No chat plugin is loaded</h1>
        <p className="text-sm text-ink-muted">
          Threads keep running. Their conversations, and new threads, show here once a chat plugin
          loads.
        </p>
      </div>
    </div>
  )
}

/**
 * The kernel's content area, shown in the `main` slot unless a plugin fills it. Renders by the
 * current view: nothing for a plugin's page (the layout plugin draws it), and the `main.tab` slot
 * for the visible tab and for the new-thread page (or a notice that no chat plugin is loaded); the
 * startup stream until the workspace loads.
 */
export function TabContent() {
  const view = useView()
  const workspace = useWorkspace()
  const previousView = usePrevious(view)
  const cameFromNewThread = previousView?._tag === 'NewThreadView'
  if (view === undefined || workspace === undefined) return <StartupStream />
  switch (view._tag) {
    case 'PageView':
      return null
    case 'TabView':
      return (
        <TabOpenedFromNewAgent.Provider value={cameFromNewThread}>
          <Slot name={MAIN_TAB} empty={<NoChatPlugin />} />
        </TabOpenedFromNewAgent.Provider>
      )
    case 'NewThreadView':
      return <Slot name={MAIN_TAB} empty={<NoChatPlugin />} />
  }
}

/**
 * Shown in place of the window body when no plugin fills the `root` slot. Keeps a drag row with
 * the window status so the window can still be moved and plugin loading stays visible.
 */
export function NoLayoutPlugin() {
  return (
    <div className="flex h-full flex-col">
      <div className="titlebar-drag flex h-8 shrink-0 items-center justify-end pr-(--titlebar-controls-inset)">
        <WindowStatus />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="max-w-sm text-sm text-ink-muted">
          No layout plugin is loaded, so Settings and the command palette are unavailable. Restart
          dia to load the layout plugin again.
        </p>
      </div>
    </div>
  )
}
