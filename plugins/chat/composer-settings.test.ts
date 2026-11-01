import { describe, expect, it } from 'vitest'
import { permissionSettingLabel, thinkingSettingLabel } from './composer-settings'

describe('thinkingSettingLabel', () => {
  it.each([
    ['medium', 'Medium effort'],
    ['xhigh', 'Extra high effort'],
    ['adaptive', 'Adaptive thinking'],
    ['off', 'Thinking off']
  ] as const)('reads %s as %s', (level, text) => {
    expect(thinkingSettingLabel(level)).toBe(text)
  })
})

describe('permissionSettingLabel', () => {
  it('appends mode to the permission mode label', () => {
    expect(permissionSettingLabel('auto')).toBe('Auto mode')
  })
})
