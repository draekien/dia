import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { type RunQueue, RunQueueKey } from '@dia-plugin/dia-run-queue/queue'
import { Effect, Option, SubscriptionRef } from 'effect'
import { makeSchedules } from './make-schedules'
import { schedulesMigrations } from './migrations'
import { PutSchedule, RemoveSchedule, SchedulesKey } from './schedules'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const queue = yield* SubscriptionRef.make(Option.none<RunQueue>())
    yield* ctx.whenProvided([RunQueueKey], ({ 'run-queue': provided }) =>
      Effect.acquireRelease(SubscriptionRef.set(queue, Option.some(provided)), () =>
        SubscriptionRef.set(queue, Option.none())
      ).pipe(Effect.andThen(Effect.logInfo('Schedules follow the run queue', { plugin: ctx.name })))
    )
    const sql = yield* ctx.database(schedulesMigrations)
    const schedules = yield* makeSchedules({ activities: ctx.activities, sql, queue })
    yield* ctx.provide(SchedulesKey, schedules)
    yield* ctx.serve(PutSchedule, ({ schedule }) => schedules.put(schedule))
    yield* ctx.serve(RemoveSchedule, ({ scheduleId }) => schedules.remove(scheduleId))
    yield* Effect.logInfo('Schedules provided', { plugin: ctx.name })
  })

export default setup
