import { describe, expect, it } from 'vitest'
import {
  BOTTOM_PANEL_MIN_HEIGHT,
  fitBottomPanelHeight,
  TRANSCRIPT_MIN_HEIGHT
} from './bottom-panel'

describe('fitBottomPanelHeight', () => {
  const COLUMN = 900

  it('keeps a height that leaves the transcript its minimum', () => {
    expect(fitBottomPanelHeight(400, COLUMN)).toBe(400)
  })

  it('stops growing where the transcript would go below its minimum', () => {
    expect(fitBottomPanelHeight(800, COLUMN)).toBe(COLUMN - TRANSCRIPT_MIN_HEIGHT)
  })

  it('stops shrinking at the panel minimum', () => {
    expect(fitBottomPanelHeight(50, COLUMN)).toBe(BOTTOM_PANEL_MIN_HEIGHT)
  })
})
