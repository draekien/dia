// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BOTTOM_PANEL_DEFAULT_HEIGHT, TRANSCRIPT_MIN_HEIGHT } from '../lib/bottom-panel'
import type { RightPanelView } from '../lib/right-panel'
import { appRegistry } from '../lib/workspace-atoms'
import { BottomPanel, BottomPanelToggle } from './bottom-panel'
import { TooltipProvider } from './ui/tooltip'

const PANE_A = 'pane-a'
const PANE_B = 'pane-b'
const KEY_STEP = 16

const panel = (plugin: string, id: string, title: string): RightPanelView => ({
  key: { plugin, id },
  id,
  order: 0,
  title,
  component: ({ paneId }) => <p>{`${title} body for ${paneId}`}</p>
})

const TERMINALS = panel('dia-terminals', 'terminals', 'Terminals')
const OUTPUT = panel('example', 'output', 'Output')

const Tab = ({
  paneId,
  panels,
  columnHeight
}: {
  readonly paneId: string
  readonly panels: ReadonlyArray<RightPanelView>
  readonly columnHeight: number
}) => (
  <RegistryContext.Provider value={appRegistry}>
    <TooltipProvider>
      <BottomPanelToggle paneId={paneId} />
      <div
        ref={(element) => {
          if (element) Object.defineProperty(element, 'clientHeight', { value: columnHeight })
        }}
      >
        <textarea aria-label="Terminal input" />
        <BottomPanel paneId={paneId} panels={panels} />
      </div>
    </TooltipProvider>
  </RegistryContext.Provider>
)

const showTab = (paneId: string, panels: ReadonlyArray<RightPanelView>, columnHeight = 900) =>
  render(<Tab paneId={paneId} panels={panels} columnHeight={columnHeight} />)

const toggle = () => screen.queryByRole('button', { name: 'Bottom panel' })
const region = (name: string) => screen.queryByRole('region', { name })
const resizeHandle = () => screen.getByRole('separator', { name: 'Resize bottom panel' })
const pressCtrlJ = (target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: 'j', code: 'KeyJ', ctrlKey: true })

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {}
  window.HTMLElement.prototype.hasPointerCapture = () => false
  window.HTMLElement.prototype.releasePointerCapture = () => {}
})
beforeEach(() => appRegistry.reset())
afterEach(() => {
  cleanup()
  appRegistry.reset()
})

describe('BottomPanelToggle', () => {
  it('is hidden while the tab has no bottom panel', () => {
    showTab(PANE_A, [])
    expect(toggle()).toBeNull()
  })

  it('opens the region on click and closes it on a second click', () => {
    showTab(PANE_A, [TERMINALS])
    expect(region('Terminals')).toBeNull()

    fireEvent.click(toggle() as HTMLElement)
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(`Terminals body for ${PANE_A}`)).toBeTruthy()

    fireEvent.click(toggle() as HTMLElement)
    expect(region('Terminals')).toBeNull()
  })

  it('opens the region on Ctrl J and closes it on the next press', () => {
    showTab(PANE_A, [TERMINALS])
    pressCtrlJ()
    expect(region('Terminals')).toBeTruthy()
    pressCtrlJ()
    expect(region('Terminals')).toBeNull()
  })

  it('takes Ctrl J before a focused terminal input receives it', () => {
    showTab(PANE_A, [TERMINALS])
    const input = screen.getByRole('textbox', { name: 'Terminal input' })
    const reachedInput: Array<string> = []
    input.addEventListener('keydown', (event) => reachedInput.push(event.code))

    pressCtrlJ(input)

    expect(region('Terminals')).toBeTruthy()
    expect(reachedInput).toEqual([])
  })

  it('does not open the region on Ctrl Shift J', () => {
    showTab(PANE_A, [TERMINALS])
    fireEvent.keyDown(window, { key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true })
    expect(region('Terminals')).toBeNull()
  })

  it('leaves Ctrl J to the focused element while the tab has no bottom panel', () => {
    showTab(PANE_A, [])
    const input = screen.getByRole('textbox', { name: 'Terminal input' })
    const reachedInput: Array<string> = []
    input.addEventListener('keydown', (event) => reachedInput.push(event.code))

    pressCtrlJ(input)

    expect(reachedInput).toEqual(['KeyJ'])
  })
})

describe('BottomPanel', () => {
  it('keeps each tab open or closed on its own', () => {
    const { unmount } = showTab(PANE_A, [TERMINALS])
    fireEvent.click(toggle() as HTMLElement)
    unmount()

    const tabB = showTab(PANE_B, [TERMINALS])
    expect(region('Terminals')).toBeNull()
    tabB.unmount()

    showTab(PANE_A, [TERMINALS])
    expect(region('Terminals')).toBeTruthy()
  })

  it('grows by one step on ArrowUp and keeps that height for its tab only', () => {
    const { unmount } = showTab(PANE_A, [TERMINALS])
    fireEvent.click(toggle() as HTMLElement)
    fireEvent.keyDown(resizeHandle(), { key: 'ArrowUp' })
    expect(resizeHandle().getAttribute('aria-valuenow')).toBe(
      String(BOTTOM_PANEL_DEFAULT_HEIGHT + KEY_STEP)
    )
    unmount()

    showTab(PANE_B, [TERMINALS])
    fireEvent.click(toggle() as HTMLElement)
    expect(resizeHandle().getAttribute('aria-valuenow')).toBe(String(BOTTOM_PANEL_DEFAULT_HEIGHT))
  })

  it('does not grow past the height that leaves the transcript its minimum', () => {
    showTab(PANE_A, [TERMINALS], BOTTOM_PANEL_DEFAULT_HEIGHT + TRANSCRIPT_MIN_HEIGHT)
    fireEvent.click(toggle() as HTMLElement)
    fireEvent.keyDown(resizeHandle(), { key: 'ArrowUp' })
    expect(resizeHandle().getAttribute('aria-valuenow')).toBe(String(BOTTOM_PANEL_DEFAULT_HEIGHT))
  })

  it('grows as the top edge is dragged up', () => {
    const drag = 100
    showTab(PANE_A, [TERMINALS])
    fireEvent.click(toggle() as HTMLElement)
    const shownRegion = region('Terminals') as HTMLElement
    shownRegion.getBoundingClientRect = () => new DOMRect(0, 0, 0, BOTTOM_PANEL_DEFAULT_HEIGHT)
    const handle = resizeHandle()
    handle.setPointerCapture = () => {}
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 600 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 600 - drag })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 600 - drag })
    expect(resizeHandle().getAttribute('aria-valuenow')).toBe(
      String(BOTTOM_PANEL_DEFAULT_HEIGHT + drag)
    )
  })

  it('names the only panel in its header without a switcher', () => {
    showTab(PANE_A, [TERMINALS])
    fireEvent.click(toggle() as HTMLElement)
    expect(screen.getByRole('heading', { name: 'Terminals' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Panel' })).toBeNull()
  })

  it('switches to the panel chosen in the switcher, drawn for the tab', async () => {
    showTab(PANE_A, [TERMINALS, OUTPUT])
    fireEvent.click(toggle() as HTMLElement)
    expect(screen.getByText(`Terminals body for ${PANE_A}`)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Panel' }))
    })
    const option = screen.getByRole('option', { name: 'Output', hidden: true })
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: 'mouse', button: 0 })
      fireEvent.mouseDown(option, { button: 0 })
      fireEvent.pointerUp(option, { pointerType: 'mouse', button: 0 })
      fireEvent.mouseUp(option, { button: 0 })
      fireEvent.click(option)
    })

    expect(screen.getByText(`Output body for ${PANE_A}`)).toBeTruthy()
  })
})
