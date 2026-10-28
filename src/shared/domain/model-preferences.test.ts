import { describe, expect, it } from 'vitest'
import type { ModelOption } from './model'
import {
  type AdapterPreferences,
  EMPTY_ADAPTER_PREFERENCES,
  keepsAModelVisible,
  type ModelPreference,
  pickerModels,
  withPreference
} from './model-preferences'

const opus: ModelOption = {
  value: 'opus',
  displayName: 'Opus',
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  supportedFeatures: ['effort levels', 'adaptive thinking']
}
const sonnet: ModelOption = {
  value: 'sonnet',
  displayName: 'Sonnet',
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  supportedFeatures: ['effort levels', 'adaptive thinking']
}
const haiku: ModelOption = {
  value: 'haiku',
  displayName: 'Haiku',
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  supportedFeatures: ['effort levels', 'adaptive thinking']
}
const catalog = [opus, sonnet, haiku]

const preferring = (models: Record<string, ModelPreference>): AdapterPreferences => ({
  ...EMPTY_ADAPTER_PREFERENCES,
  models
})

describe('pickerModels', () => {
  it('lists every model as others when nothing is preferred', () => {
    expect(pickerModels(catalog, EMPTY_ADAPTER_PREFERENCES)).toEqual({
      favourites: [],
      others: catalog
    })
  })

  it('moves favourites out of others and keeps catalog order within each group', () => {
    const groups = pickerModels(catalog, preferring({ haiku: 'favourite', opus: 'favourite' }))
    expect(groups).toEqual({ favourites: [opus, haiku], others: [sonnet] })
  })

  it('leaves hidden models out of both groups', () => {
    expect(pickerModels(catalog, preferring({ sonnet: 'hidden' }))).toEqual({
      favourites: [],
      others: [opus, haiku]
    })
  })

  it('lists every model when all of them are hidden', () => {
    const allHidden = preferring({ opus: 'hidden', sonnet: 'hidden', haiku: 'hidden' })
    expect(pickerModels(catalog, allHidden).others).toEqual(catalog)
  })

  it('ignores preferences for models the catalog no longer offers', () => {
    expect(pickerModels([opus], preferring({ retired: 'favourite' }))).toEqual({
      favourites: [],
      others: [opus]
    })
  })
})

describe('keepsAModelVisible', () => {
  it('refuses hiding the last visible model', () => {
    const twoHidden = preferring({ opus: 'hidden', sonnet: 'hidden' })
    expect(keepsAModelVisible(catalog, twoHidden, 'haiku', 'hidden')).toBe(false)
  })

  it('allows hiding a model while another stays visible', () => {
    const oneHidden = preferring({ opus: 'hidden' })
    expect(keepsAModelVisible(catalog, oneHidden, 'haiku', 'hidden')).toBe(true)
  })

  it('counts a favourite as visible', () => {
    const rest = preferring({ opus: 'hidden', sonnet: 'favourite' })
    expect(keepsAModelVisible(catalog, rest, 'haiku', 'hidden')).toBe(true)
  })

  it('is false for an empty catalog, which has nothing visible', () => {
    expect(keepsAModelVisible([], EMPTY_ADAPTER_PREFERENCES, 'opus', 'hidden')).toBe(false)
  })
})

describe('withPreference', () => {
  it('replaces hidden with favourite, so a model holds one preference', () => {
    expect(withPreference(preferring({ opus: 'hidden' }), 'opus', 'favourite').models).toEqual({
      opus: 'favourite'
    })
  })

  it('clears the preference when given null and keeps the others', () => {
    const prefs = preferring({ opus: 'favourite', sonnet: 'hidden' })
    expect(withPreference(prefs, 'opus', null).models).toEqual({ sonnet: 'hidden' })
  })

  it('keeps the defaults unchanged', () => {
    const prefs: AdapterPreferences = { models: {}, defaults: { model: 'opus' } }
    expect(withPreference(prefs, 'sonnet', 'hidden').defaults).toEqual({ model: 'opus' })
  })
})
