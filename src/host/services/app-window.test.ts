import { assert, describe, it } from '@effect/vitest'
import type { HostToMainMessage } from '@shared/ipc/host-process'
import { Effect, Fiber, Stream } from 'effect'
import { AppWindow, makeAppWindowLive } from './app-window'

const harness = () => {
  const posted: Array<HostToMainMessage> = []
  const layer = makeAppWindowLive((message) => Effect.sync(() => void posted.push(message)))
  return { posted, layer }
}

describe('AppWindow', () => {
  it.effect('reports the window as attended until main reports otherwise', () =>
    Effect.gen(function* () {
      const { layer } = harness()

      const attended = yield* Effect.gen(function* () {
        const window = yield* AppWindow
        const collected = yield* window.attended.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true })
        )
        yield* window.setAttended(false)
        yield* window.setAttended(true)
        return yield* Fiber.join(collected)
      }).pipe(Effect.scoped, Effect.provide(layer))

      assert.deepStrictEqual(attended, [true, false, true])
    })
  )

  it.effect('asks main to show each notification', () =>
    Effect.gen(function* () {
      const { posted, layer } = harness()
      const notification = { paneId: 'pane-1', title: 'otter in dia', body: 'Failed: boom' }

      yield* Effect.flatMap(AppWindow, (window) => window.notify(notification)).pipe(
        Effect.provide(layer)
      )

      assert.deepStrictEqual(posted, [{ _tag: 'Notify', notification }])
    })
  )
})
