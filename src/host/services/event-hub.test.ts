import { assert, describe, it } from '@effect/vitest'
import { EMPTY_WORKSPACE } from '@shared/domain/project'
import { PaneAssistantTextDelta, WorkspaceChanged } from '@shared/ipc/contract'
import type { EventFrame } from '@shared/ipc/rpc'
import { Effect, Fiber, Stream } from 'effect'
import { EventHub, makeEventHubLive } from './event-hub'

const paneA = '00000000-0000-0000-0000-00000000000a'
const paneB = '00000000-0000-0000-0000-00000000000b'

const delta = (paneId: string, text: string) => PaneAssistantTextDelta.make({ paneId, text })

const collect = (count: number, cursors: Record<string, number>) =>
  Effect.gen(function* () {
    const hub = yield* EventHub
    return yield* hub.subscribe(cursors).pipe(Stream.take(count), Stream.runCollect)
  })

const summary = (frames: ReadonlyArray<EventFrame>): ReadonlyArray<string> =>
  frames.map((frame) => {
    if (frame._tag === 'PaneEvent') {
      const detail =
        frame.event._tag === 'PaneAssistantTextDelta' ? frame.event.text : frame.event._tag
      return `${frame.paneId.slice(-1)}#${frame.seq}:${detail}`
    }
    if (frame._tag === 'ReloadHistory') return `reload:${frame.paneId.slice(-1)}`
    return frame._tag
  })

describe('EventHub', () => {
  it.effect('numbers each pane’s events independently, starting at 1', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(delta(paneA, 'a1'))
      yield* hub.publish(delta(paneB, 'b1'))
      yield* hub.publish(delta(paneA, 'a2'))

      const frames = yield* collect(3, { [paneA]: 0, [paneB]: 0 })

      assert.deepStrictEqual([...summary(frames)].sort(), ['a#1:a1', 'a#2:a2', 'b#1:b1'])
    }).pipe(Effect.provide(makeEventHubLive(10)))
  )

  it.effect('replays only the events after the client’s cursor', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(delta(paneA, 'a1'))
      yield* hub.publish(delta(paneA, 'a2'))
      yield* hub.publish(delta(paneA, 'a3'))

      const frames = yield* collect(2, { [paneA]: 1 })

      assert.deepStrictEqual(summary(frames), ['a#2:a2', 'a#3:a3'])
    }).pipe(Effect.provide(makeEventHubLive(10)))
  )

  it.effect('sends nothing from the buffer to a client with no cursor for the pane', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(delta(paneA, 'old'))

      const subscriber = yield* hub
        .subscribe({})
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* hub.publish(delta(paneA, 'new'))
      const frames = yield* Fiber.join(subscriber)

      assert.deepStrictEqual(summary(frames), ['a#2:new'])
    }).pipe(Effect.provide(makeEventHubLive(10)))
  )

  it.effect('tells the client to reload history when its cursor is older than the buffer', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(delta(paneA, 'a1'))
      yield* hub.publish(delta(paneA, 'a2'))
      yield* hub.publish(delta(paneA, 'a3'))

      const frames = yield* collect(1, { [paneA]: 0 })

      assert.deepStrictEqual(summary(frames), ['reload:a'])
    }).pipe(Effect.provide(makeEventHubLive(2)))
  )

  it.effect('replays when the cursor is exactly one before the oldest buffered event', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(delta(paneA, 'a1'))
      yield* hub.publish(delta(paneA, 'a2'))
      yield* hub.publish(delta(paneA, 'a3'))

      const frames = yield* collect(2, { [paneA]: 1 })

      assert.deepStrictEqual(summary(frames), ['a#2:a2', 'a#3:a3'])
    }).pipe(Effect.provide(makeEventHubLive(2)))
  )

  it.effect('tells the client to reload history for a pane this Host has never seen', () =>
    Effect.gen(function* () {
      const frames = yield* collect(1, { [paneB]: 7 })

      assert.deepStrictEqual(summary(frames), ['reload:b'])
    }).pipe(Effect.provide(makeEventHubLive(10)))
  )

  it.effect('tells the client to reload history when its cursor is ahead of the Host', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(delta(paneA, 'a1'))

      const frames = yield* collect(1, { [paneA]: 5 })

      assert.deepStrictEqual(summary(frames), ['reload:a'])
    }).pipe(Effect.provide(makeEventHubLive(10)))
  )

  it.effect('continues with live events after the replay without repeating any', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(delta(paneA, 'a1'))
      yield* hub.publish(delta(paneA, 'a2'))

      const subscriber = yield* hub
        .subscribe({ [paneA]: 1 })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* hub.publish(delta(paneA, 'a3'))
      const frames = yield* Fiber.join(subscriber)

      assert.deepStrictEqual(summary(frames), ['a#2:a2', 'a#3:a3'])
    }).pipe(Effect.provide(makeEventHubLive(10)))
  )

  it.effect('delivers events with no pane live but never replays them', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      const layoutEvent = WorkspaceChanged.make({ workspace: EMPTY_WORKSPACE })
      yield* hub.publish(layoutEvent)

      const subscriber = yield* hub
        .subscribe({})
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* hub.publish(layoutEvent)
      const frames = yield* Fiber.join(subscriber)

      assert.deepStrictEqual(summary(frames), ['GlobalEvent'])
    }).pipe(Effect.provide(makeEventHubLive(10)))
  )
})
