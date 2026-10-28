import { assert, describe, it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { TitleBarOverlayColors } from './contract'

const decode = Schema.decodeUnknownResult(TitleBarOverlayColors)

describe('TitleBarOverlayColors', () => {
  it('decodes a payload holding only symbolColor', () => {
    const result = decode({ symbolColor: '#ededef' })

    assert.isTrue(Result.isSuccess(result))
    if (Result.isSuccess(result)) assert.deepStrictEqual(result.success, { symbolColor: '#ededef' })
  })

  it('rejects a payload without symbolColor', () => {
    assert.isTrue(Result.isFailure(decode({})))
  })

  it('rejects the former payload that carried only an overlay colour', () => {
    assert.isTrue(Result.isFailure(decode({ color: '#0b0d11' })))
  })

  it('rejects a non-string symbolColor', () => {
    assert.isTrue(Result.isFailure(decode({ symbolColor: 0xededef })))
  })
})
