// @vitest-environment jsdom

import { EMPTY_MODEL_PREFERENCES, type ModelPreferences } from '@shared/domain/model-preferences'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from './model-picker'

const { CLAUDE, OTHER, catalogs, world } = vi.hoisted(() => {
  const model = (value: string, displayName: string) => ({
    value,
    displayName,
    description: '',
    adaptiveThinking: true,
    effortLevels: [],
    autoMode: true,
    fastMode: false
  })
  const ready = (models: ReadonlyArray<ReturnType<typeof model>>) =>
    ({ _tag: 'Ready', models, fetchedAt: '1970-01-01T00:00:00.000Z', refreshing: false }) as const
  const claude = 'dia-claude-code'
  const other = 'other-adapter'
  return {
    CLAUDE: claude,
    OTHER: other,
    catalogs: new Map([
      [claude, ready([model('opus', 'Opus'), model('haiku', 'Haiku')])],
      [other, ready([model('alpha', 'Alpha')])]
    ]),
    world: { preferences: { adapters: {}, defaults: {} } as ModelPreferences }
  }
})

vi.mock('@dia/renderer-plugin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dia/renderer-plugin')>()
  return {
    ...original,
    useAdapters: () => [
      { id: CLAUDE, label: 'Claude Code' },
      { id: OTHER, label: 'Other Agent' }
    ],
    useModelCatalogs: (adapters: ReadonlyArray<{ id: string }>) =>
      new Map([...catalogs].filter(([id]) => adapters.some((adapter) => adapter.id === id))),
    useModelPreferences: () => world.preferences
  }
})

const open = () => fireEvent.click(screen.getByRole('combobox', { name: 'Model' }))

const groupLabelled = (label: string) =>
  screen.getByText(label).closest('[role="group"]') as HTMLElement

const optionNames = (group: HTMLElement) =>
  within(group)
    .getAllByRole('option')
    .map((option) => option.textContent)

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  world.preferences = EMPTY_MODEL_PREFERENCES
})

afterEach(cleanup)

describe('ModelPicker', () => {
  it('groups each adapter models under the adapter label', () => {
    render(<ModelPicker value={{ backend: CLAUDE, model: 'opus' }} onChange={() => {}} />)

    open()

    expect({
      claude: optionNames(groupLabelled('Claude Code')),
      other: optionNames(groupLabelled('Other Agent'))
    }).toEqual({ claude: ['Opus', 'Haiku'], other: ['Alpha'] })
  })

  it('lists favourites of an adapter first and leaves out its hidden models', () => {
    world.preferences = {
      adapters: { [CLAUDE]: { models: { haiku: 'favourite', opus: 'hidden' } } },
      defaults: {}
    }
    render(<ModelPicker value={{ backend: CLAUDE, model: 'haiku' }} onChange={() => {}} />)

    open()

    expect(optionNames(groupLabelled('Claude Code'))).toEqual(['Haiku'])
  })

  it('shows only the named adapter when `only` is set', () => {
    render(
      <ModelPicker only={OTHER} value={{ backend: OTHER, model: 'alpha' }} onChange={() => {}} />
    )

    open()

    expect(screen.queryByText('Claude Code')).toBeNull()
    expect(optionNames(groupLabelled('Other Agent'))).toEqual(['Alpha'])
  })

  it('emits the adapter and model of the chosen option', () => {
    const onChange = vi.fn()
    render(<ModelPicker value={{ backend: CLAUDE, model: 'opus' }} onChange={onChange} />)

    open()
    const alpha = within(groupLabelled('Other Agent')).getByRole('option', { name: 'Alpha' })
    fireEvent.pointerDown(alpha)
    fireEvent.pointerUp(alpha)
    fireEvent.mouseUp(alpha)
    fireEvent.click(alpha)

    expect(onChange).toHaveBeenCalledWith({ backend: OTHER, model: 'alpha' })
  })
})
