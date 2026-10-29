import type { ModelOption } from '@shared/domain/model'
import { describe, expect, it } from 'vitest'
import {
  CREATE_PERMISSION_MODE_OPTIONS,
  disabledPermissionModesFor,
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

describe('disabledPermissionModesFor', () => {
  const model = (autoMode: boolean): ModelOption => ({
    value: 'model',
    displayName: 'Model',
    description: '',
    adaptiveThinking: true,
    effortLevels: [],
    autoMode,
    fastMode: false
  })

  it('adds auto for a model without auto mode', () => {
    expect(disabledPermissionModesFor(['bypassPermissions'], model(false))).toEqual([
      'bypassPermissions',
      'auto'
    ])
  })

  it('keeps the settings list for a model with auto mode', () => {
    expect(disabledPermissionModesFor(['bypassPermissions'], model(true))).toEqual([
      'bypassPermissions'
    ])
  })

  it('keeps the settings list when the model is unknown', () => {
    expect(disabledPermissionModesFor([], undefined)).toEqual([])
  })

  it('lists auto once when the settings already turn it off', () => {
    expect(disabledPermissionModesFor(['auto'], model(false))).toEqual(['auto'])
  })
})
