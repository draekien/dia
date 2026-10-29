import { describe, expect, it } from 'vitest'
import { transcriptEndSpace } from './transcript-scroller'

const PEEK = 64

describe('transcriptEndSpace', () => {
  it('reserves only the overlay height when no message is anchored', () => {
    expect(
      transcriptEndSpace({
        overlayHeight: 120,
        anchorTop: null,
        itemsBottom: 900,
        viewportHeight: 800
      })
    ).toBe(120)
  })

  it('makes room to scroll the anchor to the top while its reply is shorter than the viewport', () => {
    const anchorTop = 1000
    const itemsBottom = 1100
    const viewportHeight = 800
    const space = transcriptEndSpace({ overlayHeight: 120, anchorTop, itemsBottom, viewportHeight })

    const maxScrollTop = itemsBottom + space - viewportHeight
    expect(maxScrollTop).toBe(anchorTop - PEEK)
  })

  it('falls back to the overlay height once the reply fills the viewport', () => {
    expect(
      transcriptEndSpace({
        overlayHeight: 120,
        anchorTop: 1000,
        itemsBottom: 2000,
        viewportHeight: 800
      })
    ).toBe(120)
  })

  it('never reserves less than the overlay height at the boundary', () => {
    const overlayHeight = 120
    const viewportHeight = 800
    const anchorTop = 1000
    const itemsBottom = anchorTop - PEEK + viewportHeight - overlayHeight + 1
    expect(transcriptEndSpace({ overlayHeight, anchorTop, itemsBottom, viewportHeight })).toBe(
      overlayHeight
    )
  })
})
