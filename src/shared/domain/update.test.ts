import { Either, Schema } from 'effect'
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

const decode = Schema.decodeUnknownEither(UpdateStatus)
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
      expect(Either.isRight(round)).toBe(true)
      if (Either.isRight(round)) expect(round.right).toStrictEqual(variant)
    }
  })

  it('decodes a downloading payload preserving its percent', () => {
    const decoded = decode({ _tag: 'UpdateDownloading', percent: 87 })
    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isRight(decoded)) {
      expect(decoded.right._tag).toBe('UpdateDownloading')
      if (decoded.right._tag === 'UpdateDownloading') expect(decoded.right.percent).toBe(87)
    }
  })

  it('rejects a downloading payload missing its percent', () => {
    expect(Either.isLeft(decode({ _tag: 'UpdateDownloading' }))).toBe(true)
  })

  it('rejects an unknown tag', () => {
    expect(Either.isLeft(decode({ _tag: 'UpdateSideways' }))).toBe(true)
  })
})
