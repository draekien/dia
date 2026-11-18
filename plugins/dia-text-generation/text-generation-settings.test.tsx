// @vitest-environment jsdom
import { TooltipProvider } from '@dia/renderer-plugin'
import type { ModelOption } from '@shared/domain/model'
import type { AdapterSummaryJson, ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TextGenerationSettings } from './calls'
import { TextGenerationSettingsForm } from './text-generation-settings'

const model = (value: string, displayName: string, effortLevels: ModelOption['effortLevels']) => ({
  value,
  displayName,
  description: '',
  adaptiveThinking: true,
  effortLevels,
  autoMode: false,
  fastMode: false
})

const HAIKU = model('haiku', 'Haiku', ['low', 'medium'])
const SONNET = model('sonnet', 'Sonnet', ['medium', 'high'])
const PLAIN = model('plain', 'Plain', [])
const OTHER_FIRST = model('other-first', 'Other first', ['high', 'max'])

const adapters: ReadonlyArray<AdapterSummaryJson> = [
  { id: 'claude', label: 'Claude Code', textGeneration: true },
  { id: 'other', label: 'Other', textGeneration: true },
  { id: 'no-text', label: 'No text', textGeneration: false }
]

const catalogs: Readonly<Record<string, ReadonlyArray<ModelOption>>> = {
  claude: [HAIKU, SONNET, PLAIN],
  other: [OTHER_FIRST]
}

const snapshot = (id: string): ModelCatalogSnapshotJson => {
  const [first, ...rest] = catalogs[id] ?? [HAIKU]
  return {
    revision: 1,
    state: {
      _tag: 'Ready',
      models: [first ?? HAIKU, ...rest],
      fetchedAt: '2026-10-25T15:00:00.000Z',
      refreshing: false
    }
  }
}

const installBridge = () => {
  Object.assign(window, {
    dia: {
      adapters: {
        onChanged: vi.fn((listener: (list: ReadonlyArray<AdapterSummaryJson>) => void) => {
          listener(adapters)
          return () => undefined
        })
      },
      models: {
        get: vi.fn(async (id: string) => snapshot(id)),
        refresh: vi.fn(async () => undefined),
        onChanged: vi.fn(() => () => undefined)
      }
    }
  })
}

const renderForm = (settings: TextGenerationSettings) => {
  installBridge()
  const onChange = vi.fn()
  render(
    <TooltipProvider>
      <TextGenerationSettingsForm settings={settings} onChange={onChange} />
    </TooltipProvider>
  )
  return onChange
}

const choose = async (select: string, option: string | RegExp) => {
  fireEvent.click(await screen.findByRole('combobox', { name: select }))
  const item = await screen.findByRole('option', { name: option })
  fireEvent.pointerDown(item)
  fireEvent.pointerUp(item)
  fireEvent.mouseUp(item)
  fireEvent.click(item)
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('TextGenerationSettingsForm', () => {
  it('offers only adapters with text generation', async () => {
    renderForm({ adapter: 'claude', model: 'haiku', effort: 'low' })

    fireEvent.click(await screen.findByRole('combobox', { name: 'Adapter' }))

    expect(await screen.findByRole('option', { name: 'Other' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'No text' })).toBeNull()
  })

  it("lists the selected model's effort levels only", async () => {
    renderForm({ adapter: 'claude', model: 'sonnet', effort: 'high' })

    fireEvent.click(await screen.findByRole('combobox', { name: 'Effort' }))

    expect(await screen.findByRole('option', { name: /medium/i })).toBeTruthy()
    expect(screen.getByRole('option', { name: /high/i })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /low/i })).toBeNull()
  })

  it('disables the effort select when the model lists no effort level', async () => {
    renderForm({ adapter: 'claude', model: 'plain', effort: 'low' })

    const effort = await screen.findByRole('combobox', { name: 'Effort' })

    expect(effort.hasAttribute('disabled') || effort.getAttribute('aria-disabled') === 'true').toBe(
      true
    )
  })

  it("resets effort to the new model's first listed level when the model changes", async () => {
    const onChange = renderForm({ adapter: 'claude', model: 'haiku', effort: 'medium' })

    await choose('Model', 'Sonnet')

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenCalledWith({ adapter: 'claude', model: 'sonnet', effort: 'medium' })
  })

  it('resets effort to low when the new model lists no effort level', async () => {
    const onChange = renderForm({ adapter: 'claude', model: 'sonnet', effort: 'high' })

    await choose('Model', 'Plain')

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenCalledWith({ adapter: 'claude', model: 'plain', effort: 'low' })
  })

  it("sets the model to the new adapter's first model and effort to its first level when the adapter changes", async () => {
    const onChange = renderForm({ adapter: 'claude', model: 'haiku', effort: 'low' })

    await choose('Adapter', 'Other')

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenCalledWith({
      adapter: 'other',
      model: 'other-first',
      effort: 'high'
    })
  })

  it('sends the chosen effort with the saved adapter and model', async () => {
    const onChange = renderForm({ adapter: 'claude', model: 'haiku', effort: 'low' })

    await choose('Effort', /medium/i)

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenCalledWith({ adapter: 'claude', model: 'haiku', effort: 'medium' })
  })
})
