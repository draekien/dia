import { describe, expect, it } from 'vitest'
import {
  CREATE_PERMISSION_MODE_OPTIONS,
  offeredPermissionModes,
  PERMISSION_MODE_OPTIONS
} from './permission-modes'

const values = (options: ReadonlyArray<{ readonly value: string }>) =>
  options.map((option) => option.value)

describe('CREATE_PERMISSION_MODE_OPTIONS', () => {
  it('offers every live mode except plan, including full access', () => {
    expect(values(CREATE_PERMISSION_MODE_OPTIONS)).toEqual([
      'default',
      'acceptEdits',
      'auto',
      'dontAsk',
      'bypassPermissions'
    ])
  })
})

describe('offeredPermissionModes', () => {
  it('offers every mode when none is disabled', () => {
    expect(offeredPermissionModes(PERMISSION_MODE_OPTIONS, [], 'default')).toEqual(
      PERMISSION_MODE_OPTIONS
    )
  })

  it('leaves out the disabled modes', () => {
    expect(
      values(
        offeredPermissionModes(PERMISSION_MODE_OPTIONS, ['auto', 'bypassPermissions'], 'default')
      )
    ).toEqual(['default', 'plan', 'acceptEdits', 'dontAsk'])
  })

  it('keeps a disabled mode that the pane is currently in', () => {
    expect(
      values(offeredPermissionModes(PERMISSION_MODE_OPTIONS, ['auto', 'bypassPermissions'], 'auto'))
    ).toEqual(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk'])
  })
})
