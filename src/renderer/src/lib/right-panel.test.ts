import { describe, expect, it } from 'vitest'
import {
  fitRightPanelWidth,
  RIGHT_PANEL_MIN_WIDTH,
  type RightPanelView,
  shownPanel,
  TRANSCRIPT_MIN_WIDTH
} from './right-panel'

const panel = (plugin: string, id: string): RightPanelView => ({
  key: { plugin, id },
  id,
  order: 0,
  title: id,
  component: () => null
})

const FILES = panel('example', 'files')
const DIFF = panel('git', 'diff')

describe('shownPanel', () => {
  it('shows the panel whose key the tab selected', () => {
    expect(shownPanel([FILES, DIFF], 'git.diff')).toBe(DIFF)
  })

  it('shows the first panel when the tab selected none', () => {
    expect(shownPanel([FILES, DIFF], undefined)).toBe(FILES)
  })

  it('shows the first panel when the selected panel is gone', () => {
    expect(shownPanel([FILES], 'git.diff')).toBe(FILES)
  })
})

describe('fitRightPanelWidth', () => {
  const PANE = 1200

  it('keeps a width that leaves the transcript its minimum', () => {
    expect(fitRightPanelWidth(500, PANE)).toBe(500)
  })

  it('stops widening where the transcript would go below its minimum', () => {
    expect(fitRightPanelWidth(1000, PANE)).toBe(PANE - TRANSCRIPT_MIN_WIDTH)
  })

  it('stops narrowing at the panel minimum', () => {
    expect(fitRightPanelWidth(100, PANE)).toBe(RIGHT_PANEL_MIN_WIDTH)
  })
})
