import type { ModelOption } from '@shared/domain/model'
import { describe, expect, it } from 'vitest'
import { fitThinkingLevel, thinkingLevelsFor } from './thinking-levels'

const model = (fields: Pick<ModelOption, 'adaptiveThinking' | 'effortLevels'>): ModelOption => ({
  value: 'model',
  displayName: 'Model',
  description: '',
  supportedFeatures: ['effort levels', 'adaptive thinking'],
  ...fields
})

describe('thinkingLevelsFor', () => {
  it('offers adaptive, off and every effort the model supports, in menu order', () => {
    const opus = model({
      adaptiveThinking: true,
      effortLevels: ['max', 'low', 'medium', 'high', 'xhigh']
    })
    expect(thinkingLevelsFor(opus)).toEqual([
      'adaptive',
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })

  it('leaves out the efforts the model does not support', () => {
    const opus46 = model({ adaptiveThinking: true, effortLevels: ['low', 'medium', 'high', 'max'] })
    expect(thinkingLevelsFor(opus46)).toEqual(['adaptive', 'off', 'low', 'medium', 'high', 'max'])
  })

  it('offers only off for a model without adaptive thinking', () => {
    expect(thinkingLevelsFor(model({ adaptiveThinking: false, effortLevels: ['low'] }))).toEqual([
      'off'
    ])
  })

  it('offers adaptive and off for an adaptive model with no effort levels', () => {
    expect(thinkingLevelsFor(model({ adaptiveThinking: true, effortLevels: [] }))).toEqual([
      'adaptive',
      'off'
    ])
  })

  it('offers adaptive, off, low, medium and high for an unknown model', () => {
    expect(thinkingLevelsFor(undefined)).toEqual(['adaptive', 'off', 'low', 'medium', 'high'])
  })
})

describe('fitThinkingLevel', () => {
  it('keeps a level the model offers', () => {
    expect(fitThinkingLevel('xhigh', ['adaptive', 'off', 'high', 'xhigh'])).toBe('xhigh')
  })

  it('lowers an unsupported effort to the highest offered effort below it', () => {
    expect(fitThinkingLevel('xhigh', ['adaptive', 'off', 'low', 'medium', 'high', 'max'])).toBe(
      'high'
    )
  })

  it('falls back to adaptive when no lower effort is offered', () => {
    expect(fitThinkingLevel('low', ['adaptive', 'off', 'high'])).toBe('adaptive')
  })

  it('falls back to off when the model offers only off', () => {
    expect(fitThinkingLevel('adaptive', ['off'])).toBe('off')
    expect(fitThinkingLevel('max', ['off'])).toBe('off')
  })
})
