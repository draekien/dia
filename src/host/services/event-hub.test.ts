import { assert, describe, it } from '@effect/vitest'
import { MessageUpdated } from '@shared/domain/agent-event'
import { EMPTY_WORKSPACE } from '@shared/domain/project'
import { PaneAgentEvent, PaneTurnStatusChanged, WorkspaceChanged } from '@shared/ipc/contract'
import type { EventFrame } from '@shared/ipc/rpc'
import { Effect, Fiber, Option, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { AgentEventStore } from './agent-event-store'
import { EventHub, EventHubLive, REPLAY_LIMITS } from './event-hub'
import { AgentEventStoreTestLayer, EventHubTestLayer } from './event-hub-test-layer'

const paneA = '00000000-0000-4000-8000-00000000000a'
const paneB = '00000000-0000-4000-8000-00000000000b'

const status = (paneId: string, label: string) => PaneTurnStatusChanged.make({ paneId, label })

const reply = (itemId: string, content: string) =>
  MessageUpdated.make({ itemId, message: { role: 'assistant', content }, streaming: false })

const collect = (count: number, cursors: Record<string, number>) =>
  Effect.gen(function* () {
    const hub = yield* EventHub
    return yield* hub.subscribe(cursors).pipe(Stream.take(count), Stream.runCollect)
  })

const subscribeInBackground = (count: number, cursors: Record<string, number>) =>
  Effect.gen(function* () {
    const hub = yield* EventHub
    const fiber = yield* hub
      .subscribe(cursors)
      .pipe(Stream.take(count), Stream.runCollect, Effect.forkChild({ startImmediately: true }))
    yield* Effect.yieldNow
    return fiber
  })

const summary = (frames: ReadonlyArray<EventFrame>): ReadonlyArray<string> =>
  frames.map((frame) => {
    if (frame._tag === 'PaneEvent') {
      const detail =
        frame.event._tag === 'PaneTurnStatusChanged'
          ? frame.event.label
          : frame.event._tag === 'PaneAgentEvent'
            ? frame.event.agentEvent._tag
            : frame.event._tag
      return `${frame.paneId.slice(-1)}:${detail}`
    }
    if (frame._tag === 'ReloadHistory') return `reload:${frame.paneId.slice(-1)}`
    return frame._tag
  })

const lastSequence = (paneId: string) =>
  Effect.gen(function* () {
    const store = yield* AgentEventStore
    return yield* store.lastSequence(paneId)
  })

describe('EventHub.publish', () => {
  it.effect('stores a pane signal and delivers it numbered with its stored sequence', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      const subscriber = yield* subscribeInBackground(1, {})

      yield* hub.publish(status(paneA, 'Thinking'))

      const [frame] = yield* Fiber.join(subscriber)
      assert.deepStrictEqual(
        frame._tag === 'PaneEvent' ? frame.seq : frame._tag,
        yield* lastSequence(paneA)
      )
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect('delivers an agent event stored by the Host as a PaneAgentEvent', () =>
    Effect.gen(function* () {
      const store = yield* AgentEventStore
      const subscriber = yield* subscribeInBackground(1, {})

      const [sequence] = yield* store.append(paneA, [{ event: reply('m1', 'hi') }])

      const [frame] = yield* Fiber.join(subscriber)
      assert.deepStrictEqual(frame, {
        _tag: 'PaneEvent',
        paneId: paneA,
        seq: Option.getOrThrow(sequence),
        event: PaneAgentEvent.make({ paneId: paneA, agentEvent: reply('m1', 'hi') })
      })
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect('does not store or deliver a PaneAgentEvent published from outside the store', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub

      yield* hub.publish(PaneAgentEvent.make({ paneId: paneA, agentEvent: reply('m1', 'hi') }))

      assert.strictEqual(yield* lastSequence(paneA), 0)
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.live('tells subscribers to reload the pane when its signal cannot be stored', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      const sql = yield* SqlClient.SqlClient
      const subscriber = yield* subscribeInBackground(1, {})
      yield* sql`DROP TABLE agent_events`

      yield* hub.publish(status(paneA, 'Thinking'))

      assert.deepStrictEqual(summary(yield* Fiber.join(subscriber)), ['reload:a'])
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect('delivers an event with no pane live and never replays it', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      const layoutEvent = WorkspaceChanged.make({ workspace: EMPTY_WORKSPACE })
      yield* hub.publish(layoutEvent)
      const subscriber = yield* subscribeInBackground(1, {})

      yield* hub.publish(layoutEvent)

      assert.deepStrictEqual(summary(yield* Fiber.join(subscriber)), ['GlobalEvent'])
    }).pipe(Effect.provide(EventHubTestLayer))
  )
})

describe('EventHub.subscribe', () => {
  it.effect('replays only the stored events after the client’s cursor, in order', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(status(paneA, 'a1'))
      const cursor = yield* lastSequence(paneA)
      yield* hub.publish(status(paneB, 'b1'))
      yield* hub.publish(status(paneA, 'a2'))
      yield* hub.publish(status(paneA, 'a3'))

      const frames = yield* collect(2, { [paneA]: cursor })

      assert.deepStrictEqual(summary(frames), ['a:a2', 'a:a3'])
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect('sends no stored event of a pane the client has no cursor for', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(status(paneA, 'old'))
      yield* Effect.yieldNow
      const subscriber = yield* subscribeInBackground(1, {})

      yield* hub.publish(status(paneA, 'new'))

      assert.deepStrictEqual(summary(yield* Fiber.join(subscriber)), ['a:new'])
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect('continues with live events after the replay without repeating any', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(status(paneA, 'a1'))
      const cursor = yield* lastSequence(paneA)
      yield* hub.publish(status(paneA, 'a2'))
      const subscriber = yield* subscribeInBackground(2, { [paneA]: cursor })

      yield* hub.publish(status(paneA, 'a3'))

      assert.deepStrictEqual(summary(yield* Fiber.join(subscriber)), ['a:a2', 'a:a3'])
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect('replays as many events as the replay limit allows', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      for (let index = 0; index < REPLAY_LIMITS.maxEvents; index++) {
        yield* hub.publish(status(paneA, `a${index}`))
      }

      const frames = yield* collect(1, { [paneA]: 0 })

      assert.deepStrictEqual(summary(frames), ['a:a0'])
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect('tells the client to reload a pane with more missed events than the limit', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      for (let index = 0; index <= REPLAY_LIMITS.maxEvents; index++) {
        yield* hub.publish(status(paneA, `a${index}`))
      }

      const frames = yield* collect(1, { [paneA]: 0 })

      assert.deepStrictEqual(summary(frames), ['reload:a'])
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect('tells the client to reload a pane when its cursor is past the last event', () =>
    Effect.gen(function* () {
      const hub = yield* EventHub
      yield* hub.publish(status(paneA, 'a1'))

      const frames = yield* collect(1, { [paneA]: (yield* lastSequence(paneA)) + 1 })

      assert.deepStrictEqual(summary(frames), ['reload:a'])
    }).pipe(Effect.provide(EventHubTestLayer))
  )

  it.effect(
    'tells the client to reload a pane when its cursor is from before the Host started',
    () =>
      Effect.gen(function* () {
        const store = yield* AgentEventStore
        yield* store.append(paneA, [{ event: status(paneA, 'previous run') }])
        const cursor = yield* store.lastSequence(paneA)

        const frames = yield* collect(1, { [paneA]: cursor }).pipe(Effect.provide(EventHubLive))

        assert.deepStrictEqual(summary(frames), ['reload:a'])
      }).pipe(Effect.provide(AgentEventStoreTestLayer))
  )

  it.effect('replays a cursor from this run when an earlier run stored events', () =>
    Effect.gen(function* () {
      const store = yield* AgentEventStore
      yield* store.append(paneA, [{ event: status(paneA, 'previous run') }])
      const frames = yield* Effect.gen(function* () {
        const hub = yield* EventHub
        yield* hub.publish(status(paneA, 'a1'))
        const cursor = yield* store.lastSequence(paneA)
        yield* hub.publish(status(paneA, 'a2'))
        return yield* collect(1, { [paneA]: cursor })
      }).pipe(Effect.provide(EventHubLive))

      assert.deepStrictEqual(summary(frames), ['a:a2'])
    }).pipe(Effect.provide(AgentEventStoreTestLayer))
  )
})
