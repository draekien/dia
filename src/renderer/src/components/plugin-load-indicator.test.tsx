// @vitest-environment jsdom
import type { PluginInfo } from '@shared/plugin/manifest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginLoadIndicator } from './plugin-load-indicator'

const info = (name: string, status: PluginInfo['status']): PluginInfo => ({
  name,
  category: 'feature',
  origin: 'default',
  root: `plugins/${name}`,
  status,
  memoryBytes: 0,
  provides: []
})

const installBridge = (initial: ReadonlyArray<PluginInfo>) => {
  let current = initial
  const listeners = new Set<(event: { readonly name: string }) => void>()
  Object.assign(window, {
    dia: {
      plugins: {
        list: vi.fn(async () => current),
        onStatusChanged: (listener: (event: { readonly name: string }) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
  return {
    settle: (next: ReadonlyArray<PluginInfo>) => {
      current = next
      for (const listener of listeners) listener({ name: 'any' })
    }
  }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('PluginLoadIndicator', () => {
  it('counts the plugins that have left Loading over all plugins', async () => {
    installBridge([
      info('alpha', { _tag: 'Loaded' }),
      info('beta', { _tag: 'Loading' }),
      info('gamma', { _tag: 'Loading' })
    ])

    render(<PluginLoadIndicator />)

    await screen.findByText('Loading plugins 1 of 3')
  })

  it('counts a plugin that failed to load as settled', async () => {
    installBridge([
      info('alpha', { _tag: 'Failed', message: 'boom' }),
      info('beta', { _tag: 'Loading' })
    ])

    render(<PluginLoadIndicator />)

    await screen.findByText('Loading plugins 1 of 2')
  })

  it('shows nothing before the first list arrives', () => {
    installBridge([info('alpha', { _tag: 'Loading' })])

    render(<PluginLoadIndicator />)

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('advances as plugins settle and disappears after the last one', async () => {
    const bridge = installBridge([
      info('alpha', { _tag: 'Loading' }),
      info('beta', { _tag: 'Loading' })
    ])
    render(<PluginLoadIndicator />)
    await screen.findByText('Loading plugins 0 of 2')

    bridge.settle([info('alpha', { _tag: 'Loaded' }), info('beta', { _tag: 'Loading' })])
    await screen.findByText('Loading plugins 1 of 2')
    bridge.settle([info('alpha', { _tag: 'Loaded' }), info('beta', { _tag: 'Loaded' })])

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })
})
