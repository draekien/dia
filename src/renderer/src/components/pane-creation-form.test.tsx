// @vitest-environment jsdom
import { type Project, ProjectId } from '@shared/domain/project'
import { PaneCreateFailed } from '@shared/ipc/contract'
import { WORKTREES_KEY } from '@shared/plugin/api'
import type { PluginInfo } from '@shared/plugin/manifest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PaneCreationForm from './pane-creation-form'

const HINT = 'Load the worktrees plugin to use worktrees'

const project = (isGitRepo: boolean): Project => ({
  projectId: ProjectId.make('00000000-0000-4000-8000-000000000001'),
  directory: 'F:/Dev/dia',
  directoryKey: 'f:/dev/dia',
  displayName: 'dia',
  isGitRepo
})

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
    createTab: vi.fn((_request: { readonly paneId: string }) => undefined),
    selectTab: vi.fn(),
    onPaneCreateFailed: vi.fn((_listener: (event: PaneCreateFailed) => void) => () => undefined),
    plugins: {
      list: vi.fn(async () => plugins),
      onStatusChanged: vi.fn(() => () => undefined)
    }
  }
  Object.assign(window, { dia: bridge })
  return bridge
}

const start = () => fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('PaneCreationForm', () => {
  it('offers no worktree option for a project that is not a git repo', () => {
    installBridge([plugin('worktrees', [WORKTREES_KEY])])
    render(<PaneCreationForm project={project(false)} />)

    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('creates the tab in the form project with the trimmed name', () => {
    const bridge = installBridge([])
    render(<PaneCreationForm project={project(false)} />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  heron  ' } })
    start()

    expect(bridge.createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project(false).projectId,
        name: 'heron',
        useWorktree: false
      })
    )
  })

  it('sends no name when the name field is blank, so the Host generates one', () => {
    const bridge = installBridge([])
    render(<PaneCreationForm project={project(false)} />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '   ' } })
    start()

    expect(bridge.createTab).toHaveBeenCalledWith(expect.objectContaining({ name: null }))
  })

  it('shows the reason the Host gave when creating the tab failed', () => {
    const bridge = installBridge([])
    render(<PaneCreationForm project={project(false)} />)
    start()
    const paneId = bridge.createTab.mock.calls[0][0].paneId
    const listener = bridge.onPaneCreateFailed.mock.calls[0][0]

    listener(PaneCreateFailed.make({ paneId, reason: 'The directory is gone' }))

    return waitFor(() => expect(screen.getByText('The directory is gone')).toBeTruthy())
  })
})

describe('PaneCreationForm worktree option', () => {
  it('disables the worktree switch and explains why when no plugin provides worktrees', async () => {
    installBridge([plugin('worktrees', []), plugin('example', ['example'])])
    render(<PaneCreationForm project={project(true)} />)

    const toggle = await screen.findByRole('switch')

    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(HINT)).toBeTruthy()
  })

  it('enables the worktree switch without the hint once the worktrees plugin provides worktrees', async () => {
    installBridge([plugin('worktrees', [WORKTREES_KEY])])
    render(<PaneCreationForm project={project(true)} />)

    const toggle = await screen.findByRole('switch')

    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText(HINT)).toBeNull()
  })

  it('enables the worktree switch when a plugin with another name provides worktrees', async () => {
    installBridge([plugin('worktrees', []), plugin('my-worktrees', [WORKTREES_KEY])])
    render(<PaneCreationForm project={project(true)} />)

    const toggle = await screen.findByRole('switch')

    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
  })

  it('creates the tab with a worktree when the user turns the switch on', async () => {
    const bridge = installBridge([plugin('worktrees', [WORKTREES_KEY])])
    render(<PaneCreationForm project={project(true)} />)
    const toggle = await screen.findByRole('switch')
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(toggle)
    start()

    expect(bridge.createTab).toHaveBeenCalledWith(expect.objectContaining({ useWorktree: true }))
  })
})
