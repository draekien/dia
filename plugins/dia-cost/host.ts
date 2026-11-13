import type { CommittedEvent, HostPluginContext, PluginSetup, RunEvents } from '@dia/plugin'
import { RunEventsKey } from '@dia/plugin'
import { Effect, Option, Stream, SubscriptionRef } from 'effect'
import { FollowRunUsage } from './calls'
import { emptyRunUsage, foldUsage, USAGE_TAGS } from './usage'

const usageTags = new Set<string>(USAGE_TAGS)

const storedUsage = (runEvents: RunEvents, runId: string) =>
  runEvents
    .readTagged(runId, USAGE_TAGS)
    .pipe(
      Effect.catchTag('RunEventReadError', (error) =>
        Effect.as(
          Effect.logWarning('Could not read the run usage; showing none', { runId, error }),
          []
        )
      )
    )

const followUsage = (runEvents: RunEvents, runId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const live = yield* runEvents.subscribe
      const stored = yield* storedUsage(runEvents, runId)
      const start = stored.reduce((usage, { event }) => foldUsage(usage, event), emptyRunUsage)
      const through = stored.at(-1)?.sequence ?? 0
      yield* Effect.logDebug('Following run usage', { runId, turns: start.turns.length })
      const isNewUsageEvent = (committed: CommittedEvent) =>
        committed.runId === runId &&
        committed.sequence > through &&
        usageTags.has(committed.event._tag)
      return live.pipe(
        Stream.filter(isNewUsageEvent),
        Stream.scan(
          () => start,
          (usage, { event }) => foldUsage(usage, event)
        )
      )
    })
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const provided = yield* SubscriptionRef.make(Option.none<RunEvents>())
    yield* ctx.whenProvided([RunEventsKey], ({ runEvents }) =>
      Effect.acquireRelease(SubscriptionRef.set(provided, Option.some(runEvents)), () =>
        SubscriptionRef.set(provided, Option.none())
      )
    )
    yield* ctx.serve(FollowRunUsage, ({ runId }) =>
      SubscriptionRef.changes(provided).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.make(emptyRunUsage),
            onSome: (runEvents) => followUsage(runEvents, runId)
          })
        )
      )
    )
    yield* Effect.logInfo('Run usage served', { plugin: ctx.name })
  })

export default setup
