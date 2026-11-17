import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type { ModelOption } from './model'
import {
  type AdapterPreferences,
  EMPTY_ADAPTER_PREFERENCES,
  keepsAModelVisible,
  LegacyModelPreferences,
  type ModelPreference,
  ModelPreferences,
  pickerModels,
  StoredModelPreferences,
  withPreference
} from './model-preferences'

const opus: ModelOption = {
  value: 'opus',
  displayName: 'Opus',
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  autoMode: true,
  fastMode: false
}
const sonnet: ModelOption = {
  value: 'sonnet',
  displayName: 'Sonnet',
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  autoMode: true,
  fastMode: false
}
const haiku: ModelOption = {
  value: 'haiku',
  displayName: 'Haiku',
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  autoMode: true,
  fastMode: false
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
})

const decodeStored = Schema.decodeUnknownSync(StoredModelPreferences)
const encodeStored = Schema.encodeSync(StoredModelPreferences)

describe('StoredModelPreferences', () => {
  const legacy = {
    models: { opus: 'favourite', sonnet: 'hidden' },
    defaults: { model: 'opus', thinkingLevel: 'high', permissionMode: 'default' }
  }
  const migrated = {
    adapters: { 'dia-claude-code': { models: { opus: 'favourite', sonnet: 'hidden' } } },
    defaults: {
      selection: { backend: 'dia-claude-code', model: 'opus' },
      thinkingLevel: 'high',
      permissionMode: 'default'
    }
  }

  it('decodes the shape stored before adapters into dia-claude-code preferences', () => {
    expect(decodeStored(legacy)).toEqual(migrated)
  })

  it('decodes a legacy shape without a default model to defaults without a selection', () => {
    expect(decodeStored({ models: {}, defaults: {} })).toEqual({
      adapters: { 'dia-claude-code': { models: {} } },
      defaults: {}
    })
  })

  it('re-encodes preferences decoded from the legacy shape in the new shape', () => {
    expect(encodeStored(decodeStored(legacy))).toEqual(migrated)
  })

  it('decodes the new shape as it is', () => {
    const stored = {
      adapters: { 'other-adapter': { models: { alpha: 'hidden' } } },
      defaults: { selection: { backend: 'other-adapter', model: 'alpha' } }
    }
    expect(decodeStored(stored)).toEqual(stored)
  })

  it('rejects a value of neither shape', () => {
    expect(() => decodeStored({ models: 'opus' })).toThrow()
  })
})

describe('LegacyModelPreferences', () => {
  it('encodes the selection of another adapter as no default model', () => {
    const encoded = Schema.encodeSync(LegacyModelPreferences)({
      adapters: {},
      defaults: { selection: { backend: 'other-adapter', model: 'alpha' } }
    })
    expect(encoded).toEqual({ models: {}, defaults: {} })
  })

  it('is the codec ModelPreferences decodes from', () => {
    expect(Schema.decodeUnknownSync(ModelPreferences)({ adapters: {}, defaults: {} })).toEqual({
      adapters: {},
      defaults: {}
    })
  })
})
