import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Uuid } from './uuid'

const decodeUuid = Schema.decodeUnknownResult(Uuid)

describe('Uuid', () => {
  it('accepts the initial pane id, whose version digit is 0', () => {
    expect(Result.isSuccess(decodeUuid('00000000-0000-0000-0000-000000000001'))).toBe(true)
  })

  it('accepts a random v4 id from crypto.randomUUID', () => {
    expect(Result.isSuccess(decodeUuid('3fa85f64-5717-4562-b3fc-2c963f66afa6'))).toBe(true)
  })

  it('accepts uppercase hex digits', () => {
    expect(Result.isSuccess(decodeUuid('3FA85F64-5717-4562-B3FC-2C963F66AFA6'))).toBe(true)
  })

  it('rejects a string with a non-hex digit', () => {
    expect(Result.isFailure(decodeUuid('3fa85f64-5717-4562-b3fc-2c963f66afag'))).toBe(true)
  })

  it('rejects a string one digit short', () => {
    expect(Result.isFailure(decodeUuid('3fa85f64-5717-4562-b3fc-2c963f66afa'))).toBe(true)
  })

  it('rejects a UUID without hyphens', () => {
    expect(Result.isFailure(decodeUuid('3fa85f6457174562b3fc2c963f66afa6'))).toBe(true)
  })

  it('rejects the empty string', () => {
    expect(Result.isFailure(decodeUuid(''))).toBe(true)
  })
})
