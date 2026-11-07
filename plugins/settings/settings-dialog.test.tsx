// @vitest-environment jsdom
import type { PluginServices, PluginSetup } from '@dia/plugin'
import { actions, addEntry, openSettings, TooltipProvider } from '@dia/renderer-plugin'
import { type SettingsPageProps, SettingsPagesSlot } from '@dia-plugin/settings/slots'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Effect } from 'effect'
import { BlocksIcon, FolderGitIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import settings from './renderer'
import { SettingsDialog } from './settings-dialog'

const theme = vi.hoisted(() => ({ setTheme: vi.fn() }))

vi.mock('@dia/renderer-plugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dia/renderer-plugin')>()),
  useTheme: () => ({ theme: 'system', setTheme: theme.setTheme })
}))
vi.mock('./plugin-settings', () => ({ PluginSettings: () => <div>Plugin list</div> }))

function SectionedPage({ requestedSection, onSectionShown }: SettingsPageProps) {
  return (
    <div>
      <p>Adapters page showing {requestedSection ?? 'nothing'}</p>
      <button
        type="button"
        onClick={() => onSectionShown({ id: 'claude-code', label: 'Claude Code' })}
      >
        Show Claude Code
      </button>
    </div>
  )
}

const BrokenPage = (): never => {
  throw new Error('meta repo state is missing')
}

const addsPage =
  (
    id: string,
    order: number,
    label: string,
    component: ComponentType<SettingsPageProps>,
    icon = BlocksIcon
  ): PluginSetup<PluginServices> =>
  (ctx) =>
    addEntry(ctx, SettingsPagesSlot, { id, order, label, icon, component })

const MetaPage = () => <div>Meta repo page</div>

const startWithPages = (extra: Record<string, PluginSetup<PluginServices>> = {}) =>
  act(() =>
    startRendererRegistry({
      settings,
      adapters: addsPage('adapters', 20, 'Adapters', SectionedPage),
      meta: addsPage('meta', 40, 'Meta repo', MetaPage, FolderGitIcon),
      ...extra
    })
  )

const installBridge = () => {
  const bridge = {
    getSendMode: vi.fn(async () => 'queue'),
    setSendMode: vi.fn(),
    getTranscriptWidth: vi.fn(async () => 'default'),
    setTranscriptWidth: vi.fn()
  }
  Object.assign(window, { dia: bridge })
  return bridge
}

const renderDialog = async (extra?: Record<string, PluginSetup<PluginServices>>) => {
  const bridge = installBridge()
  const registry = await startWithPages(extra)
  render(
    <TooltipProvider>
      <SettingsDialog />
    </TooltipProvider>
  )
  return { bridge, registry }
}

const unload = (registry: PluginRegistry, name: string) => Effect.runPromise(registry.unload(name))

const open = (location?: Parameters<typeof openSettings>[0]) => act(() => openSettings(location))

const breadcrumb = () =>
  within(screen.getByRole('navigation', { name: 'breadcrumb' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent)

const navItems = () =>
  within(screen.getByRole('list', { name: 'Settings sections' }))
    .getAllByRole('button')
    .map((item) => item.textContent)

beforeEach(() => {
  theme.setTheme.mockClear()
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
  vi.restoreAllMocks()
})

describe('SettingsDialog navigation', () => {
  it('stays closed until openSettings is called', async () => {
    await renderDialog()

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists the pages in order and starts on the first', async () => {
    await renderDialog()
    await open()

    expect([navItems(), breadcrumb()]).toEqual([
      ['General', 'Adapters', 'Plugins', 'Meta repo'],
      ['Settings', 'General']
    ])
  })

  it('shows the selected page and updates the breadcrumb', async () => {
    await renderDialog()
    await open()

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))

    expect([screen.getByText('Plugin list').textContent, breadcrumb()]).toEqual([
      'Plugin list',
      ['Settings', 'Plugins']
    ])
  })

  it('reopens on the page last viewed', async () => {
    await renderDialog()
    await open({ plugin: 'settings', id: 'plugins' })

    fireEvent.keyDown(document, { key: 'Escape' })
    await open()

    expect(screen.getByText('Plugin list')).toBeTruthy()
  })

  it('opens Plugins from openPluginsPage', async () => {
    await renderDialog()

    await act(() => actions.openPluginsPage())

    expect(screen.getByText('Plugin list')).toBeTruthy()
  })

  it('opens the first page when the location names no page', async () => {
    await renderDialog()

    await open({ plugin: 'removed', id: 'gone' })

    expect(breadcrumb()).toEqual(['Settings', 'General'])
  })
})

describe('SettingsDialog sections', () => {
  it('passes the requested section to the page', async () => {
    await renderDialog()

    await open({ plugin: 'adapters', id: 'adapters', section: 'other-adapter' })

    expect(screen.getByText('Adapters page showing other-adapter')).toBeTruthy()
  })

  it('shows the section the page reports as the last breadcrumb', async () => {
    await renderDialog()
    await open({ plugin: 'adapters', id: 'adapters' })

    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code' }))

    expect(breadcrumb()).toEqual(['Settings', 'Adapters', 'Claude Code'])
  })

  it('does not show one page section on another page', async () => {
    await renderDialog()
    await open({ plugin: 'adapters', id: 'adapters' })
    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code' }))

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))

    expect(breadcrumb()).toEqual(['Settings', 'Plugins'])
  })
})

describe('SettingsDialog General page', () => {
  it('changes the theme', async () => {
    await renderDialog()
    await open()

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }))

    expect(theme.setTheme).toHaveBeenCalledWith('dark')
  })

  it('changes the send mode', async () => {
    const { bridge } = await renderDialog()
    await open()

    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))

    expect(bridge.setSendMode).toHaveBeenCalledWith('steer')
  })

  it('changes the transcript width', async () => {
    const { bridge } = await renderDialog()
    await open()

    fireEvent.click(screen.getByRole('button', { name: 'Wide' }))

    expect(bridge.setTranscriptWidth).toHaveBeenCalledWith('wide')
  })
})

describe('SettingsPagesSlot', () => {
  it('lists a page another plugin adds until that plugin unloads', async () => {
    const { registry } = await renderDialog({
      org: addsPage('org', 50, 'Org', MetaPage)
    })
    await open()
    const whileLoaded = navItems()

    await act(() => unload(registry, 'org'))

    expect([whileLoaded, navItems()]).toEqual([
      ['General', 'Adapters', 'Plugins', 'Meta repo', 'Org'],
      ['General', 'Adapters', 'Plugins', 'Meta repo']
    ])
  })

  it('shows that a page failed while the other pages keep working', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderDialog({ broken: addsPage('broken', 50, 'Broken', BrokenPage) })
    await open({ plugin: 'broken', id: 'broken' })
    const failed = screen.getByText('The broken plugin failed to show this').textContent

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))

    expect([failed, screen.getByText('Plugin list').textContent]).toEqual([
      'The broken plugin failed to show this',
      'Plugin list'
    ])
  })
})
