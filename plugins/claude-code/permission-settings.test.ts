import { describe, expect, it } from 'vitest'
import { disabledPermissionModes } from './permission-settings'

describe('disabledPermissionModes', () => {
  it('turns nothing off when no switch is set', () => {
    expect(disabledPermissionModes({ permissions: { allow: ['Read'] } })).toEqual([])
  })

  it('turns off auto mode from the top-level switch', () => {
    expect(disabledPermissionModes({ disableAutoMode: 'disable' })).toEqual(['auto'])
  })

  it('turns off auto mode from the switch under permissions', () => {
    expect(disabledPermissionModes({ permissions: { disableAutoMode: 'disable' } })).toEqual([
      'auto'
    ])
  })

  it('turns off bypass mode from permissions.disableBypassPermissionsMode', () => {
    expect(
      disabledPermissionModes({ permissions: { disableBypassPermissionsMode: 'disable' } })
    ).toEqual(['bypassPermissions'])
  })

  it('turns off both modes when both switches are set', () => {
    expect(
      disabledPermissionModes({
        disableAutoMode: 'disable',
        permissions: { disableBypassPermissionsMode: 'disable' }
      })
    ).toEqual(['auto', 'bypassPermissions'])
  })

  it('ignores a switch whose value is not "disable" and still reads the others', () => {
    expect(
      disabledPermissionModes({
        disableAutoMode: true,
        permissions: { disableBypassPermissionsMode: 'disable' }
      })
    ).toEqual(['bypassPermissions'])
  })

  it('turns nothing off when the settings are not an object', () => {
    expect(disabledPermissionModes(undefined)).toEqual([])
  })
})
