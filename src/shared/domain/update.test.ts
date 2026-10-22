import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  UpdateChecking,
  UpdateDownloading,
  UpdateError,
  UpdateIdle,
  UpdateReady,
  UpdateStatus,
  UpdateUpToDate
} from './update'

const decode = Schema.decodeUnknownResult(UpdateStatus)
const encode = Schema.encodeSync(UpdateStatus)

describe('UpdateStatus', () => {
  it('round-trips every variant through encode then decode', () => {
    const variants: ReadonlyArray<UpdateStatus> = [
      UpdateIdle.make({}),
      UpdateChecking.make({}),
      UpdateUpToDate.make({}),
      UpdateDownloading.make({ percent: 42 }),
      UpdateReady.make({ version: '1.2.3' }),
      UpdateError.make({ message: 'network down' })
    ]

    for (const variant of variants) {
      const round = decode(encode(variant))
      expect(Result.isSuccess(round)).toBe(true)
      if (Result.isSuccess(round)) expect(round.success).toStrictEqual(variant)
    }
  })

  it('decodes a downloading payload preserving its percent', () => {
    const decoded = decode({ _tag: 'UpdateDownloading', percent: 87 })
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(decoded.success._tag).toBe('UpdateDownloading')
      if (decoded.success._tag === 'UpdateDownloading') expect(decoded.success.percent).toBe(87)
    }
  })

  it('rejects a downloading payload missing its percent', () => {
    expect(Result.isFailure(decode({ _tag: 'UpdateDownloading' }))).toBe(true)
  })

  it('rejects an unknown tag', () => {
    expect(Result.isFailure(decode({ _tag: 'UpdateSideways' }))).toBe(true)
  })
})
