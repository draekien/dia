// @vitest-environment jsdom
import type { PluginInfo, PluginStatus } from '@shared/plugin/manifest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PaneCreationForm from './pane-creation-form'

const PANE_ID = '00000000-0000-0000-0000-000000000001'
const HINT = 'Load the worktrees plugin to use worktrees'

const worktrees = (status: PluginStatus): PluginInfo => ({
  name: 'worktrees',
  category: 'feature',
  origin: 'default',
  root: 'plugins/worktrees',
  status,
  memoryBytes: 0
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
  it('disables the worktree switch and explains why when the worktrees plugin is not loaded', async () => {
    installBridge([worktrees({ _tag: 'Unloaded' })])
    render(<PaneCreationForm paneId={PANE_ID} isOnlyPane />)

    const toggle = await chooseGitRepo()

    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(HINT)).toBeTruthy()
  })

  it('enables the worktree switch without the hint once the worktrees plugin is loaded', async () => {
    installBridge([worktrees({ _tag: 'Loaded' })])
    render(<PaneCreationForm paneId={PANE_ID} isOnlyPane />)

    const toggle = await chooseGitRepo()

    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText(HINT)).toBeNull()
  })

  it('creates the pane with a worktree when the user turns the switch on', async () => {
    const bridge = installBridge([worktrees({ _tag: 'Loaded' })])
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
