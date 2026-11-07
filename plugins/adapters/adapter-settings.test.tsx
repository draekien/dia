// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the test holds the plugin list open with a Promise that never resolves.
import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, openSettings, SidebarProvider, TooltipProvider } from '@dia/renderer-plugin'
import { AdapterPanelsSlot } from '@dia-plugin/adapters/slots'
import type { SettingsSection } from '@dia-plugin/settings/slots'
import type { PluginInfo } from '@shared/plugin/manifest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import { AdapterSettings } from './adapter-settings'
import adapters from './renderer'

vi.mock('@dia/renderer-plugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dia/renderer-plugin')>()),
  openSettings: vi.fn()
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

const claudeCodePanel: PluginSetup<PluginServices> = (ctx) =>
  addEntry(ctx, AdapterPanelsSlot, {
    id: 'claude-code',
    order: 10,
    label: 'Claude Code',
    component: () => <div>Health, Defaults and Models</div>,
    statusLine: () => <span>Ready</span>
  })

const installBridge = (list: Promise<ReadonlyArray<PluginInfo>>) => {
  const bridge = {
    plugins: {
      list: vi.fn(() => list),
      onStatusChanged: vi.fn((_listener: () => void) => () => undefined)
    }
  }
  Object.assign(window, { dia: bridge })
  return bridge
}

const reported: { section: SettingsSection | undefined } = { section: undefined }

function SettingsDialogStandIn({ requested }: { readonly requested: string | undefined }) {
  const [requestedSection, setRequested] = useState(requested)
  const [shown, setShown] = useState<SettingsSection | undefined>(undefined)
  return (
    <AdapterSettings
      requestedSection={requestedSection}
      lastSection={shown?.id}
      onSectionShown={(section) => {
        reported.section = section
        setShown(section)
        setRequested(section?.id)
      }}
    />
  )
}

const renderPage = async (
  list: Promise<ReadonlyArray<PluginInfo>>,
  requested: string | undefined
) => {
  const bridge = installBridge(list)
  await act(() => startRendererRegistry({ adapters, 'claude-code-settings': claudeCodePanel }))
  const view = render(
    <TooltipProvider>
      <SidebarProvider>
        <SettingsDialogStandIn requested={requested} />
      </SidebarProvider>
    </TooltipProvider>
  )
  return { bridge, view }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
  reported.section = undefined
  vi.mocked(openSettings).mockClear()
})

describe('AdapterSettings', () => {
  it('lists each adapter with its status line and shows the requested adapter panel', async () => {
    await renderPage(
      Promise.resolve([CLAUDE_CODE, OTHER_ADAPTER, info('chat', { category: 'feature' })]),
      'claude-code'
    )

    const rows = await screen.findAllByRole('button', { name: /Claude Code|other-adapter/ })
    expect([
      rows.map((row) => row.textContent),
      screen.getByText('Health, Defaults and Models').textContent
    ]).toEqual([['Claude CodeReady', 'other-adapterFailed to load'], 'Health, Defaults and Models'])
  })

  it('reports the adapter it shows with its panel label', async () => {
    await renderPage(Promise.resolve([CLAUDE_CODE]), 'claude-code')
    await screen.findByText('Health, Defaults and Models')

    expect(reported.section).toEqual({ id: 'claude-code', label: 'Claude Code' })
  })

  it('selects the first adapter when none is requested', async () => {
    await renderPage(Promise.resolve([OTHER_ADAPTER, CLAUDE_CODE]), undefined)

    expect(await screen.findByText('This adapter has no settings.')).toBeTruthy()
  })

  it('shows a clicked adapter, and says when an adapter has no settings', async () => {
    await renderPage(Promise.resolve([CLAUDE_CODE, OTHER_ADAPTER]), 'claude-code')

    fireEvent.click(await screen.findByRole('button', { name: /other-adapter/ }))

    expect([
      screen.getByText('This adapter has no settings.').textContent,
      screen.queryByText('Health, Defaults and Models')
    ]).toEqual(['This adapter has no settings.', null])
  })

  it('falls back to the adapter last shown when the requested one is not loaded', async () => {
    installBridge(Promise.resolve([CLAUDE_CODE, OTHER_ADAPTER]))
    await act(() => startRendererRegistry({ adapters, 'claude-code-settings': claudeCodePanel }))

    render(
      <TooltipProvider>
        <SidebarProvider>
          <AdapterSettings
            requestedSection="missing"
            lastSection="other-adapter"
            onSectionShown={() => {}}
          />
        </SidebarProvider>
      </TooltipProvider>
    )

    expect(await screen.findByText('This adapter has no settings.')).toBeTruthy()
  })

  it('reports no section once the adapter it showed is no longer loaded', async () => {
    const { bridge } = await renderPage(Promise.resolve([CLAUDE_CODE]), 'claude-code')
    await screen.findByText('Health, Defaults and Models')
    const notifyStatusChanged = bridge.plugins.onStatusChanged.mock.calls[0]?.[0]

    bridge.plugins.list.mockImplementation(() => Promise.resolve([]))
    await act(async () => notifyStatusChanged?.())

    expect([
      (await screen.findByText('No adapter plugin is installed')).textContent,
      reported.section
    ]).toEqual(['No adapter plugin is installed', undefined])
  })

  it('shows a loading placeholder and reports nothing while the plugin list loads', async () => {
    await renderPage(new Promise(() => {}), 'claude-code')

    expect([
      screen.getByLabelText('Loading adapters').getAttribute('aria-busy'),
      reported.section
    ]).toEqual(['true', undefined])
  })

  it('says no adapter plugin is installed and opens the Plugins page', async () => {
    await renderPage(Promise.resolve([info('chat', { category: 'feature' })]), undefined)

    fireEvent.click(await screen.findByRole('button', { name: 'Open Plugins' }))

    expect(openSettings).toHaveBeenCalledWith({ plugin: 'settings', id: 'plugins' })
  })
})
