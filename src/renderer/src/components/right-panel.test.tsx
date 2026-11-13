// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  type RightPanelView,
  TRANSCRIPT_MIN_WIDTH
} from '../lib/right-panel'
import { appRegistry } from '../lib/workspace-atoms'
import { RightPanel, RightPanelToggle } from './right-panel'
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

const FILES = panel('example', 'files', 'Files')
const DIFF = panel('git', 'diff', 'Diff')

const Tab = ({
  paneId,
  panels,
  paneWidth
}: {
  readonly paneId: string
  readonly panels: ReadonlyArray<RightPanelView>
  readonly paneWidth: number
}) => (
  <RegistryContext.Provider value={appRegistry}>
    <TooltipProvider>
      <RightPanelToggle paneId={paneId} />
      <div
        ref={(element) => {
          if (element) Object.defineProperty(element, 'clientWidth', { value: paneWidth })
        }}
      >
        <p>transcript</p>
        <RightPanel paneId={paneId} panels={panels} />
      </div>
    </TooltipProvider>
  </RegistryContext.Provider>
)

const showTab = (paneId: string, panels: ReadonlyArray<RightPanelView>, paneWidth = 1200) =>
  render(<Tab paneId={paneId} panels={panels} paneWidth={paneWidth} />)

const toggle = () => screen.queryByRole('button', { name: 'Right panel' })
const region = (name: string) => screen.queryByRole('complementary', { name })
const resizeHandle = () => screen.getByRole('separator', { name: 'Resize panel' })
const pressCtrlAltB = () =>
  fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true })

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

describe('RightPanelToggle', () => {
  it('is hidden while the tab has no panel', () => {
    showTab(PANE_A, [])
    expect(toggle()).toBeNull()
  })

  it('shows unpressed with the region closed once a panel is added', () => {
    showTab(PANE_A, [FILES])
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
    expect(region('Files')).toBeNull()
  })

  it('opens the region on click and closes it on a second click', () => {
    showTab(PANE_A, [FILES])
    fireEvent.click(toggle() as HTMLElement)
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(`Files body for ${PANE_A}`)).toBeTruthy()

    fireEvent.click(toggle() as HTMLElement)

    expect(region('Files')).toBeNull()
  })

  it('opens the region on Ctrl Alt B and closes it on the next press', () => {
    showTab(PANE_A, [FILES])
    pressCtrlAltB()
    expect(region('Files')).toBeTruthy()
    pressCtrlAltB()
    expect(region('Files')).toBeNull()
  })

  it('does not open the region on Ctrl Shift B, the session rail shortcut', () => {
    showTab(PANE_A, [FILES])
    fireEvent.keyDown(window, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })
    expect(region('Files')).toBeNull()
  })

  it('hides when the last panel is removed', () => {
    const { rerender } = showTab(PANE_A, [FILES])
    rerender(<Tab paneId={PANE_A} panels={[]} paneWidth={1200} />)
    expect(toggle()).toBeNull()
  })
})

describe('RightPanel', () => {
  it('keeps each tab open or closed on its own', () => {
    const { unmount } = showTab(PANE_A, [FILES])
    fireEvent.click(toggle() as HTMLElement)
    unmount()

    const tabB = showTab(PANE_B, [FILES])
    expect(region('Files')).toBeNull()
    tabB.unmount()

    showTab(PANE_A, [FILES])
    expect(region('Files')).toBeTruthy()
  })

  it('widens by one step on ArrowLeft and keeps that width for its tab only', () => {
    const { unmount } = showTab(PANE_A, [FILES])
    fireEvent.click(toggle() as HTMLElement)
    fireEvent.keyDown(resizeHandle(), { key: 'ArrowLeft' })
    expect(resizeHandle().getAttribute('aria-valuenow')).toBe(
      String(RIGHT_PANEL_DEFAULT_WIDTH + KEY_STEP)
    )
    unmount()

    showTab(PANE_B, [FILES])
    fireEvent.click(toggle() as HTMLElement)
    expect(resizeHandle().getAttribute('aria-valuenow')).toBe(String(RIGHT_PANEL_DEFAULT_WIDTH))
  })

  it('does not widen past the width that leaves the transcript its minimum', () => {
    const paneWidth = RIGHT_PANEL_DEFAULT_WIDTH + TRANSCRIPT_MIN_WIDTH
    showTab(PANE_A, [FILES], paneWidth)
    fireEvent.click(toggle() as HTMLElement)
    fireEvent.keyDown(resizeHandle(), { key: 'ArrowLeft' })
    expect(resizeHandle().getAttribute('aria-valuenow')).toBe(String(RIGHT_PANEL_DEFAULT_WIDTH))
  })

  it('widens as the left edge is dragged left', () => {
    const drag = 120
    showTab(PANE_A, [FILES])
    fireEvent.click(toggle() as HTMLElement)
    const shownRegion = region('Files') as HTMLElement
    shownRegion.getBoundingClientRect = () => new DOMRect(0, 0, RIGHT_PANEL_DEFAULT_WIDTH, 0)
    const handle = resizeHandle()
    handle.setPointerCapture = () => {}
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 800 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 - drag })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 800 - drag })
    expect(resizeHandle().getAttribute('aria-valuenow')).toBe(
      String(RIGHT_PANEL_DEFAULT_WIDTH + drag)
    )
  })

  it('names the only panel in its header without a switcher', () => {
    showTab(PANE_A, [FILES])
    fireEvent.click(toggle() as HTMLElement)
    expect(screen.getByRole('heading', { name: 'Files' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Panel' })).toBeNull()
  })

  it('switches to the panel chosen in the switcher, drawn for the tab', async () => {
    showTab(PANE_A, [FILES, DIFF])
    fireEvent.click(toggle() as HTMLElement)
    expect(screen.getByText(`Files body for ${PANE_A}`)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Panel' }))
    })
    const option = screen.getByRole('option', { name: 'Diff', hidden: true })
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: 'mouse', button: 0 })
      fireEvent.mouseDown(option, { button: 0 })
      fireEvent.pointerUp(option, { pointerType: 'mouse', button: 0 })
      fireEvent.mouseUp(option, { button: 0 })
      fireEvent.click(option)
    })

    expect(screen.getByText(`Diff body for ${PANE_A}`)).toBeTruthy()
  })
})
