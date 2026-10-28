// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the test holds a bridge call open with a manually resolved Promise.
import type { ActivityInfoJson } from '@shared/ipc/contract'
import type { PluginInfo } from '@shared/plugin/manifest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginSettings } from './plugin-settings'

const info = (name: string, overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  name,
  category: 'feature',
  origin: 'default',
  root: `plugins/${name}`,
  status: { _tag: 'Loaded' },
  memoryBytes: 0,
  provides: [],
  ...overrides
})

const DUE_AT = '2026-10-26T14:00:00.000Z'

const modelList = (status: ActivityInfoJson['status']): ActivityInfoJson => ({
  plugin: 'claude-code',
  id: 'models',
  label: 'Model list',
  status
})

const installBridge = (
  initial: ReadonlyArray<PluginInfo>,
  initialActivities: ReadonlyArray<ActivityInfoJson> = []
) => {
  let current = initial
  let currentActivities = initialActivities
  const listeners = new Set<(event: { readonly name: string }) => void>()
  const activityListeners = new Set<() => void>()
  const bridge = {
    activities: {
      list: vi.fn(async () => currentActivities),
      run: vi.fn(async (_plugin: string, _id: string) => null),
      onChanged: vi.fn((listener: () => void) => {
        activityListeners.add(listener)
        return () => activityListeners.delete(listener)
      })
    },
    pickDirectory: vi.fn(async () => '/work/chat' as string | null),
    plugins: {
      onStatusChanged: vi.fn((listener: (event: { readonly name: string }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
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
    },
    emitStatusChanged: (name: string) => {
      for (const listener of listeners) listener({ name })
    },
    changeActivities: (next: ReadonlyArray<ActivityInfoJson>) => {
      currentActivities = next
      for (const listener of activityListeners) listener()
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

describe('PluginSettings', () => {
  beforeEach(() => {
    installBridge([])
  })

  it('shows each plugin with its status and the folder it loads from', async () => {
    installBridge([
      info('chat', { root: '/work/chat', origin: 'override' }),
      info('theme', { status: { _tag: 'Unloaded' } })
    ])

    render(<PluginSettings />)

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

    render(<PluginSettings />)

    await screen.findByText('Cannot import "host.ts"')
    expect(rowOf('chat').getByText('Loaded · last reload failed')).toBeTruthy()
  })

  it('shows why a plugin needs a restart', async () => {
    installBridge([
      info('chat', {
        status: { _tag: 'RestartRequired', reason: 'memory', message: 'over the limit' }
      })
    ])

    render(<PluginSettings />)

    await screen.findByText('over the limit')
    expect(rowOf('chat').getByText('Restart dia to reload')).toBeTruthy()
  })

  it('shows memory use against the limit only for a plugin that has used some', async () => {
    installBridge([info('chat', { memoryBytes: 40_000_000 }), info('theme')])

    render(<PluginSettings />)

    await screen.findByText('Memory 40.0 MB of 100.0 MB')
    expect(rowOf('theme').queryByText(/^Memory/)).toBeNull()
  })

  it('reloads a plugin and shows the list the Host returns afterwards', async () => {
    const { bridge, replaceList } = installBridge([info('chat')])
    render(<PluginSettings />)
    await screen.findByText('chat')
    replaceList([info('chat', { memoryBytes: 12_000_000 })])

    fireEvent.click(rowOf('chat').getByRole('button', { name: 'Reload' }))

    await screen.findByText('Memory 12.0 MB of 100.0 MB')
    expect(bridge.plugins.load).toHaveBeenCalledWith('chat')
  })

  it('offers Load instead of Reload and no Unload for a plugin that is not loaded', async () => {
    installBridge([info('theme', { status: { _tag: 'Unloaded' } })])

    render(<PluginSettings />)

    await screen.findByText('theme')
    expect(rowOf('theme').getByRole('button', { name: 'Load' })).toBeTruthy()
    expect(rowOf('theme').queryByRole('button', { name: 'Unload' })).toBeNull()
  })

  it('unloads a plugin', async () => {
    const { bridge } = installBridge([info('chat')])
    render(<PluginSettings />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: 'Unload' }))

    await waitFor(() => expect(bridge.plugins.unload).toHaveBeenCalledWith('chat'))
  })

  it('points a plugin at the folder the user picks and reloads it', async () => {
    const { bridge } = installBridge([info('chat')])
    render(<PluginSettings />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: /Set folder/ }))

    await waitFor(() => expect(bridge.plugins.load).toHaveBeenCalledWith('chat'))
    expect(bridge.plugins.setOverride).toHaveBeenCalledWith('chat', '/work/chat')
  })

  it('changes nothing when the user cancels the folder picker', async () => {
    const { bridge } = installBridge([info('chat')])
    bridge.pickDirectory.mockResolvedValueOnce(null)
    render(<PluginSettings />)
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
    render(<PluginSettings />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: /Set folder/ }))

    await screen.findByText('no plugin.json')
    expect(bridge.plugins.load).not.toHaveBeenCalled()
  })

  it('shows a failed bridge call on the plugin and lets the user retry it', async () => {
    const { bridge } = installBridge([info('chat')])
    bridge.plugins.load.mockRejectedValueOnce(new Error('bridge closed'))
    render(<PluginSettings />)
    await screen.findByText('chat')

    fireEvent.click(rowOf('chat').getByRole('button', { name: 'Reload' }))
    await screen.findByText('bridge closed')

    await waitFor(() =>
      expect(
        (rowOf('chat').getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
  })

  it('offers to return only an overridden plugin to the bundled copy, and reloads it', async () => {
    const { bridge } = installBridge([
      info('chat', { origin: 'override', root: '/work/chat' }),
      info('theme')
    ])
    render(<PluginSettings />)
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
    render(<PluginSettings />)
    await screen.findByText('chat')
    const reload = rowOf('chat').getByRole('button', { name: 'Reload' })

    fireEvent.click(reload)
    fireEvent.click(reload)
    finish()

    await waitFor(() => expect(bridge.plugins.list).toHaveBeenCalledTimes(2))
    expect(bridge.plugins.load).toHaveBeenCalledTimes(1)
  })

  it('says so when there are no plugins', async () => {
    render(<PluginSettings />)

    await screen.findByText('No plugins found.')
  })

  it('shows placeholder rows until the first list arrives, then the real rows', async () => {
    const { bridge } = installBridge([])
    let deliver: (plugins: ReadonlyArray<PluginInfo>) => void = () => {}
    bridge.plugins.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        })
    )

    render(<PluginSettings />)

    expect(screen.getByLabelText('Loading plugins')).toBeTruthy()
    expect(screen.queryByText('No plugins found.')).toBeNull()
    deliver([info('chat')])
    await screen.findByText('chat')
    expect(screen.queryByLabelText('Loading plugins')).toBeNull()
  })

  it('keeps a loaded adapter from being reloaded, unloaded or pointed at a folder', async () => {
    installBridge([info('claude-code', { category: 'adapter' })])

    render(<PluginSettings />)

    await screen.findByText('claude-code')
    const row = rowOf('claude-code')
    const disabledOf = (name: string) =>
      (row.getByRole('button', { name }) as HTMLButtonElement).disabled
    expect(disabledOf('Reload')).toBe(true)
    expect(disabledOf('Unload')).toBe(true)
    expect(disabledOf('Set folder…')).toBe(true)
    expect(
      row.getByText(
        'Adapter: it loads at startup from the bundled copy. Restart dia to apply a change.'
      )
    ).toBeTruthy()
  })

  it('lets the user load an adapter again after its load failed', async () => {
    installBridge([
      info('claude-code', { category: 'adapter', status: { _tag: 'Failed', message: 'boom' } })
    ])

    render(<PluginSettings />)

    await screen.findByText('claude-code')
    expect(
      (rowOf('claude-code').getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('shows a plugin the Host is still loading as Loading with its actions disabled', async () => {
    installBridge([info('chat', { status: { _tag: 'Loading' } })])

    render(<PluginSettings />)

    await screen.findByText('chat')
    expect(rowOf('chat').getByText('Loading…')).toBeTruthy()
    expect(
      (rowOf('chat').getByRole('button', { name: 'Load' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(rowOf('chat').queryByRole('button', { name: 'Unload' })).toBeNull()
  })

  it('updates a row when the Host reports that the plugin changed state', async () => {
    const { replaceList, emitStatusChanged } = installBridge([
      info('chat', { status: { _tag: 'Loading' } })
    ])
    render(<PluginSettings />)
    await screen.findByText('Loading…')

    replaceList([info('chat', { status: { _tag: 'Loaded' } })])
    emitStatusChanged('chat')

    await waitFor(() => expect(rowOf('chat').getByText('Loaded')).toBeTruthy())
    expect(rowOf('chat').queryByText('Loading…')).toBeNull()
  })

  it('keeps the newest list when an older list response arrives last', async () => {
    const { bridge, emitStatusChanged } = installBridge([])
    const deliveries: Array<(plugins: ReadonlyArray<PluginInfo>) => void> = []
    const pendingList = () =>
      new Promise<ReadonlyArray<PluginInfo>>((resolve) => {
        deliveries.push(resolve)
      })
    bridge.plugins.list.mockImplementationOnce(pendingList).mockImplementationOnce(pendingList)
    render(<PluginSettings />)
    emitStatusChanged('chat')
    await waitFor(() => expect(deliveries).toHaveLength(2))

    deliveries[1]?.([info('chat', { status: { _tag: 'Loaded' } })])
    await screen.findByText('Loaded')
    deliveries[0]?.([info('chat', { status: { _tag: 'Loading' } })])

    await waitFor(() => expect(bridge.plugins.list).toHaveBeenCalledTimes(2))
    expect(rowOf('chat').getByText('Loaded')).toBeTruthy()
    expect(rowOf('chat').queryByText('Loading…')).toBeNull()
  })

  it('stops listening for status changes when the page closes', async () => {
    const { bridge } = installBridge([info('chat')])
    const { unmount } = render(<PluginSettings />)
    await screen.findByText('chat')
    const unsubscribe = bridge.plugins.onStatusChanged.mock.results[0]?.value as () => boolean

    unmount()

    expect(unsubscribe()).toBe(false)
  })

  it('shows a failed background activity under its plugin with the reason', async () => {
    installBridge(
      [info('claude-code')],
      [
        modelList({
          _tag: 'Scheduled',
          nextRunAt: DUE_AT,
          lastRun: { _tag: 'RunFailed', at: '2026-10-25T15:00:00.000Z', message: 'spawn ENOENT' }
        })
      ]
    )

    render(<PluginSettings />)

    await screen.findByText('Model list')
    expect(rowOf('claude-code').getByText(/^Failed .+ · retries .+$/)).toBeTruthy()
    expect(rowOf('claude-code').getByText('spawn ENOENT')).toBeTruthy()
  })

  it('runs a background activity of its plugin from Run now', async () => {
    const { bridge } = installBridge(
      [info('claude-code')],
      [modelList({ _tag: 'Scheduled', nextRunAt: DUE_AT })]
    )
    render(<PluginSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Run Model list for claude-code' }))

    expect(bridge.activities.run).toHaveBeenCalledWith('claude-code', 'models')
  })

  it('ignores Run now while the activity is running', async () => {
    const { bridge } = installBridge([info('claude-code')], [modelList({ _tag: 'Running' })])
    render(<PluginSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Run Model list for claude-code' }))

    expect(bridge.activities.run).not.toHaveBeenCalled()
  })

  it('announces that an activity failed once its run ends', async () => {
    const { changeActivities } = installBridge(
      [info('claude-code')],
      [modelList({ _tag: 'Scheduled', nextRunAt: DUE_AT })]
    )
    render(<PluginSettings />)
    await screen.findByText('Model list')

    changeActivities([modelList({ _tag: 'Running' })])
    await screen.findByText('Running…')
    changeActivities([
      modelList({
        _tag: 'Scheduled',
        nextRunAt: DUE_AT,
        lastRun: { _tag: 'RunFailed', at: '2026-10-25T15:00:00.000Z', message: 'spawn ENOENT' }
      })
    ])

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Model list failed'))
  })
})
