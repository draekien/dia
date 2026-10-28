// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './command-palette'
import { openSettings } from './settings/settings-dialog'

vi.mock('./about-dialog', () => ({ AboutDialog: () => null }))
vi.mock('./settings/settings-dialog', () => ({ openSettings: vi.fn() }))

const optionNames = (): ReadonlyArray<string> =>
  screen.getAllByRole('option').map((option) => option.textContent ?? '')

const openPalette = () => {
  render(<CommandPalette />)
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  return screen.getByRole('combobox')
}

const search = (input: HTMLElement, query: string) =>
  fireEvent.change(input, { target: { value: query } })

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.mocked(openSettings).mockClear()
})

describe('CommandPalette', () => {
  it('lists only Settings, About dia and Toggle Developer Tools for an empty query', () => {
    openPalette()

    expect(optionNames()).toEqual(['Settings', 'About dia', 'Toggle Developer Tools'])
  })

  it.each([
    ['plug', 'Settings › Plugins'],
    ['theme', 'Settings › General'],
    ['models', 'Settings › Adapters › Claude Code']
  ])('offers %s as a link to %s', (query, label) => {
    search(openPalette(), query)

    expect(optionNames()).toContain(label)
  })

  it('does not list the Settings pages that do not match the query', () => {
    search(openPalette(), 'plug')

    expect(optionNames()).toEqual(['Settings › Plugins'])
  })

  it('opens the Settings dialog on the last page from the Settings command', () => {
    openPalette()

    fireEvent.click(screen.getByRole('option', { name: 'Settings' }))

    expect(openSettings).toHaveBeenCalledWith(undefined)
  })

  it('opens the Settings dialog on the page a result names', () => {
    search(openPalette(), 'models')

    fireEvent.click(screen.getByRole('option', { name: 'Settings › Adapters › Claude Code' }))

    expect(openSettings).toHaveBeenCalledWith({ page: 'adapters', adapter: 'claude-code' })
  })

  it('opens the plugins page from the Plugins result', () => {
    search(openPalette(), 'plug')

    fireEvent.click(screen.getByRole('option', { name: 'Settings › Plugins' }))

    expect(openSettings).toHaveBeenCalledWith({ page: 'plugins' })
  })

  it('clears the query when the palette closes', () => {
    const input = openPalette()
    search(input, 'plug')

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })

    expect(optionNames()).toEqual(['Settings', 'About dia', 'Toggle Developer Tools'])
  })
})
