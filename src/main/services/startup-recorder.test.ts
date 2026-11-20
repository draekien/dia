import { assert, describe, it } from '@effect/vitest'
import {
  EagerPluginLoadStarted,
  HostStarted,
  HostStarting,
  type StartupLog
} from '@shared/domain/startup'
import { CHANNEL, IpcEvent } from '@shared/ipc/contract'
import { Duration, Effect, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { makeStartupRecorder, type StartupEventSender } from './startup-recorder'

const decodeEvent = Schema.decodeUnknownSync(IpcEvent)

const recordingSender = () => {
  const pushed: Array<StartupLog> = []
  const sender: StartupEventSender = {
    send: (channel, payload) => {
      assert.strictEqual(channel, CHANNEL.event)
      const event = decodeEvent(payload)
      if (event._tag === 'StartupLogChanged') pushed.push(event.log)
    }
  }
  return { sender, pushed }
}

const tagsOf = (log: StartupLog): ReadonlyArray<string> => log.map((entry) => entry.event._tag)

describe('StartupRecorder', () => {
  it.effect('stamps each step with the time it was recorded', () =>
    Effect.gen(function* () {
      const recorder = yield* makeStartupRecorder(recordingSender().sender)
      yield* recorder.record(HostStarting.make({}))
      yield* TestClock.adjust(Duration.millis(310))

      yield* recorder.record(HostStarted.make({}))

      const log = yield* recorder.current
      assert.strictEqual(log[1].atMillis - log[0].atMillis, 310)
    })
  )

  it.effect('pushes the whole log to the renderer each time it records a step', () =>
    Effect.gen(function* () {
      const { sender, pushed } = recordingSender()
      const recorder = yield* makeStartupRecorder(sender)

      yield* recorder.record(HostStarting.make({}))
      yield* recorder.record(HostStarted.make({}))

      assert.deepStrictEqual(pushed.map(tagsOf), [
        ['HostStarting'],
        ['HostStarting', 'HostStarted']
      ])
    })
  )

  it.effect('gives a renderer that mounts late every step recorded so far', () =>
    Effect.gen(function* () {
      const recorder = yield* makeStartupRecorder(recordingSender().sender)
      yield* recorder.record(HostStarting.make({}))
      yield* recorder.record(HostStarted.make({}))
      yield* recorder.record(EagerPluginLoadStarted.make({ name: 'dia-runs' }))

      const log = yield* recorder.current

      assert.deepStrictEqual(tagsOf(log), ['HostStarting', 'HostStarted', 'EagerPluginLoadStarted'])
    })
  )

  it.effect('starts a new log when a restarted Host starts', () =>
    Effect.gen(function* () {
      const recorder = yield* makeStartupRecorder(recordingSender().sender)
      yield* recorder.record(HostStarting.make({}))
      yield* recorder.record(EagerPluginLoadStarted.make({ name: 'dia-runs' }))

      yield* recorder.record(HostStarting.make({}))

      assert.deepStrictEqual(tagsOf(yield* recorder.current), ['HostStarting'])
    })
  )

  it.effect('records nothing before the first step', () =>
    Effect.gen(function* () {
      const recorder = yield* makeStartupRecorder(recordingSender().sender)

      assert.deepStrictEqual(yield* recorder.current, [])
    })
  )
})
