import type { CommittedEvent, HostPluginContext, PluginSetup, RunEvents } from '@dia/plugin'
import { RunEventsKey } from '@dia/plugin'
import { Effect, Option, Stream, SubscriptionRef } from 'effect'
import { FollowRunUsage } from './calls'
import { emptyUsageFold, foldUsage, USAGE_TAGS } from './usage'

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
      const start = stored.reduce((fold, { event }) => foldUsage(fold, event), emptyUsageFold)
      const through = stored.at(-1)?.sequence ?? 0
      yield* Effect.logDebug('Following run usage', { runId, turns: start.usage.turns.length })
      const isNewUsageEvent = (committed: CommittedEvent) =>
        committed.runId === runId &&
        committed.sequence > through &&
        usageTags.has(committed.event._tag)
      return live.pipe(
        Stream.filter(isNewUsageEvent),
        Stream.scan(
          () => start,
          (fold, { event }) => foldUsage(fold, event)
        ),
        Stream.map((fold) => fold.usage),
        Stream.changesWith((a, b) => a === b)
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
            onNone: () => Stream.make(emptyUsageFold.usage),
            onSome: (runEvents) => followUsage(runEvents, runId)
          })
        )
      )
    )
    yield* Effect.logInfo('Run usage served', { plugin: ctx.name })
  })

export default setup
