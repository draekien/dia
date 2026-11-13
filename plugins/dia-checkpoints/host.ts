import type { CommittedEvent, HostPluginContext, PluginSetup, Runs } from '@dia/plugin'
import { GitKey, RunEventsKey, RunsKey } from '@dia/plugin'
import { Effect, Option, PubSub, Stream, SubscriptionRef } from 'effect'
import { type Boundary, boundaryOf } from './boundaries'
import { ChangesUnavailable, FollowRunChanges, GetFileDiff } from './calls'
import { type Checkpoints, makeCheckpoints } from './checkpoints'

interface Services {
  readonly runs: Runs
  readonly checkpoints: Checkpoints
}

const cwdOf = (runs: Runs, runId: string) =>
  Effect.map(runs.list, (list) =>
    Option.fromNullishOr(list.find((run) => run.runId === runId)?.cwd)
  )

const record = (services: Services, runId: string, boundary: Boundary) =>
  Effect.gen(function* () {
    const cwd = yield* cwdOf(services.runs, runId)
    if (Option.isNone(cwd)) return false
    yield* boundary._tag === 'TurnStart'
      ? services.checkpoints.beginTurn(runId, cwd.value, boundary.prompt)
      : services.checkpoints.endTurn(runId, cwd.value)
    return true
  }).pipe(
    Effect.catchTag('GitError', (error) =>
      Effect.as(
        Effect.logDebug('No turn snapshot for this run', { runId, error: error.message }),
        false
      )
    )
  )

const recordEach =
  (services: Services, recorded: PubSub.PubSub<string>) => (committed: CommittedEvent) =>
    Option.match(boundaryOf(committed.event), {
      onNone: () => Effect.void,
      onSome: (boundary) =>
        Effect.flatMap(record(services, committed.runId, boundary), (written) =>
          written ? PubSub.publish(recorded, committed.runId) : Effect.void
        )
    })

const turnsOf = (services: Services, runId: string) =>
  Effect.gen(function* () {
    const cwd = yield* cwdOf(services.runs, runId)
    if (Option.isNone(cwd)) return []
    return yield* services.checkpoints.turns(runId, cwd.value)
  }).pipe(
    Effect.catchTag('GitError', (error) =>
      Effect.as(
        Effect.logDebug('Could not read turn snapshots', { runId, error: error.message }),
        []
      )
    )
  )

const followTurns = (
  provided: Option.Option<Services>,
  recorded: PubSub.PubSub<string>,
  runId: string
) =>
  Option.match(provided, {
    onNone: () => Stream.make([]),
    onSome: (services) =>
      Stream.concat(
        Stream.make(runId),
        Stream.fromPubSub(recorded).pipe(Stream.filter((id) => id === runId))
      ).pipe(Stream.mapEffect(() => turnsOf(services, runId)))
  })

const fileDiff = (provided: Option.Option<Services>, runId: string, turn: number, path: string) =>
  Effect.gen(function* () {
    if (Option.isNone(provided)) return yield* new ChangesUnavailable({ runId })
    const { runs, checkpoints } = provided.value
    const cwd = yield* cwdOf(runs, runId)
    if (Option.isNone(cwd)) return yield* new ChangesUnavailable({ runId })
    return yield* checkpoints.fileDiff(runId, cwd.value, turn, path)
  }).pipe(
    Effect.catchTag('GitError', (error) =>
      Effect.andThen(
        Effect.logWarning('Could not read a file diff', { runId, turn, error: error.message }),
        Effect.fail(new ChangesUnavailable({ runId }))
      )
    )
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const services = yield* SubscriptionRef.make(Option.none<Services>())
    const recorded = yield* PubSub.unbounded<string>()
    yield* ctx.whenProvided([RunsKey, RunEventsKey, GitKey], ({ runs, runEvents, git }) =>
      Effect.gen(function* () {
        const current: Services = { runs, checkpoints: makeCheckpoints(git) }
        yield* Effect.acquireRelease(SubscriptionRef.set(services, Option.some(current)), () =>
          SubscriptionRef.set(services, Option.none())
        )
        const events = yield* runEvents.subscribe
        yield* events.pipe(Stream.runForEach(recordEach(current, recorded)), Effect.forkScoped)
        yield* Effect.logInfo('Recording turn snapshots', { plugin: ctx.name })
      })
    )
    yield* ctx.serve(FollowRunChanges, ({ runId }) =>
      SubscriptionRef.changes(services).pipe(
        Stream.switchMap((provided) => followTurns(provided, recorded, runId))
      )
    )
    yield* ctx.serve(GetFileDiff, ({ runId, turn, path }) =>
      Effect.flatMap(SubscriptionRef.get(services), (provided) =>
        fileDiff(provided, runId, turn, path)
      )
    )
    yield* Effect.logInfo('Run changes served', { plugin: ctx.name })
  })

export default setup
