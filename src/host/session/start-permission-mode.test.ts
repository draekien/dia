import { assert, describe, it } from '@effect/vitest'
import { startPermissionMode } from './start-permission-mode'

describe('startPermissionMode', () => {
  it('starts in auto when the model supports it and settings do not disable it, even when opted into bypass', () => {
    assert.strictEqual(
      startPermissionMode({ modelSupportsAuto: true, disabled: [], bypassOptedIn: true }),
      'auto'
    )
  })

  it('starts in bypassPermissions when the model lacks auto and the hire opted in', () => {
    assert.strictEqual(
      startPermissionMode({ modelSupportsAuto: false, disabled: [], bypassOptedIn: true }),
      'bypassPermissions'
    )
  })

  it('starts in bypassPermissions when settings disable auto and the hire opted in', () => {
    assert.strictEqual(
      startPermissionMode({ modelSupportsAuto: true, disabled: ['auto'], bypassOptedIn: true }),
      'bypassPermissions'
    )
  })

  it('starts in default when the model lacks auto and the hire did not opt in', () => {
    assert.strictEqual(
      startPermissionMode({ modelSupportsAuto: false, disabled: [], bypassOptedIn: false }),
      'default'
    )
  })

  it('starts in default when settings disable auto and the hire did not opt in', () => {
    assert.strictEqual(
      startPermissionMode({ modelSupportsAuto: true, disabled: ['auto'], bypassOptedIn: false }),
      'default'
    )
  })

  it('starts in default when the hire opted in but settings disable bypassPermissions', () => {
    assert.strictEqual(
      startPermissionMode({
        modelSupportsAuto: false,
        disabled: ['bypassPermissions'],
        bypassOptedIn: true
      }),
      'default'
    )
  })

  it('starts in default when settings disable both auto and bypassPermissions', () => {
    assert.strictEqual(
      startPermissionMode({
        modelSupportsAuto: true,
        disabled: ['auto', 'bypassPermissions'],
        bypassOptedIn: true
      }),
      'default'
    )
  })
})
