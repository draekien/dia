import type { HostPluginContext, PluginSetup, Runs } from '@dia/plugin'
import { RunsKey } from '@dia/plugin'
import { Effect, Option, SubscriptionRef } from 'effect'
import { RunQueueKey } from './queue'
import { makeRunQueue } from './run-queue'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const runs = yield* SubscriptionRef.make(Option.none<Runs>())
    yield* ctx.whenProvided([RunsKey], ({ runs: provided }) =>
      Effect.acquireRelease(SubscriptionRef.set(runs, Option.some(provided)), () =>
        SubscriptionRef.set(runs, Option.none())
      ).pipe(Effect.andThen(Effect.logInfo('The run queue follows runs', { plugin: ctx.name })))
    )
    yield* ctx.provide(RunQueueKey, yield* makeRunQueue(runs))
    yield* Effect.logInfo('Run queue provided', { plugin: ctx.name })
  })

export default setup
