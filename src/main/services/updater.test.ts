import { assert, describe, it } from '@effect/vitest'
import {
  UpdateChecking,
  UpdateDownloading,
  UpdateError,
  UpdateReady,
  type UpdateStatus,
  UpdateUpToDate
} from '@shared/domain/update'
import { CHANNEL, IpcEvent } from '@shared/ipc/contract'
import { Effect, Schema } from 'effect'
import {
  makeUpdaterBridge,
  toUpdateStatus,
  type UpdateEventSender,
  type UpdaterSignal
} from './updater'

const decodeEvent = Schema.decodeUnknownSync(IpcEvent)

interface SentMessage {
  readonly channel: string
  readonly payload: unknown
}

function recordingSender(): {
  readonly sender: UpdateEventSender
  readonly sent: ReadonlyArray<SentMessage>
} {
  const sent: SentMessage[] = []
  return {
    sender: {
      send: (channel, ...args) => {
        sent.push({ channel, payload: args[0] })
      }
    },
    sent
  }
}

describe('toUpdateStatus', () => {
  it.each<{ readonly signal: UpdaterSignal; readonly expected: UpdateStatus }>([
    { signal: { _tag: 'Checking' }, expected: UpdateChecking.make({}) },
    { signal: { _tag: 'NotAvailable' }, expected: UpdateUpToDate.make({}) },
    {
      signal: { _tag: 'Progress', percent: 30 },
      expected: UpdateDownloading.make({ percent: 30 })
    },
    {
      signal: { _tag: 'Downloaded', version: '2.0.0' },
      expected: UpdateReady.make({ version: '2.0.0' })
    },
    { signal: { _tag: 'Failed', message: 'boom' }, expected: UpdateError.make({ message: 'boom' }) }
  ])('maps $signal._tag to its update status', ({ signal, expected }) => {
    assert.deepStrictEqual(toUpdateStatus(signal), expected)
  })
})

describe('makeUpdaterBridge', () => {
  it.effect('pushes an UpdateStatusChanged event carrying the mapped status', () =>
    Effect.gen(function* () {
      const { sender, sent } = recordingSender()
      const bridge = yield* makeUpdaterBridge(sender)

      yield* bridge.report({ _tag: 'Progress', percent: 55 })

      assert.strictEqual(sent.length, 1)
      assert.strictEqual(sent[0]?.channel, CHANNEL.event)
      const event = decodeEvent(sent[0]?.payload)
      assert.strictEqual(event._tag, 'UpdateStatusChanged')
      if (event._tag === 'UpdateStatusChanged') {
        assert.deepStrictEqual(event.status, UpdateDownloading.make({ percent: 55 }))
      }
    })
  )

  it.effect('exposes the latest reported status through current', () =>
    Effect.gen(function* () {
      const { sender } = recordingSender()
      const bridge = yield* makeUpdaterBridge(sender)

      yield* bridge.report({ _tag: 'Checking' })
      yield* bridge.report({ _tag: 'Downloaded', version: '3.1.4' })

      assert.deepStrictEqual(yield* bridge.current, UpdateReady.make({ version: '3.1.4' }))
    })
  )

  it.effect('seeds current with the idle status before any signal', () =>
    Effect.gen(function* () {
      const { sender } = recordingSender()
      const bridge = yield* makeUpdaterBridge(sender)

      const status = yield* bridge.current
      assert.strictEqual(status._tag, 'UpdateIdle')
    })
  )
})
