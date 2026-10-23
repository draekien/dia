import type { IpcEvent } from '@shared/ipc/contract'
import {
  type EventFrame,
  GlobalEventFrame,
  PaneEventFrame,
  ReloadHistoryFrame
} from '@shared/ipc/rpc'
import { Context, Effect, Layer, Predicate, PubSub, Stream } from 'effect'

interface PaneBuffer {
  nextSeq: number
  readonly frames: Array<PaneEventFrame>
}

/**
 * Number of recent events the Host keeps per pane for replay after a dropped connection. A
 * client whose last received sequence number is older than the oldest buffered event is told to
 * reload the pane's history from the transcript instead.
 */
export const DEFAULT_REPLAY_BUFFER_SIZE = 1000

/**
 * Fan-out of every renderer-facing event, with per-pane sequence numbers and an in-memory replay
 * buffer. Call `publish` for each event the Host produces; call `subscribe` once per connected
 * client. The buffer is not persisted: a Host restart discards it, and a client resubscribing
 * with a cursor from before the restart is told to reload history.
 */
export class EventHub extends Context.Service<
  EventHub,
  {
    /**
     * Stamps `event` with the next sequence number of its pane (events with no `paneId` are
     * unnumbered and never replayed), records it in the pane's buffer, and delivers it to every
     * live subscriber.
     */
    readonly publish: (event: IpcEvent) => Effect.Effect<void>
    /**
     * Streams frames to one client. `cursors` maps a pane id to the last sequence number the
     * client received for it. For each cursor the stream first replays the buffered events after
     * it, or emits `ReloadHistory` when the buffer no longer holds them (or the pane is unknown
     * to this Host), then continues with live events without duplicating replayed ones. Panes
     * without a cursor receive only events published after subscribing.
     */
    readonly subscribe: (cursors: Readonly<Record<string, number>>) => Stream.Stream<EventFrame>
  }
>()('EventHub') {}

const paneIdOf = (event: IpcEvent): string | undefined =>
  Predicate.hasProperty(event, 'paneId') && typeof event.paneId === 'string'
    ? event.paneId
    : undefined

/**
 * Builds the live {@link EventHub} layer, keeping the last `bufferSize` events per pane for
 * replay.
 */
export const makeEventHubLive = (bufferSize: number = DEFAULT_REPLAY_BUFFER_SIZE) =>
  Layer.effect(
    EventHub,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<EventFrame>()
      const buffers = new Map<string, PaneBuffer>()

      const publish = (event: IpcEvent): Effect.Effect<void> =>
        Effect.sync(() => {
          const paneId = paneIdOf(event)
          if (paneId === undefined) {
            PubSub.publishUnsafe(pubsub, GlobalEventFrame.make({ event }))
            return
          }
          const buffer = buffers.get(paneId) ?? { nextSeq: 1, frames: [] }
          buffers.set(paneId, buffer)
          const frame = PaneEventFrame.make({ paneId, seq: buffer.nextSeq, event })
          buffer.nextSeq += 1
          buffer.frames.push(frame)
          if (buffer.frames.length > bufferSize) buffer.frames.shift()
          PubSub.publishUnsafe(pubsub, frame)
        })

      const replayFor = (
        paneId: string,
        cursor: number
      ): { readonly frames: ReadonlyArray<EventFrame>; readonly deliveredThrough: number } => {
        const buffer = buffers.get(paneId)
        const lastSeq = buffer === undefined ? 0 : buffer.nextSeq - 1
        const oldestSeq = buffer?.frames[0]?.seq ?? lastSeq + 1
        if (buffer === undefined || cursor > lastSeq || cursor + 1 < oldestSeq) {
          return {
            frames: [ReloadHistoryFrame.make({ paneId })],
            deliveredThrough: lastSeq
          }
        }
        return {
          frames: buffer.frames.filter((frame) => frame.seq > cursor),
          deliveredThrough: lastSeq
        }
      }

      const subscribe = (cursors: Readonly<Record<string, number>>): Stream.Stream<EventFrame> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(pubsub)
            const delivered = new Map<string, number>()
            const replay: Array<EventFrame> = []
            for (const [paneId, cursor] of Object.entries(cursors)) {
              const result = replayFor(paneId, cursor)
              replay.push(...result.frames)
              delivered.set(paneId, result.deliveredThrough)
            }
            const live = Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (frame) =>
                  frame._tag !== 'PaneEvent' || frame.seq > (delivered.get(frame.paneId) ?? 0)
              )
            )
            return Stream.concat(Stream.fromIterable(replay), live)
          })
        )

      return { publish, subscribe }
    })
  )
