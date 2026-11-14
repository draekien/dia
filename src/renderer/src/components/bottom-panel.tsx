import type { PaneId } from '@shared/domain/pane'
import { PanelBottomIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import {
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  BOTTOM_PANEL_MIN_HEIGHT,
  fitBottomPanelHeight,
  recordBottomPanelsAvailable,
  resizeBottomPanel,
  selectBottomPanel,
  TRANSCRIPT_MIN_HEIGHT,
  toggleBottomPanel,
  useBottomPanel,
  useBottomPanelsAvailable
} from '../lib/bottom-panel'
import { type RightPanelView, shownPanel } from '../lib/right-panel'
import { PluginBoundary } from './plugin-boundary'
import { PluginFailed } from './plugin-failed'
import { PanelSwitcher } from './right-panel'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const KEY_STEP = 16

const SHORTCUT =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)
    ? '⌘ J'
    : 'Ctrl J'

const columnHeightOf = (handle: HTMLElement): number =>
  handle.parentElement?.parentElement?.clientHeight ?? 0

interface Drag {
  readonly pointerId: number
  readonly startY: number
  readonly startHeight: number
  readonly columnHeight: number
  readonly panel: HTMLElement
  height: number
}

function ResizeHandle({
  paneId,
  height
}: {
  readonly paneId: PaneId
  readonly height: number
}): React.JSX.Element {
  const drag = useRef<Drag | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const panel = event.currentTarget.parentElement
    if (event.button !== 0 || drag.current || panel === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    const startHeight = panel.getBoundingClientRect().height
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      columnHeight: columnHeightOf(event.currentTarget),
      panel,
      height: startHeight
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    active.height = fitBottomPanelHeight(
      active.startHeight + active.startY - event.clientY,
      active.columnHeight
    )
    active.panel.style.height = `${active.height}px`
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    drag.current = null
    if (active.height !== height) resizeBottomPanel(paneId, active.height)
  }

  const step = (event: React.KeyboardEvent<HTMLDivElement>, delta: number): void =>
    resizeBottomPanel(
      paneId,
      fitBottomPanelHeight(height + delta, columnHeightOf(event.currentTarget))
    )

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowUp') step(event, KEY_STEP)
    else if (event.key === 'ArrowDown') step(event, -KEY_STEP)
    else if (event.key === 'Home') resizeBottomPanel(paneId, BOTTOM_PANEL_DEFAULT_HEIGHT)
    else return
    event.preventDefault()
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA window-splitter pattern; <hr> cannot take focus or a value
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize bottom panel"
      aria-valuenow={height}
      aria-valuemin={BOTTOM_PANEL_MIN_HEIGHT}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => resizeBottomPanel(paneId, BOTTOM_PANEL_DEFAULT_HEIGHT)}
      onKeyDown={onKeyDown}
      className="absolute inset-x-0 top-0 z-10 h-3 -translate-y-1/2 touch-none cursor-row-resize outline-hidden after:absolute after:inset-x-0 after:top-1/2 after:h-[2px] after:-translate-y-1/2 hover:after:bg-border focus-visible:after:bg-ring"
    />
  )
}

/**
 * The bottom panel region of the tab showing `paneId`: the panel the user chose among `panels`, in
 * the order given, with a header naming it (a switcher when there are two or more) and a drag
 * handle on its top edge. Renders nothing while the tab's panel is closed or `panels` is empty.
 * Render it as the last child of a flex column whose other child is the transcript and composer,
 * and render it whenever the tab's chat is shown: it tells the header toggle whether `panels` is
 * empty.
 */
export function BottomPanel({
  paneId,
  panels
}: {
  readonly paneId: PaneId
  readonly panels: ReadonlyArray<RightPanelView>
}): React.JSX.Element | null {
  const state = useBottomPanel(paneId)
  const available = panels.length > 0
  useEffect(() => recordBottomPanelsAvailable(available), [available])
  useEffect(() => () => recordBottomPanelsAvailable(false), [])
  const shown = shownPanel(panels, state.selected)
  if (!state.open || shown === undefined) return null
  const Body = shown.component
  return (
    <section
      aria-label={shown.title}
      style={{ height: state.height, maxHeight: `calc(100% - ${TRANSCRIPT_MIN_HEIGHT}px)` }}
      className="relative flex shrink-0 flex-col border-t border-border bg-background"
    >
      <ResizeHandle paneId={paneId} height={state.height} />
      <header className="flex h-10 shrink-0 items-center border-b border-border px-3">
        {panels.length > 1 ? (
          <PanelSwitcher
            panels={panels}
            shown={shown}
            onSelect={(key) => selectBottomPanel(paneId, key)}
          />
        ) : (
          <h2 className="truncate text-xs font-medium text-ink">{shown.title}</h2>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <PluginBoundary
          plugin={shown.key.plugin}
          at="chat.bottomPanels"
          resetKey={Body}
          fallback={(error, retry) => (
            <PluginFailed plugin={shown.key.plugin} error={error} onRetry={retry} size="card" />
          )}
        >
          <Body paneId={paneId} />
        </PluginBoundary>
      </div>
    </section>
  )
}

const isToggleShortcut = (event: KeyboardEvent): boolean =>
  event.code === 'KeyJ' &&
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  !event.getModifierState('AltGraph')

/**
 * The content header's bottom panel button for the tab showing `paneId`, pressed while that tab's
 * panel is open, with the shortcut Ctrl J (⌘ J on macOS). The shortcut is handled before the
 * focused element sees it, so it also works while a terminal has focus. Renders nothing while the
 * visible tab has no bottom panel. Render it in the header of a tab.
 */
export function BottomPanelToggle({
  paneId
}: {
  readonly paneId: PaneId
}): React.JSX.Element | null {
  const available = useBottomPanelsAvailable()
  const { open } = useBottomPanel(paneId)
  useEffect(() => {
    if (!available) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isToggleShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      toggleBottomPanel(paneId)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [available, paneId])
  if (!available) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Bottom panel"
            aria-pressed={open}
            onClick={() => toggleBottomPanel(paneId)}
          >
            <PanelBottomIcon />
          </Button>
        }
      />
      <TooltipContent side="bottom" align="end">
        Bottom panel ({SHORTCUT})
      </TooltipContent>
    </Tooltip>
  )
}
