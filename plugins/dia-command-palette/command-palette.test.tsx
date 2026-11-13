// @vitest-environment jsdom
import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, openSettings, toast } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import adapters from '../dia-adapters/renderer'
import claudeCodeSettings from '../dia-claude-code-settings/renderer'
import meta from '../dia-meta/renderer'
import settings from '../dia-settings/renderer'
import { CommandPalette } from './command-palette'
import commandPalette from './renderer'

vi.mock('@dia/renderer-plugin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dia/renderer-plugin')>()
  return {
    ...original,
    openSettings: vi.fn(),
    toast: { ...original.toast, add: vi.fn() }
  }
})

const PLUGINS: Record<string, PluginSetup<PluginServices>> = {
  'dia-command-palette': commandPalette,
  'dia-settings': settings,
  'dia-adapters': adapters,
  'dia-claude-code-settings': claudeCodeSettings,
  'dia-meta': meta
}

const optionNames = (): ReadonlyArray<string> =>
  screen.getAllByRole('option').map((option) => option.textContent ?? '')

const openPalette = async (extra: Record<string, PluginSetup<PluginServices>> = {}) => {
  const registry = await act(() => startRendererRegistry({ ...PLUGINS, ...extra }))
  render(<CommandPalette />)
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  return { input: screen.getByRole('combobox'), registry }
}

const search = (input: HTMLElement, query: string) =>
  fireEvent.change(input, { target: { value: query } })

const addsCommand =
  (label: string, run: () => void): PluginSetup<PluginServices> =>
  (ctx) =>
    addEntry(ctx, CommandsSlot, { id: 'sync', order: 50, group: 'Org', label, run })

const unload = (registry: PluginRegistry, name: string) =>
  act(() => Effect.runPromise(registry.unload(name)))

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
  vi.mocked(toast.add).mockClear()
})

describe('CommandPalette', () => {
  it('lists only Settings, About dia and Toggle Developer Tools for an empty query', async () => {
    await openPalette()

    expect(optionNames()).toEqual(['Settings', 'About dia', 'Toggle Developer Tools'])
  })

  it.each([
    ['plug', 'Settings › Plugins'],
    ['theme', 'Settings › General'],
    ['claude', 'Settings › Adapters › Claude Code'],
    ['secret', 'Settings › Meta repo']
  ])('offers %s as a link to %s', async (query, label) => {
    const { input } = await openPalette()

    search(input, query)

    expect(optionNames()).toContain(label)
  })

  it('does not list the Settings pages that do not match the query', async () => {
    const { input } = await openPalette()

    search(input, 'plug')

    expect(optionNames()).toEqual(['Settings › Plugins'])
  })

  it('opens the Settings dialog on the last page from the Settings command', async () => {
    await openPalette()

    fireEvent.click(screen.getByRole('option', { name: 'Settings' }))

    expect(openSettings).toHaveBeenCalledWith()
  })

  it('opens the Claude Code panel from its result', async () => {
    const { input } = await openPalette()
    search(input, 'claude')

    fireEvent.click(screen.getByRole('option', { name: 'Settings › Adapters › Claude Code' }))

    expect(openSettings).toHaveBeenCalledWith({
      plugin: 'dia-adapters',
      id: 'adapters',
      section: 'dia-claude-code'
    })
  })

  it('clears the query when the palette closes', async () => {
    const { input } = await openPalette()
    search(input, 'plug')

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })

    expect(optionNames()).toEqual(['Settings', 'About dia', 'Toggle Developer Tools'])
  })

  it('lists a command another plugin adds until that plugin unloads', async () => {
    const { registry } = await openPalette({ org: addsCommand('Sync the org', () => {}) })
    const whileLoaded = optionNames()

    await unload(registry, 'org')

    expect([whileLoaded, optionNames()]).toEqual([
      ['Settings', 'About dia', 'Toggle Developer Tools', 'Sync the org'],
      ['Settings', 'About dia', 'Toggle Developer Tools']
    ])
  })

  it('reports a command that throws in an error toast and keeps the palette usable', async () => {
    await openPalette({
      org: addsCommand('Sync the org', () => {
        throw new Error('no org loaded')
      })
    })

    fireEvent.click(screen.getByRole('option', { name: 'Sync the org' }))
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })

    expect([vi.mocked(toast.add).mock.calls[0]?.[0], optionNames()]).toEqual([
      {
        title: "The org plugin's command failed",
        description: 'no org loaded',
        type: 'error'
      },
      ['Settings', 'About dia', 'Toggle Developer Tools', 'Sync the org']
    ])
  })
})
