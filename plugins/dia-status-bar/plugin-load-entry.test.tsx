// @vitest-environment jsdom

import { OPEN_SETTINGS_EVENT, type SettingsLocation, TooltipProvider } from '@dia/renderer-plugin'
import {
  PluginFailed,
  type PluginInfo,
  PluginLoaded,
  type PluginStatus
} from '@shared/plugin/manifest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginLoadEntry } from './plugin-load-entry'

const plugin = (name: string, status: PluginStatus): PluginInfo => ({
  name,
  category: 'feature',
  origin: 'default',
  root: `/plugins/${name}`,
  status,
  memoryBytes: 0,
  provides: []
})

const failed = (name: string) => plugin(name, PluginFailed.make({ message: 'boom' }))
const loaded = (name: string) => plugin(name, PluginLoaded.make({}))

const showWith = async (plugins: ReadonlyArray<PluginInfo>) => {
  vi.stubGlobal('dia', {
    plugins: {
      list: () => Promise.resolve(plugins),
      onStatusChanged: () => () => {}
    }
  })
  const view = render(
    <TooltipProvider>
      <PluginLoadEntry />
    </TooltipProvider>
  )
  await act(async () => {})
  return view
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PluginLoadEntry', () => {
  it('renders nothing while every plugin has loaded', async () => {
    const { container } = await showWith([loaded('dia-git'), loaded('dia-cost')])

    expect(container.textContent).toBe('')
  })

  it('reports one failed plugin in the singular', async () => {
    await showWith([loaded('dia-git'), failed('dia-cost')])

    expect(screen.getByRole('button', { name: '1 plugin failed to load' })).toBeTruthy()
  })

  it('counts every failed plugin in the plural', async () => {
    await showWith([failed('dia-git'), loaded('dia-tools'), failed('dia-cost')])

    expect(screen.getByRole('button', { name: '2 plugins failed to load' })).toBeTruthy()
  })

  it('does not count a loaded plugin whose last reload failed', async () => {
    const { container } = await showWith([
      plugin('dia-git', PluginLoaded.make({ reloadError: 'boom' }))
    ])

    expect(container.textContent).toBe('')
  })

  it('names the failed plugins in its tooltip', async () => {
    await showWith([failed('dia-git'), loaded('dia-tools'), failed('dia-cost')])

    fireEvent.focus(screen.getByRole('button'))

    expect(await screen.findByText('dia-git, dia-cost')).toBeTruthy()
  })

  it('opens Settings at the plugins page when clicked', async () => {
    const opened: Array<SettingsLocation | undefined> = []
    const listener = (event: Event) =>
      opened.push((event as CustomEvent<SettingsLocation | undefined>).detail)
    window.addEventListener(OPEN_SETTINGS_EVENT, listener)
    try {
      await showWith([failed('dia-cost')])

      fireEvent.click(screen.getByRole('button', { name: '1 plugin failed to load' }))
    } finally {
      window.removeEventListener(OPEN_SETTINGS_EVENT, listener)
    }

    expect(opened).toEqual([{ plugin: 'dia-settings', id: 'plugins' }])
  })
})
