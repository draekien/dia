import type { HostPluginContext, PluginSetup, RunRequest, Runs } from '@dia/plugin'
import { RunsKey } from '@dia/plugin'
import { Effect, Option, Stream, SubscriptionRef } from 'effect'
import { FollowInbox, type InboxItem } from './calls'

const itemsOf = Effect.fnUntraced(function* (runs: Runs, requests: ReadonlyArray<RunRequest>) {
  const cwds = new Map((yield* runs.list).map((run) => [run.runId, run.cwd]))
  return requests.map(
    ({ runId, request }): InboxItem => ({ runId, cwd: cwds.get(runId) ?? '', request })
  )
})

const inboxOf = (provided: Option.Option<Runs>): Stream.Stream<ReadonlyArray<InboxItem>> =>
  Option.match(provided, {
    onNone: () => Stream.make([]),
    onSome: (runs) => runs.requests.pipe(Stream.mapEffect((requests) => itemsOf(runs, requests)))
  })

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const runs = yield* SubscriptionRef.make(Option.none<Runs>())
    yield* ctx.whenProvided([RunsKey], ({ runs: provided }) =>
      Effect.acquireRelease(SubscriptionRef.set(runs, Option.some(provided)), () =>
        SubscriptionRef.set(runs, Option.none())
      ).pipe(Effect.andThen(Effect.logInfo('The inbox follows runs', { plugin: ctx.name })))
    )
    yield* ctx.serve(FollowInbox, () =>
      SubscriptionRef.changes(runs).pipe(
        Stream.switchMap(inboxOf),
        Stream.tap((items) => Effect.logDebug('Inbox changed', { items: items.length }))
      )
    )
    yield* Effect.logInfo('Inbox served', { plugin: ctx.name })
  })

export default setup
