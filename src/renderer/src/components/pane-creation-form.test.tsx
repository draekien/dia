// @vitest-environment jsdom
import { WORKTREES_KEY } from '@shared/plugin/api'
import type { PluginInfo } from '@shared/plugin/manifest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PaneCreationForm from './pane-creation-form'

const PANE_ID = '00000000-0000-0000-0000-000000000001'
const HINT = 'Load the worktrees plugin to use worktrees'

const plugin = (name: string, provides: ReadonlyArray<string>): PluginInfo => ({
  name,
  category: 'feature',
  origin: 'default',
  root: `plugins/${name}`,
  status: provides.length > 0 ? { _tag: 'Loaded' } : { _tag: 'Unloaded' },
  memoryBytes: 0,
  provides
})

const installBridge = (plugins: ReadonlyArray<PluginInfo>) => {
  const bridge = {
    chooseDirectory: vi.fn(async () => ({ path: 'F:/Dev/dia', isGitRepo: true })),
    createPane: vi.fn(),
    closePane: vi.fn(),
    onPaneCreateFailed: vi.fn(() => () => undefined),
    plugins: {
      list: vi.fn(async () => plugins),
      onStatusChanged: vi.fn(() => () => undefined)
    }
  }
  Object.assign(window, { dia: bridge })
  return bridge
}

const chooseGitRepo = async () => {
  fireEvent.click(screen.getByRole('button', { name: /choose/i }))
  return screen.findByRole('switch')
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('PaneCreationForm worktree option', () => {
  it('disables the worktree switch and explains why when no plugin provides worktrees', async () => {
    installBridge([plugin('worktrees', []), plugin('example', ['example'])])
    render(<PaneCreationForm paneId={PANE_ID} isOnlyPane />)

    const toggle = await chooseGitRepo()

    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(HINT)).toBeTruthy()
  })

  it('enables the worktree switch without the hint once the worktrees plugin provides worktrees', async () => {
    installBridge([plugin('worktrees', [WORKTREES_KEY])])
    render(<PaneCreationForm paneId={PANE_ID} isOnlyPane />)

    const toggle = await chooseGitRepo()

    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText(HINT)).toBeNull()
  })

  it('enables the worktree switch when a plugin with another name provides worktrees', async () => {
    installBridge([plugin('worktrees', []), plugin('my-worktrees', [WORKTREES_KEY])])
    render(<PaneCreationForm paneId={PANE_ID} isOnlyPane />)

    const toggle = await chooseGitRepo()

    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
  })

  it('creates the pane with a worktree when the user turns the switch on', async () => {
    const bridge = installBridge([plugin('worktrees', [WORKTREES_KEY])])
    render(<PaneCreationForm paneId={PANE_ID} isOnlyPane />)
    const toggle = await chooseGitRepo()
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(bridge.createPane).toHaveBeenCalledWith(
      PANE_ID,
      'F:/Dev/dia',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      true
    )
  })
})
