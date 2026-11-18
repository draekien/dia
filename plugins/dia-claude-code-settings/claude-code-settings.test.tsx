// @vitest-environment jsdom
// @effect-diagnostics globalDate:off -- check ages are relative to the wall clock the page reads; no Effect runtime exists in the renderer.

import { TooltipProvider } from '@dia/renderer-plugin'
import type { ModelOption } from '@shared/domain/model'
import { EMPTY_MODEL_PREFERENCES, type ModelPreferences } from '@shared/domain/model-preferences'
import type { AdapterStatusSnapshotJson, ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeSettings } from './claude-code-settings'

const OPUS: ModelOption = {
  value: 'opus',
  displayName: 'Opus',
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  autoMode: true,
  fastMode: false
}
const HAIKU: ModelOption = {
  value: 'haiku',
  displayName: 'Haiku',
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  autoMode: true,
  fastMode: false
}

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

const onClaudeCode = (
  models: Readonly<Record<string, 'favourite' | 'hidden'>>
): ModelPreferences => ({ adapters: { 'dia-claude-code': { models } }, defaults: {} })

interface BridgeOptions {
  readonly models?: ReadonlyArray<typeof OPUS>
  readonly preferences?: ModelPreferences
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
      setInstallPath: vi.fn(async (_adapter: string, _path: string | null) => undefined),
      getPreferences: vi.fn(async () => ({
        revision: 1,
        preferences: options.preferences ?? EMPTY_MODEL_PREFERENCES
      })),
      onPreferencesChanged: vi.fn(
        (_listener: (snapshot: { revision: number; preferences: ModelPreferences }) => void) =>
          () =>
            undefined
      ),
      setModelPreference: vi.fn(
        async (_adapter: string, _model: string, _preference: string | null) =>
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

const renderPage = () =>
  render(
    <TooltipProvider>
      <ClaudeCodeSettings />
    </TooltipProvider>
  )

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

const rowsUnder = (heading: string) =>
  within(screen.getByRole('heading', { name: heading }).parentElement as HTMLElement)
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('aria-label'))

describe('ClaudeCodeSettings defaults', () => {
  it('stores the chosen default model as a selection on dia-claude-code', async () => {
    const bridge = installBridge()
    renderPage()

    fireEvent.click(await screen.findByRole('combobox', { name: 'Model' }))
    const haiku = await screen.findByRole('option', { name: 'Haiku' })
    fireEvent.pointerDown(haiku)
    fireEvent.pointerUp(haiku)
    fireEvent.mouseUp(haiku)
    fireEvent.click(haiku)

    await waitFor(() => expect(bridge.adapter.setDefaults).toHaveBeenCalled())
    expect(bridge.adapter.setDefaults).toHaveBeenCalledWith({
      selection: { backend: 'dia-claude-code', model: 'haiku' }
    })
  })
})

describe('ClaudeCodeSettings model sections', () => {
  it('lists favourites under Favourites and the rest under Other models', async () => {
    installBridge({ preferences: onClaudeCode({ haiku: 'favourite' }) })
    renderPage()

    await screen.findByRole('heading', { name: 'Favourites' })

    expect({ favourites: rowsUnder('Favourites'), others: rowsUnder('Other models') }).toEqual({
      favourites: ['Haiku'],
      others: ['Opus']
    })
  })

  it('orders favourites by when they were starred', async () => {
    installBridge({
      preferences: onClaudeCode({ haiku: 'favourite', opus: 'favourite' })
    })
    renderPage()

    await screen.findByRole('heading', { name: 'Favourites' })

    expect(rowsUnder('Favourites')).toEqual(['Haiku', 'Opus'])
  })

  it('keeps hidden models in a collapsed Hidden section', async () => {
    installBridge({ preferences: onClaudeCode({ haiku: 'hidden' }) })
    renderPage()

    const toggle = await screen.findByRole('button', { name: 'Hidden (1)' })

    expect({
      expanded: toggle.getAttribute('aria-expanded'),
      haikuRow: screen.queryByRole('listitem', { name: 'Haiku' })
    }).toEqual({ expanded: 'false', haikuRow: null })
  })

  it('shows hidden models when the Hidden section is opened', async () => {
    installBridge({ preferences: onClaudeCode({ haiku: 'hidden' }) })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Hidden (1)' }))

    expect(screen.getByRole('listitem', { name: 'Haiku' })).toBeTruthy()
  })

  it('closes the Hidden section once its last model is unhidden', async () => {
    const bridge = installBridge({ preferences: onClaudeCode({ haiku: 'hidden' }) })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Hidden (1)' }))
    const publish = bridge.adapter.onPreferencesChanged.mock.calls[0][0]

    act(() => publish({ revision: 2, preferences: EMPTY_MODEL_PREFERENCES }))
    act(() => publish({ revision: 3, preferences: onClaudeCode({ haiku: 'hidden' }) }))

    expect(screen.getByRole('button', { name: 'Hidden (1)' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
  })
})

describe('ClaudeCodeSettings models', () => {
  it('marks a model favourite from its star toggle', async () => {
    const bridge = installBridge()
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Favourite Haiku' }))

    expect(bridge.adapter.setModelPreference).toHaveBeenCalledWith(
      'dia-claude-code',
      'haiku',
      'favourite'
    )
  })

  it('clears a favourite when its pressed star is toggled', async () => {
    const bridge = installBridge({ preferences: onClaudeCode({ opus: 'favourite' }) })
    renderPage()

    const star = await screen.findByRole('button', { name: 'Favourite Opus' })
    await waitFor(() => expect(star.getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(star)

    expect(bridge.adapter.setModelPreference).toHaveBeenCalledWith('dia-claude-code', 'opus', null)
  })

  it('refuses to hide the last visible model from its toggle', async () => {
    const bridge = installBridge({ preferences: onClaudeCode({ opus: 'hidden' }) })
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
      ['dia-claude-code', 'haiku', 'favourite'],
      ['dia-claude-code', 'haiku', 'hidden']
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
      preferences: onClaudeCode({ 'claude-3-opus': 'favourite' })
    })
    renderPage()

    expect(await screen.findByText('No longer offered')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(bridge.adapter.setModelPreference).toHaveBeenCalledWith(
      'dia-claude-code',
      'claude-3-opus',
      null
    )
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

describe('ClaudeCodeSettings health', () => {
  it('stores the executable the user picks', async () => {
    const bridge = installBridge({ pickedFile: 'D:/tools/claude.exe' })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))

    await waitFor(() =>
      expect(bridge.adapter.setInstallPath).toHaveBeenCalledWith(
        'dia-claude-code',
        'D:/tools/claude.exe'
      )
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

    expect(bridge.adapter.setInstallPath).toHaveBeenCalledWith('dia-claude-code', null)
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
})
