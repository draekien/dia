// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the test holds the plugin list open with a Promise that never resolves.
import type { PluginInfo } from '@shared/plugin/manifest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPluginsPage } from '../../lib/actions'
import { TooltipProvider } from '../ui/tooltip'
import { openSettings, SettingsDialog } from './settings-dialog'

const theme = vi.hoisted(() => ({ setTheme: vi.fn() }))

vi.mock('../theme-provider', () => ({
  useTheme: () => ({ theme: 'system', setTheme: theme.setTheme })
}))
vi.mock('./claude-code-settings', () => ({
  ClaudeCodeSettings: () => <div>Health, Defaults and Models</div>,
  ClaudeCodeHealthLabel: () => <span>Ready</span>
}))
vi.mock('./plugin-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plugin-settings')>()),
  PluginSettings: () => <div>Plugin list</div>
}))

const info = (name: string, overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  name,
  category: 'adapter',
  origin: 'default',
  root: `plugins/${name}`,
  status: { _tag: 'Loaded' },
  memoryBytes: 0,
  provides: [],
  ...overrides
})

const CLAUDE_CODE = info('claude-code')
const OTHER_ADAPTER = info('other-adapter', { status: { _tag: 'Failed', message: 'boom' } })

const installBridge = (list: Promise<ReadonlyArray<PluginInfo>>) => {
  const bridge = {
    plugins: { list: vi.fn(() => list), onStatusChanged: vi.fn(() => () => undefined) },
    getSendMode: vi.fn(async () => 'queue'),
    setSendMode: vi.fn(),
    getTranscriptWidth: vi.fn(async () => 'default'),
    setTranscriptWidth: vi.fn()
  }
  Object.assign(window, { dia: bridge })
  return bridge
}

const renderDialog = (plugins: ReadonlyArray<PluginInfo> = [CLAUDE_CODE]) => {
  const bridge = installBridge(Promise.resolve(plugins))
  render(
    <TooltipProvider>
      <SettingsDialog />
    </TooltipProvider>
  )
  return bridge
}

const open = (location?: Parameters<typeof openSettings>[0]) => act(() => openSettings(location))

const breadcrumb = () => screen.getByRole('navigation', { name: 'breadcrumb' })

beforeEach(() => {
  theme.setTheme.mockClear()
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('SettingsDialog navigation', () => {
  it('stays closed until openSettings is called', () => {
    renderDialog()

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists General, Adapters and Plugins and starts on General', async () => {
    renderDialog()
    await open()

    const nav = screen.getByRole('list', { name: 'Settings sections' })
    expect(
      within(nav)
        .getAllByRole('button')
        .map((item) => item.textContent)
    ).toEqual(['General', 'Adapters', 'Plugins'])
    expect(within(breadcrumb()).getByText('General').getAttribute('aria-current')).toBe('page')
  })

  it('shows the selected page and updates the breadcrumb', async () => {
    renderDialog()
    await open()

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))

    expect(screen.getByText('Plugin list')).toBeTruthy()
    expect(within(breadcrumb()).getByText('Plugins').getAttribute('aria-current')).toBe('page')
    expect(within(breadcrumb()).queryByText('General')).toBeNull()
  })

  it('reopens on the page last viewed', async () => {
    renderDialog()
    await open({ page: 'plugins' })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await open()

    expect(screen.getByText('Plugin list')).toBeTruthy()
  })

  it('opens Plugins from openPluginsPage', async () => {
    renderDialog()

    await act(() => openPluginsPage())

    expect(screen.getByText('Plugin list')).toBeTruthy()
  })
})

describe('SettingsDialog General page', () => {
  it('changes the theme', async () => {
    renderDialog()
    await open()

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))

    expect(theme.setTheme).toHaveBeenCalledWith('dark')
  })

  it('changes the send mode', async () => {
    const bridge = renderDialog()
    await open()

    fireEvent.click(screen.getByRole('radio', { name: 'Steer' }))

    expect(bridge.setSendMode).toHaveBeenCalledWith('steer')
  })

  it('changes the transcript width', async () => {
    const bridge = renderDialog()
    await open()

    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }))

    expect(bridge.setTranscriptWidth).toHaveBeenCalledWith('wide')
  })
})

describe('SettingsDialog Adapters page', () => {
  it('lists each adapter with its status line and shows the selected adapter settings', async () => {
    renderDialog([CLAUDE_CODE, OTHER_ADAPTER, info('chat', { category: 'feature' })])
    await open({ page: 'adapters', adapter: 'claude-code' })

    const rows = await screen.findAllByRole('button', { name: /Claude Code|other-adapter/ })
    expect(rows.map((row) => row.textContent)).toEqual([
      'Claude CodeReady',
      'other-adapterFailed to load'
    ])
    expect(screen.getByText('Health, Defaults and Models')).toBeTruthy()
    expect(within(breadcrumb()).getByText('Claude Code').getAttribute('aria-current')).toBe('page')
  })

  it('selects the first adapter when none is requested', async () => {
    renderDialog([OTHER_ADAPTER, CLAUDE_CODE])
    await open({ page: 'adapters' })

    expect(await screen.findByText('This adapter has no settings.')).toBeTruthy()
  })

  it('shows a clicked adapter, and says when an adapter has no settings', async () => {
    renderDialog([CLAUDE_CODE, OTHER_ADAPTER])
    await open({ page: 'adapters', adapter: 'claude-code' })

    fireEvent.click(await screen.findByRole('button', { name: /other-adapter/ }))

    expect(screen.getByText('This adapter has no settings.')).toBeTruthy()
    expect(screen.queryByText('Health, Defaults and Models')).toBeNull()
  })

  it('falls back to the adapter last viewed when the requested one is not loaded', async () => {
    renderDialog([CLAUDE_CODE, OTHER_ADAPTER])
    await open({ page: 'adapters', adapter: 'other-adapter' })
    await screen.findByText('This adapter has no settings.')

    await open({ page: 'adapters', adapter: 'missing' })

    expect(screen.getByText('This adapter has no settings.')).toBeTruthy()
  })

  it('shows a loading placeholder and selects nothing while the plugin list loads', async () => {
    installBridge(new Promise(() => {}))
    render(
      <TooltipProvider>
        <SettingsDialog />
      </TooltipProvider>
    )
    await open({ page: 'adapters', adapter: 'claude-code' })

    expect(screen.getByLabelText('Loading adapters').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('Health, Defaults and Models')).toBeNull()
  })

  it('says no adapter plugin is installed and offers the Plugins page', async () => {
    renderDialog([info('chat', { category: 'feature' })])
    await open({ page: 'adapters' })

    expect(await screen.findByText('No adapter plugin is installed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Plugins' }))

    expect(screen.getByText('Plugin list')).toBeTruthy()
  })
})
