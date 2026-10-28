// @vitest-environment jsdom
// @effect-diagnostics globalDate:off -- check ages are relative to the wall clock the page reads; no Effect runtime exists in the renderer.
import {
  type AdapterPreferences,
  EMPTY_ADAPTER_PREFERENCES
} from '@shared/domain/model-preferences'
import type { AdapterStatusSnapshotJson, ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from './settings-page'
import { TooltipProvider } from './ui/tooltip'

const OPUS = { value: 'opus', displayName: 'Opus', description: '' }
const HAIKU = { value: 'haiku', displayName: 'Haiku', description: '' }

const catalog = (models: ReadonlyArray<typeof OPUS>): ModelCatalogSnapshotJson => ({
  revision: 1,
  state: {
    _tag: 'Ready',
    models: [models[0], ...models.slice(1)],
    fetchedAt: '2026-10-25T15:00:00.000Z',
    refreshing: false
  }
})

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString()

const ready = (checkedAt: string): AdapterStatusSnapshotJson['status'] => ({
  health: {
    _tag: 'HealthReady',
    version: '2.1.0',
    installPath: 'C:/Users/me/.local/bin/claude.exe',
    email: 'me@example.com',
    checkedAt
  },
  checking: false,
  installPathOverride: null
})

interface BridgeOptions {
  readonly models?: ReadonlyArray<typeof OPUS>
  readonly preferences?: AdapterPreferences
  readonly status?: AdapterStatusSnapshotJson['status']
  readonly refusal?: string
  readonly pickedFile?: string | null
}

const installBridge = (options: BridgeOptions = {}) => {
  const bridge = {
    models: {
      get: vi.fn(async () => catalog(options.models ?? [OPUS, HAIKU])),
      refresh: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined)
    },
    adapter: {
      getStatus: vi.fn(async () => ({
        revision: 1,
        status: options.status ?? ready(minutesAgo(1))
      })),
      onStatusChanged: vi.fn(() => () => undefined),
      checkHealth: vi.fn(async () => undefined),
      setInstallPath: vi.fn(async (_path: string | null) => undefined),
      getPreferences: vi.fn(async () => ({
        revision: 1,
        preferences: options.preferences ?? EMPTY_ADAPTER_PREFERENCES
      })),
      onPreferencesChanged: vi.fn(() => () => undefined),
      setModelPreference: vi.fn(async (_model: string, _preference: string | null) =>
        options.refusal === undefined
          ? null
          : { _tag: 'LastVisibleModel' as const, message: options.refusal }
      ),
      setDefaults: vi.fn(async () => undefined)
    },
    pickFile: vi.fn(async () => options.pickedFile ?? null)
  }
  Object.assign(window, { dia: bridge })
  return bridge
}

const renderPage = (onClose: () => void = () => undefined) =>
  render(
    <TooltipProvider>
      <SettingsPage onClose={onClose} />
    </TooltipProvider>
  )

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('SettingsPage models', () => {
  it('marks a model favourite from its star toggle', async () => {
    const bridge = installBridge()
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Favourite Haiku' }))

    expect(bridge.adapter.setModelPreference).toHaveBeenCalledWith('haiku', 'favourite')
  })

  it('clears a favourite when its pressed star is toggled', async () => {
    const bridge = installBridge({ preferences: { models: { opus: 'favourite' }, defaults: {} } })
    renderPage()

    const star = await screen.findByRole('button', { name: 'Favourite Opus' })
    await waitFor(() => expect(star.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(star)

    expect(bridge.adapter.setModelPreference).toHaveBeenCalledWith('opus', null)
  })

  it('refuses to hide the last visible model from its toggle', async () => {
    const bridge = installBridge({ preferences: { models: { opus: 'hidden' }, defaults: {} } })
    renderPage()

    const hide = await screen.findByRole('button', { name: 'Hide Haiku' })
    await waitFor(() => expect(hide.getAttribute('aria-disabled')).toBe('true'))
    fireEvent.click(hide)

    expect(bridge.adapter.setModelPreference).not.toHaveBeenCalled()
  })

  it('favourites the focused model on F and hides it on H', async () => {
    const bridge = installBridge()
    renderPage()
    const row = (await screen.findByRole('button', { name: 'Hide Haiku' })).closest('li')
    if (row === null) throw new Error('model row not found')

    fireEvent.keyDown(row, { key: 'f' })
    fireEvent.keyDown(row, { key: 'h' })

    expect(bridge.adapter.setModelPreference.mock.calls).toEqual([
      ['haiku', 'favourite'],
      ['haiku', 'hidden']
    ])
  })

  it('moves focus to the next model on ArrowDown', async () => {
    installBridge()
    renderPage()
    const first = (await screen.findByRole('button', { name: 'Hide Opus' })).closest('li')
    first?.focus()

    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' })

    expect(document.activeElement?.getAttribute('data-model')).toBe('haiku')
  })

  it('keeps a favourite that left the list as no longer offered, with Remove clearing it', async () => {
    const bridge = installBridge({
      preferences: { models: { 'claude-3-opus': 'favourite' }, defaults: {} }
    })
    renderPage()

    expect(await screen.findByText('No longer offered')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(bridge.adapter.setModelPreference).toHaveBeenCalledWith('claude-3-opus', null)
  })

  it('shows why the Host refused a preference change', async () => {
    installBridge({ refusal: 'Models cannot be hidden until the model list has loaded' })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Hide Haiku' }))

    expect(
      await screen.findByText('Models cannot be hidden until the model list has loaded')
    ).toBeTruthy()
  })
})

describe('SettingsPage health', () => {
  it('stores the executable the user picks', async () => {
    const bridge = installBridge({ pickedFile: 'D:/tools/claude.exe' })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Change…' }))

    await waitFor(() =>
      expect(bridge.adapter.setInstallPath).toHaveBeenCalledWith('D:/tools/claude.exe')
    )
  })

  it('says PATH was searched, not that an executable was found there, when none was found', async () => {
    installBridge({
      status: {
        health: { _tag: 'HealthNotInstalled', checkedAt: minutesAgo(1) },
        checking: false,
        installPathOverride: null
      }
    })
    renderPage()

    expect(await screen.findByText('Not found')).toBeTruthy()
    expect(screen.getByText('Searched PATH')).toBeTruthy()
    expect(screen.queryByText('Found on PATH')).toBeNull()
  })

  it('clears a chosen executable from Use PATH', async () => {
    const bridge = installBridge({
      status: { ...ready(minutesAgo(1)), installPathOverride: 'D:/tools/claude.exe' }
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Use PATH' }))

    expect(bridge.adapter.setInstallPath).toHaveBeenCalledWith(null)
  })

  it('re-checks the install on open when the last check is over five minutes old', async () => {
    const bridge = installBridge({ status: ready(minutesAgo(6)) })
    renderPage()

    await waitFor(() => expect(bridge.adapter.checkHealth).toHaveBeenCalledTimes(1))
  })

  it('does not re-check on open when the last check is recent', async () => {
    const bridge = installBridge({ status: ready(minutesAgo(4)) })
    renderPage()

    await screen.findByText('Ready')
    expect(bridge.adapter.checkHealth).not.toHaveBeenCalled()
  })

  it('does not re-check on open while the startup check has not finished', async () => {
    const bridge = installBridge({
      status: { health: { _tag: 'HealthNotChecked' }, checking: true, installPathOverride: null }
    })
    renderPage()

    await screen.findByText('Checking…')
    expect(bridge.adapter.checkHealth).not.toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    installBridge()
    const onClose = vi.fn()
    renderPage(onClose)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
