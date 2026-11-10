import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { parseWindowState } from './window-state'

const primary = { x: 0, y: 0, width: 1920, height: 1040 }
const saved = { x: 100, y: 50, width: 1400, height: 900, maximized: true }

describe('parseWindowState', () => {
  it('returns the saved state when its bounds lie on a connected display', () => {
    expect(parseWindowState(JSON.stringify(saved), [primary])).toEqual(Option.some(saved))
  })

  it('rejects bounds that sit wholly on a disconnected monitor to the right of the primary', () => {
    const onSecondMonitor = { ...saved, x: 1920 }
    expect(parseWindowState(JSON.stringify(onSecondMonitor), [primary])).toEqual(Option.none())
  })

  it('keeps bounds that are partly off-screen but still overlap a display', () => {
    const straddling = { ...saved, x: 1919 }
    expect(parseWindowState(JSON.stringify(straddling), [primary])).toEqual(Option.some(straddling))
  })

  it.each([
    ['malformed JSON', '{"x":'],
    ['a missing field', JSON.stringify({ x: 0, y: 0, width: 800, height: 600 })],
    ['a non-numeric size', JSON.stringify({ ...saved, width: 'wide' })]
  ])('rejects %s', (_case, json) => {
    expect(parseWindowState(json, [primary])).toEqual(Option.none())
  })
})
