import { describe, expect, it } from 'vitest'
import { thinkingOptions } from './thinking-options'

describe('thinkingOptions', () => {
  it('disables extended thinking for "off" and carries no effort', () => {
    expect(thinkingOptions('off')).toEqual({ thinking: { type: 'disabled' } })
  })

  it('lets the model decide for "adaptive" and carries no effort', () => {
    expect(thinkingOptions('adaptive')).toEqual({ thinking: { type: 'adaptive' } })
  })

  it('runs adaptive thinking capped at the chosen effort for low/medium/high', () => {
    expect(thinkingOptions('low')).toEqual({ thinking: { type: 'adaptive' }, effort: 'low' })
    expect(thinkingOptions('medium')).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' })
    expect(thinkingOptions('high')).toEqual({ thinking: { type: 'adaptive' }, effort: 'high' })
  })
})
