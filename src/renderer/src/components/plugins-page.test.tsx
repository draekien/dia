// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the test holds a bridge call open with a manually resolved Promise.
import type { PluginInfo } from '@shared/plugin/manifest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginsPage } from './plugins-page'

const info = (name: string, overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  name,
  origin: 'default',
  root: `plugins/${name}`,
  status: { _tag: 'Loaded' },
  memoryBytes: 0,
  ...overrides
})

const installBridge = (initial: ReadonlyArray<PluginInfo>) => {
  let current = initial
  const bridge = {
    pickDirectory: vi.fn(async () => '/work/chat' as string | null),
    plugins: {
      list: vi.fn(async () => current),
      load: vi.fn(async (name: string) => info(name)),
      unload: vi.fn(async (name: string) => info(name, { status: { _tag: 'Unloaded' } })),
      setOverride: vi.fn(async (_name: string, _directory: string) => ({
        _tag: 'Applied' as const
      })),
      clearOverride: vi.fn(async (_name: string) => undefined)
    }
  }
  Object.assign(window, { dia: bridge })
  return {
    bridge,
    replaceList: (next: ReadonlyArray<PluginInfo>) => {
      current = next
    }
  }
}

const rowOf = (name: string) => {
  const row = document.querySelector<HTMLElement>(`[data-plugin="${name}"]`)
  if (row === null) throw new Error(`no row for ${name}`)
  return within(row)
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('PluginsPage', () => {
  beforeEach(() => {
    installBridge([])
  })

  it('shows each plugin with its status and the folder it loads from', async () => {
    installBridge([
      info('chat', { root: '/work/chat', origin: 'override' }),
      info('theme', { status: { _tag: 'Unloaded' } })
    ])

    render(<PluginsPage onClose={() => {}} />)

    await screen.findByText('chat')
    expect(rowOf('chat').getByText('Loaded')).toBeTruthy()
    expect(rowOf('chat').getByText('/work/chat')).toBeTruthy()
    expect(rowOf('chat').getByText('Folder')).toBeTruthy()
    expect(rowOf('theme').getByText('Not loaded')).toBeTruthy()
    expect(rowOf('theme').getByText('Bundled')).toBeTruthy()
  })

  it('shows the reason of the last failed reload under a plugin that kept running', async () => {
    installBridge([
      info('chat', { status: { _tag: 'Loaded', reloadError: 'Cannot import "host.ts"' } })
    ])

    render(<PluginsPage onClose={() => {}} />)

    await screen.findByText('Cannot import "host.ts"')
    expect(rowOf('chat').getByText('Loaded · last reload failed')).toBeTruthy()
  })

  it('shows why a plugin needs a restart', async () => {
    installBridge([
      info('chat', {
        status: { _tag: 'RestartRequired', reason: 'memory', message: 'over the limit' }
      })
    ])

    render(<PluginsPage onClose={() => {}} />)

    await screen.findByText('over the limit')
    expect(rowOf('chat').getByText('Restart dia to reload')).toBeTruthy()
  })

  it('shows memory use against the limit only for a plugin that has used some', async () => {
    installBridge([info('chat', { memoryBytes: 40_000_000 }), info('theme')])

    render(<PluginsPage onClose={() => {}} />)

    await screen.findByText('Memory 40.0 MB of 100.0 MB')
    expect(rowOf('theme').queryByText(/^Memory/)).toBeNull()
  })

  it('reloads a plugin and shows the list the Host returns afterwards', async () => {
    const { bridge, replaceList } = installBridge([info('chat')])
    render(<PluginsPage onClose={() => {}} />)
    await screen.findByText('chat')
    replaceList([info('chat', { memoryBytes: 12_000_000 })])

    fireEvent.click(rowOf('chat').getByRole('button', { name: 'Reload' }))

    await screen.findByText('Memory 12.0 MB of 100.0 MB')
    expect(bridge.plugins.load).toHaveBeenCalledWith('chat')
  })

  it('offers Load instead of Reload and no Unload for a plugin that is not loaded', async () => {
    installBridge([info('theme', { status: { _tag: 'Unloaded' } })])

    render(<PluginsPage onClose={() => {}} />)

    await screen.findByText('theme')
    expect(rowOf('theme').getByRole('button', { name: 'Load' })).toBeTruthy()
    expect(rowOf('theme').queryByRole('button', { name: 'Unload' })).toBeNull()
  })

  it('unloads a plugin', async () => {
    const { bridge } = installBridge([info('chat')])
    render(<PluginsPage onClose={() => {}} />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: 'Unload' }))

    await waitFor(() => expect(bridge.plugins.unload).toHaveBeenCalledWith('chat'))
  })

  it('points a plugin at the folder the user picks and reloads it', async () => {
    const { bridge } = installBridge([info('chat')])
    render(<PluginsPage onClose={() => {}} />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: /Set folder/ }))

    await waitFor(() => expect(bridge.plugins.load).toHaveBeenCalledWith('chat'))
    expect(bridge.plugins.setOverride).toHaveBeenCalledWith('chat', '/work/chat')
  })

  it('changes nothing when the user cancels the folder picker', async () => {
    const { bridge } = installBridge([info('chat')])
    bridge.pickDirectory.mockResolvedValueOnce(null)
    render(<PluginsPage onClose={() => {}} />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: /Set folder/ }))

    await waitFor(() => expect(bridge.pickDirectory).toHaveBeenCalled())
    expect(bridge.plugins.setOverride).not.toHaveBeenCalled()
    expect(bridge.plugins.load).not.toHaveBeenCalled()
  })

  it('shows why a folder was refused and does not reload the plugin', async () => {
    const { bridge } = installBridge([info('chat')])
    bridge.plugins.setOverride.mockResolvedValueOnce({
      _tag: 'Rejected',
      message: 'no plugin.json'
    } as never)
    render(<PluginsPage onClose={() => {}} />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: /Set folder/ }))

    await screen.findByText('no plugin.json')
    expect(bridge.plugins.load).not.toHaveBeenCalled()
  })

  it('shows a failed bridge call on the plugin and lets the user retry it', async () => {
    const { bridge } = installBridge([info('chat')])
    bridge.plugins.load.mockRejectedValueOnce(new Error('bridge closed'))
    render(<PluginsPage onClose={() => {}} />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: 'Reload' }))
    await screen.findByText('bridge closed')

    await waitFor(() =>
      expect(
        (rowOf('chat').getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
  })

  it('keeps the page open when Escape was already handled by an overlay', () => {
    const onClose = vi.fn()
    render(<PluginsPage onClose={onClose} />)

    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    handled.preventDefault()
    document.dispatchEvent(handled)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers to return only an overridden plugin to the bundled copy, and reloads it', async () => {
    const { bridge } = installBridge([
      info('chat', { origin: 'override', root: '/work/chat' }),
      info('theme')
    ])
    render(<PluginsPage onClose={() => {}} />)
    await screen.findByText('chat')
    expect(rowOf('theme').queryByRole('button', { name: 'Use bundled' })).toBeNull()

    fireEvent.click(rowOf('chat').getByRole('button', { name: 'Use bundled' }))

    await waitFor(() => expect(bridge.plugins.load).toHaveBeenCalledWith('chat'))
    expect(bridge.plugins.clearOverride).toHaveBeenCalledWith('chat')
  })

  it('ignores a second reload request while the first one is running', async () => {
    const { bridge } = installBridge([info('chat')])
    let finish: () => void = () => {}
    bridge.plugins.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(info('chat'))
        })
    )
    render(<PluginsPage onClose={() => {}} />)
    await screen.findByText('chat')
    const reload = rowOf('chat').getByRole('button', { name: 'Reload' })

    fireEvent.click(reload)
    fireEvent.click(reload)
    finish()

    await waitFor(() => expect(bridge.plugins.list).toHaveBeenCalledTimes(2))
    expect(bridge.plugins.load).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the user presses Escape', async () => {
    const onClose = vi.fn()
    render(<PluginsPage onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose from the back button', async () => {
    const onClose = vi.fn()
    render(<PluginsPage onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says so when there are no plugins', async () => {
    render(<PluginsPage onClose={() => {}} />)

    await screen.findByText('No plugins found.')
  })
})
