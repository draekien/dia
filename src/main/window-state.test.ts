import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { parseWindowState } from './window-state'

const primary = { x: 0, y: 0, width: 1920, height: 1040 }
const saved = { x: 100, y: 50, width: 1400, height: 900, maximized: true }
const parse = (state: object) => parseWindowState(JSON.stringify(state), [primary])

describe('parseWindowState', () => {
  it('returns the saved state when its title bar lies on a connected display', () => {
    expect(parse(saved)).toEqual(Option.some(saved))
  })

  it('rejects bounds that sit wholly on a disconnected monitor to the right of the primary', () => {
    expect(parse({ ...saved, x: 1920 })).toEqual(Option.none())
  })

  it('keeps a window whose title bar shows exactly 100px at the right edge', () => {
    const straddling = { ...saved, x: 1920 - 100 }
    expect(parse(straddling)).toEqual(Option.some(straddling))
  })

  it('rejects a window whose title bar shows only 99px at the right edge', () => {
    expect(parse({ ...saved, x: 1920 - 99 })).toEqual(Option.none())
  })

  it('rejects a window whose title bar is above the top of the display', () => {
    expect(parse({ ...saved, y: -1 })).toEqual(Option.none())
  })

  it('rejects a window whose title bar is below the bottom of the display', () => {
    expect(parse({ ...saved, y: 1040 })).toEqual(Option.none())
  })

  it('accepts a window on a second display placed left of the primary', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 }
    const onLeft = { ...saved, x: -1800 }
    expect(parseWindowState(JSON.stringify(onLeft), [primary, left])).toEqual(Option.some(onLeft))
  })

  it.each([
    ['malformed JSON', '{"x":'],
    ['a missing field', JSON.stringify({ x: 0, y: 0, width: 800, height: 600 })],
    ['a non-numeric size', JSON.stringify({ ...saved, width: 'wide' })]
  ])('rejects %s', (_case, json) => {
    expect(parseWindowState(json, [primary])).toEqual(Option.none())
  })
})
