import type { PaneId } from '@shared/domain/pane'
import { PanelRightIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import {
  fitRightPanelWidth,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  type RightPanelView,
  recordPanelsAvailable,
  resizeRightPanel,
  rightPanelKey,
  selectRightPanel,
  shownPanel,
  TRANSCRIPT_MIN_WIDTH,
  toggleRightPanel,
  usePanelsAvailable,
  useRightPanel
} from '../lib/right-panel'
import { PluginBoundary } from './plugin-boundary'
import { PluginFailed } from './plugin-failed'
import { Button } from './ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const KEY_STEP = 16

const SHORTCUT =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)
    ? '⌘ ⌥ B'
    : 'Ctrl Alt B'

const paneWidthOf = (handle: HTMLElement): number =>
  handle.parentElement?.parentElement?.clientWidth ?? 0

interface Drag {
  readonly pointerId: number
  readonly startX: number
  readonly startWidth: number
  readonly paneWidth: number
  readonly panel: HTMLElement
  width: number
}

function ResizeHandle({
  paneId,
  width
}: {
  readonly paneId: PaneId
  readonly width: number
}): React.JSX.Element {
  const drag = useRef<Drag | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const panel = event.currentTarget.parentElement
    if (event.button !== 0 || drag.current || panel === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    const startWidth = panel.getBoundingClientRect().width
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      paneWidth: paneWidthOf(event.currentTarget),
      panel,
      width: startWidth
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    active.width = fitRightPanelWidth(
      active.startWidth + active.startX - event.clientX,
      active.paneWidth
    )
    active.panel.style.width = `${active.width}px`
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    drag.current = null
    if (active.width !== width) resizeRightPanel(paneId, active.width)
  }

  const step = (event: React.KeyboardEvent<HTMLDivElement>, delta: number): void =>
    resizeRightPanel(paneId, fitRightPanelWidth(width + delta, paneWidthOf(event.currentTarget)))

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') step(event, KEY_STEP)
    else if (event.key === 'ArrowRight') step(event, -KEY_STEP)
    else if (event.key === 'Home') resizeRightPanel(paneId, RIGHT_PANEL_DEFAULT_WIDTH)
    else return
    event.preventDefault()
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA window-splitter pattern; <hr> cannot take focus or a value
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => resizeRightPanel(paneId, RIGHT_PANEL_DEFAULT_WIDTH)}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 left-0 z-10 w-3 -translate-x-1/2 touch-none cursor-col-resize outline-hidden after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 hover:after:bg-border focus-visible:after:bg-ring"
    />
  )
}

function PanelSwitcher({
  paneId,
  panels,
  shown
}: {
  readonly paneId: PaneId
  readonly panels: ReadonlyArray<RightPanelView>
  readonly shown: RightPanelView
}): React.JSX.Element {
  return (
    <Select
      value={rightPanelKey(shown)}
      onValueChange={(next) => {
        if (next !== null) selectRightPanel(paneId, next)
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Panel"
        className="-ml-2 h-7 border-transparent px-2 text-xs font-medium shadow-none"
      >
        <SelectValue>{shown.title}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {panels.map((panel) => (
            <SelectItem key={rightPanelKey(panel)} value={rightPanelKey(panel)}>
              {panel.title}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/**
 * The right panel region of the tab showing `paneId`: the panel the user chose among `panels`, in
 * the order given, with a header naming it (a switcher when there are two or more) and a drag
 * handle on its left edge. Renders nothing while the tab's panel is closed or `panels` is empty.
 * Render it as the last child of a flex row whose other child is the transcript area, and render
 * it whenever the tab's chat is shown: it tells the header toggle whether `panels` is empty.
 */
export function RightPanel({
  paneId,
  panels
}: {
  readonly paneId: PaneId
  readonly panels: ReadonlyArray<RightPanelView>
}): React.JSX.Element | null {
  const state = useRightPanel(paneId)
  const available = panels.length > 0
  useEffect(() => recordPanelsAvailable(available), [available])
  useEffect(() => () => recordPanelsAvailable(false), [])
  const shown = shownPanel(panels, state.selected)
  if (!state.open || shown === undefined) return null
  const Body = shown.component
  return (
    <aside
      aria-label={shown.title}
      style={{ width: state.width, maxWidth: `calc(100% - ${TRANSCRIPT_MIN_WIDTH}px)` }}
      className="relative flex shrink-0 flex-col border-l border-border bg-background"
    >
      <ResizeHandle paneId={paneId} width={state.width} />
      <header className="flex h-10 shrink-0 items-center border-b border-border px-3">
        {panels.length > 1 ? (
          <PanelSwitcher paneId={paneId} panels={panels} shown={shown} />
        ) : (
          <h2 className="truncate text-xs font-medium text-ink">{shown.title}</h2>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-app">
        <PluginBoundary
          plugin={shown.key.plugin}
          at="chat.panels"
          resetKey={Body}
          fallback={(error, retry) => (
            <PluginFailed plugin={shown.key.plugin} error={error} onRetry={retry} size="card" />
          )}
        >
          <Body paneId={paneId} />
        </PluginBoundary>
      </div>
    </aside>
  )
}

/**
 * The content header's right panel button for the tab showing `paneId`, pressed while that tab's
 * panel is open, with the shortcut Ctrl Alt B (⌘ ⌥ B on macOS). Renders nothing while the visible
 * tab has no panel. Render it in the header of a tab.
 */
export function RightPanelToggle({
  paneId
}: {
  readonly paneId: PaneId
}): React.JSX.Element | null {
  const available = usePanelsAvailable()
  const { open } = useRightPanel(paneId)
  useEffect(() => {
    if (!available) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.code === 'KeyB' &&
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        !event.shiftKey &&
        !event.getModifierState('AltGraph')
      ) {
        event.preventDefault()
        toggleRightPanel(paneId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [available, paneId])
  if (!available) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Right panel"
            aria-pressed={open}
            onClick={() => toggleRightPanel(paneId)}
          >
            <PanelRightIcon />
          </Button>
        }
      />
      <TooltipContent side="bottom" align="end">
        Right panel ({SHORTCUT})
      </TooltipContent>
    </Tooltip>
  )
}
