// @vitest-environment jsdom
import {
  type AdapterPreferences,
  EMPTY_ADAPTER_PREFERENCES
} from '@shared/domain/model-preferences'
import { type Project, ProjectId } from '@shared/domain/project'
import {
  type AdapterStatusSnapshotJson,
  type ModelCatalogSnapshotJson,
  PaneCreateFailed
} from '@shared/ipc/contract'
import { WORKTREES_KEY } from '@shared/plugin/api'
import type { PluginInfo } from '@shared/plugin/manifest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PaneCreationForm from './pane-creation-form'
import { TooltipProvider } from './ui/tooltip'

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

const DEFAULT_MODEL = { value: 'default', displayName: 'Default (recommended)', description: '' }
const HAIKU = { value: 'haiku', displayName: 'Haiku', description: '' }
const SONNET = { value: 'sonnet', displayName: 'Sonnet', description: '' }

const ready = (
  revision: number,
  models: ReadonlyArray<typeof DEFAULT_MODEL>,
  extra: { readonly refreshing?: boolean; readonly lastRefreshError?: string } = {}
): ModelCatalogSnapshotJson => ({
  revision,
  state: {
    _tag: 'Ready',
    models: [models[0], ...models.slice(1)],
    fetchedAt: '2026-10-25T15:00:00.000Z',
    refreshing: extra.refreshing ?? false,
    ...(extra.lastRefreshError === undefined ? {} : { lastRefreshError: extra.lastRefreshError })
  }
})

const READY = ready(1, [DEFAULT_MODEL, HAIKU])

const READY_STATUS: AdapterStatusSnapshotJson['status'] = {
  health: {
    _tag: 'HealthReady',
    version: '2.1.0',
    installPath: 'C:/Users/me/.local/bin/claude.exe',
    checkedAt: '2026-10-25T15:00:00.000Z'
  },
  checking: false,
  installPathOverride: null
}

const installBridge = (
  plugins: ReadonlyArray<PluginInfo>,
  snapshot: ModelCatalogSnapshotJson = READY,
  preferences: AdapterPreferences = EMPTY_ADAPTER_PREFERENCES,
  status: AdapterStatusSnapshotJson['status'] = READY_STATUS
) => {
  const modelListeners = new Set<(snapshot: ModelCatalogSnapshotJson) => void>()
  const bridge = {
    models: {
      get: vi.fn(async () => snapshot),
      refresh: vi.fn(async () => undefined),
      onChanged: vi.fn((listener: (snapshot: ModelCatalogSnapshotJson) => void) => {
        modelListeners.add(listener)
        return () => modelListeners.delete(listener)
      })
    },
    adapter: {
      getStatus: vi.fn(async () => ({ revision: 1, status })),
      onStatusChanged: vi.fn(() => () => undefined),
      getPreferences: vi.fn(async () => ({ revision: 1, preferences })),
      onPreferencesChanged: vi.fn(() => () => undefined)
    },
    createTab: vi.fn((_request: { readonly paneId: string }) => undefined),
    selectTab: vi.fn(),
    onPaneCreateFailed: vi.fn((_listener: (event: PaneCreateFailed) => void) => () => undefined),
    plugins: {
      list: vi.fn(async () => plugins),
      onStatusChanged: vi.fn(() => () => undefined)
    }
  }
  Object.assign(window, { dia: bridge })
  return Object.assign(bridge, {
    emitModels: (next: ModelCatalogSnapshotJson) => {
      for (const listener of modelListeners) listener(next)
    }
  })
}

const renderForm = (formProject: Project) =>
  render(
    <TooltipProvider>
      <PaneCreationForm project={formProject} />
    </TooltipProvider>
  )

const startButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Start agent' })

const start = async () => {
  await waitFor(() => expect(startButton().disabled).toBe(false))
  fireEvent.click(startButton())
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('PaneCreationForm', () => {
  it('offers no worktree option for a project that is not a git repo', async () => {
    installBridge([plugin('worktrees', [WORKTREES_KEY])])
    renderForm(project(false))

    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('creates the tab in the form project with the trimmed name', async () => {
    const bridge = installBridge([])
    renderForm(project(false))

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  heron  ' } })
    await start()

    expect(bridge.createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project(false).projectId,
        name: 'heron',
        useWorktree: false
      })
    )
  })

  it('sends no name when the name field is blank, so the Host generates one', async () => {
    const bridge = installBridge([])
    renderForm(project(false))

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '   ' } })
    await start()

    expect(bridge.createTab).toHaveBeenCalledWith(expect.objectContaining({ name: null }))
  })

  it('shows the reason the Host gave when creating the tab failed', async () => {
    const bridge = installBridge([])
    renderForm(project(false))
    await start()
    const paneId = bridge.createTab.mock.calls[0][0].paneId
    const listener = bridge.onPaneCreateFailed.mock.calls[0][0]

    listener(PaneCreateFailed.make({ paneId, reason: 'The directory is gone' }))

    await waitFor(() => expect(screen.getByText('The directory is gone')).toBeTruthy())
  })
})

describe('PaneCreationForm model choice', () => {
  it('creates the tab with the first model the agent reported', async () => {
    const bridge = installBridge([])
    renderForm(project(false))

    await start()

    expect(bridge.createTab).toHaveBeenCalledWith(expect.objectContaining({ model: 'default' }))
  })

  it('keeps Start agent disabled while the model list is loading', async () => {
    const bridge = installBridge([], { revision: 0, state: { _tag: 'Loading' } })
    renderForm(project(false))
    await waitFor(() => expect(bridge.models.get).toHaveBeenCalled())

    expect(startButton().disabled).toBe(true)
  })

  it('shows why no model list could be read and keeps Start agent disabled', async () => {
    installBridge([], {
      revision: 1,
      state: { _tag: 'Unavailable', message: 'spawn claude ENOENT', refreshing: false }
    })
    renderForm(project(false))

    expect(await screen.findByText("Couldn't load models")).toBeTruthy()
    expect(screen.getByText('spawn claude ENOENT')).toBeTruthy()
    expect(startButton().disabled).toBe(true)
  })

  it('asks the agent to read the model list again from Retry', async () => {
    const bridge = installBridge([], {
      revision: 1,
      state: { _tag: 'Unavailable', message: 'spawn claude ENOENT', refreshing: false }
    })
    renderForm(project(false))

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    expect(bridge.models.refresh).toHaveBeenCalledTimes(1)
  })

  it('ignores Refresh models while a refresh is running', async () => {
    const bridge = installBridge([], ready(1, [DEFAULT_MODEL], { refreshing: true }))
    renderForm(project(false))

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh models' }))

    expect(bridge.models.refresh).not.toHaveBeenCalled()
  })

  it('keeps a newer list that arrived before the reply to the first read', async () => {
    const bridge = installBridge([], ready(1, [DEFAULT_MODEL]))
    bridge.models.onChanged.mockImplementation((listener) => {
      listener(ready(2, [SONNET]))
      return () => true
    })
    renderForm(project(false))
    await waitFor(() => expect(bridge.models.get).toHaveBeenCalled())

    await start()

    expect(bridge.createTab).toHaveBeenCalledWith(expect.objectContaining({ model: 'sonnet' }))
  })

  it('keeps a chosen model a refresh removed, marks it no longer offered and disables Start', async () => {
    const bridge = installBridge([])
    renderForm(project(false))
    await waitFor(() => expect(startButton().disabled).toBe(false))

    act(() => bridge.emitModels(ready(2, [HAIKU, SONNET])))

    expect(await screen.findByText('No longer offered · choose another model')).toBeTruthy()
    expect(startButton().disabled).toBe(true)
  })

  it('starts with the default model set for new agents', async () => {
    const bridge = installBridge([], READY, { models: {}, defaults: { model: 'haiku' } })
    renderForm(project(false))

    await start()

    expect(bridge.createTab).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }))
  })

  it('starts with the first visible model when the first listed one is hidden', async () => {
    const bridge = installBridge([], READY, { models: { default: 'hidden' }, defaults: {} })
    renderForm(project(false))

    await start()

    expect(bridge.createTab).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }))
  })

  it('starts with the thinking level and permission mode set for new agents', async () => {
    const bridge = installBridge([], READY, {
      models: {},
      defaults: { thinkingLevel: 'high', permissionMode: 'acceptEdits' }
    })
    renderForm(project(false))
    await waitFor(() => expect(bridge.adapter.getPreferences).toHaveBeenCalled())

    await start()

    expect(bridge.createTab).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: 'high', permissionMode: 'acceptEdits' })
    )
  })

  it('says when the latest refresh failed and keeps the older list usable', async () => {
    installBridge([], ready(1, [DEFAULT_MODEL], { lastRefreshError: 'not signed in' }))
    renderForm(project(false))

    expect(await screen.findByText(/^Couldn't refresh · list from /)).toBeTruthy()
    await waitFor(() => expect(startButton().disabled).toBe(false))
  })
})

describe('PaneCreationForm install notice', () => {
  it('says Claude Code is not installed and keeps Start agent disabled', async () => {
    installBridge([], READY, EMPTY_ADAPTER_PREFERENCES, {
      health: { _tag: 'HealthNotInstalled', checkedAt: '2026-10-25T15:00:00.000Z' },
      checking: false,
      installPathOverride: null
    })
    renderForm(project(false))

    expect(await screen.findByText('Claude Code is not installed.')).toBeTruthy()
    expect(startButton().disabled).toBe(true)
  })

  it('tells the user to sign in when Claude Code is not signed in', async () => {
    installBridge([], READY, EMPTY_ADAPTER_PREFERENCES, {
      health: {
        _tag: 'HealthNotSignedIn',
        version: '2.1.0',
        installPath: 'C:/Users/me/.local/bin/claude.exe',
        checkedAt: '2026-10-25T15:00:00.000Z'
      },
      checking: false,
      installPathOverride: null
    })
    renderForm(project(false))

    expect(
      await screen.findByText(
        'Claude Code is not signed in. Run `claude auth login` and try again.'
      )
    ).toBeTruthy()
  })
})

describe('PaneCreationForm worktree option', () => {
  it('disables the worktree switch and explains why when no plugin provides worktrees', async () => {
    installBridge([plugin('worktrees', []), plugin('example', ['example'])])
    renderForm(project(true))

    const toggle = await screen.findByRole('switch')

    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(HINT)).toBeTruthy()
  })

  it('enables the worktree switch without the hint once the worktrees plugin provides worktrees', async () => {
    installBridge([plugin('worktrees', [WORKTREES_KEY])])
    renderForm(project(true))

    const toggle = await screen.findByRole('switch')

    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText(HINT)).toBeNull()
  })

  it('enables the worktree switch when a plugin with another name provides worktrees', async () => {
    installBridge([plugin('worktrees', []), plugin('my-worktrees', [WORKTREES_KEY])])
    renderForm(project(true))

    const toggle = await screen.findByRole('switch')

    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
  })

  it('creates the tab with a worktree when the user turns the switch on', async () => {
    const bridge = installBridge([plugin('worktrees', [WORKTREES_KEY])])
    renderForm(project(true))
    const toggle = await screen.findByRole('switch')
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(toggle)
    await start()

    expect(bridge.createTab).toHaveBeenCalledWith(expect.objectContaining({ useWorktree: true }))
  })
})
