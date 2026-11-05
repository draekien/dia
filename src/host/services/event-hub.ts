import { type IpcEvent, PaneAgentEvent, PaneSignal } from '@shared/ipc/contract'
import {
  type EventFrame,
  GlobalEventFrame,
  PaneEventFrame,
  ReloadHistoryFrame
} from '@shared/ipc/rpc'
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Predicate,
  PubSub,
  Schedule,
  Schema,
  Stream
} from 'effect'
import { AgentEventStore, type CommittedEvent, type ReplayLimits } from './agent-event-store'

/**
 * The most a resubscribing client is sent as a replay of one pane: 128 events and 1 MiB of stored
 * event JSON. A client that missed more is told to reload the pane's history instead. The values
 * match T3 Code's `THREAD_RESUME_MAX_REPLAY_EVENTS` and `THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES`.
 */
export const REPLAY_LIMITS: ReplayLimits = { maxEvents: 128, maxBytes: 1_048_576 }

const APPEND_RETRIES = 3

/**
 * Fan-out of every renderer-facing event. Pane events are stored in the pane's agent event stream
 * and delivered with the stored sequence number, so a client can resume from its last one. Call
 * `publish` for each event the Host produces; call `subscribe` once per connected client.
 */
export class EventHub extends Context.Service<
  EventHub,
  {
    /**
     * Delivers `event` to every live subscriber. An event with a `paneId` must be a
     * {@link PaneSignal}: it is stored in that pane's event stream first and delivered with its
     * sequence number. When it cannot be stored after retries, subscribers are told to reload the
     * pane's history. An event without a `paneId` is delivered unnumbered and never replayed.
     */
    readonly publish: (event: IpcEvent) => Effect.Effect<void>
    /**
     * Streams frames to one client. `cursors` maps a pane id to the last sequence number the
     * client received for it. For each cursor the stream first replays the stored events after
     * it, or emits `ReloadHistory` when they cannot be replayed: more than {@link REPLAY_LIMITS},
     * a cursor past the pane's last event, or a cursor from before this Host started (the client's
     * state then describes a session that has ended). It then continues with live events without
     * repeating replayed ones. Panes without a cursor receive only events stored after subscribing.
     */
    readonly subscribe: (cursors: Readonly<Record<string, number>>) => Stream.Stream<EventFrame>
  }
>()('EventHub') {}

const paneIdOf = (event: IpcEvent): string | undefined =>
  Predicate.hasProperty(event, 'paneId') && typeof event.paneId === 'string'
    ? event.paneId
    : undefined

const isPaneSignal = Schema.is(PaneSignal)

const frameOf = (committed: CommittedEvent): PaneEventFrame => {
  const paneId = committed.agentId
  const event =
    'paneId' in committed.event
      ? committed.event
      : // The stored agent id was a validated pane id when it was written.
        PaneAgentEvent.make({ paneId, agentEvent: committed.event }, { disableChecks: true })
  return PaneEventFrame.make({ paneId, seq: committed.sequence, event })
}

/**
 * The live {@link EventHub} layer. Requires {@link AgentEventStore}; follows its committed events
 * for the layer's lifetime.
 */
export const EventHubLive = Layer.effect(
  EventHub,
  Effect.gen(function* () {
    const store = yield* AgentEventStore
    const pubsub = yield* PubSub.unbounded<EventFrame>()
    const hostStartSequence = yield* store.highestSequence.pipe(
      Effect.catch(() => Effect.succeed(0))
    )
    yield* store.committed.pipe(
      Stream.runForEach((committed) => PubSub.publish(pubsub, frameOf(committed))),
      Effect.forkScoped({ startImmediately: true })
    )
    yield* Effect.logDebug('Delivering stored pane events', { hostStartSequence })

    const storeSignal = (paneId: string, event: PaneSignal) =>
      store.append(paneId, [{ event }]).pipe(
        Effect.retry({
          times: APPEND_RETRIES,
          schedule: Schedule.exponential(Duration.millis(20))
        }),
        Effect.catch((error) =>
          Effect.logError('Could not store a pane event; clients reload the pane', {
            paneId,
            event: event._tag,
            error
          }).pipe(Effect.andThen(PubSub.publish(pubsub, ReloadHistoryFrame.make({ paneId }))))
        ),
        Effect.asVoid
      )

    const publish = Effect.fnUntraced(function* (event: IpcEvent) {
      const paneId = paneIdOf(event)
      if (paneId === undefined) {
        yield* PubSub.publish(pubsub, GlobalEventFrame.make({ event }))
        return
      }
      if (!isPaneSignal(event)) {
        yield* Effect.logWarning('Did not publish a pane event the Host stores itself', {
          paneId,
          event: event._tag
        })
        return
      }
      yield* storeSignal(paneId, event)
    })

    const replayFor = Effect.fnUntraced(function* (paneId: string, cursor: number) {
      const startedAt = yield* Clock.currentTimeMillis
      const read = yield* store.readAfter(paneId, cursor, REPLAY_LIMITS)
      const fromEndedRun = cursor > 0 && cursor <= hostStartSequence
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt
      if (read._tag === 'Replay' && !fromEndedRun) {
        yield* Effect.logDebug('Replaying pane events', {
          paneId,
          cursor,
          events: read.events.length,
          elapsedMs
        })
        return { frames: read.events.map(frameOf), deliveredThrough: read.through }
      }
      yield* Effect.logDebug('Told a client to reload pane history', {
        paneId,
        cursor,
        reason: read._tag === 'Replay' ? 'hostRestarted' : read.reason,
        elapsedMs
      })
      return { frames: [ReloadHistoryFrame.make({ paneId })], deliveredThrough: 0 }
    })

    const subscribe = (cursors: Readonly<Record<string, number>>): Stream.Stream<EventFrame> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub)
          const delivered = new Map<string, number>()
          const replay: Array<EventFrame> = []
          for (const [paneId, cursor] of Object.entries(cursors)) {
            const result = yield* replayFor(paneId, cursor)
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

    return EventHub.of({ publish, subscribe })
  })
)
