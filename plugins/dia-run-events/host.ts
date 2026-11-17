import {
  type HostPluginContext,
  hostDatabaseOf,
  ModelsLoading,
  type PluginSetup,
  type RunEvents,
  RunEventsKey,
  type Runs,
  RunsKey
} from '@dia/plugin'
import type { AgentBackend } from '@dia-plugin/dia-agent-adapters/backend'
import { type AgentAdapters, AgentAdaptersKey } from '@dia-plugin/dia-agent-adapters/registry'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Context, Deferred, Effect, Layer, Option, Ref, Stream, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import { FollowRunChat, RunChatSnapshot, RunEventCommitted } from './calls'
import { handOverFromHostDatabase } from './handover'
import { runEventsMigrations } from './migrations'
import {
  RunChatProjection,
  RunChatProjectionLive,
  RunModelCatalog,
  RunWorkspace
} from './projection'
import { RunEventRecorder, RunEventRecorderLive, Transcripts } from './recorder'
import { RunEventStore, RunEventStoreLive } from './store'

type Workspace = Stream.Success<HostPluginContext['workspace']>

const followWorkspace = (ctx: HostPluginContext) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<SubscriptionRef.SubscriptionRef<Workspace>>()
    yield* ctx.workspace.pipe(
      Stream.runForEach((workspace) =>
        Deferred.isDone(first).pipe(
          Effect.flatMap((ready) =>
            ready
              ? Effect.flatMap(Deferred.await(first), (ref) => SubscriptionRef.set(ref, workspace))
              : Effect.flatMap(SubscriptionRef.make(workspace), (ref) =>
                  Deferred.succeed(first, ref)
                )
          )
        )
      ),
      Effect.forkScoped
    )
    return yield* Deferred.await(first)
  })

const followBackend = (ctx: HostPluginContext) =>
  Effect.gen(function* () {
    const adapters = yield* Ref.make(Option.none<AgentAdapters>())
    const runs = yield* Ref.make(Option.none<Runs>())
    yield* ctx.whenProvided([AgentAdaptersKey], ({ agentAdapters }) =>
      Effect.acquireRelease(Ref.set(adapters, Option.some(agentAdapters)), () =>
        Ref.set(adapters, Option.none()).pipe(
          Effect.andThen(
            Effect.logInfo('The adapter registry was withdrawn; reads find no adapter')
          )
        )
      )
    )
    yield* ctx.whenProvided([RunsKey], ({ runs: provided }) =>
      Effect.acquireRelease(Ref.set(runs, Option.some(provided)), () =>
        Ref.set(runs, Option.none())
      )
    )
    const adapterOf = (runId: string) =>
      Effect.gen(function* () {
        const loadedRuns = yield* Ref.get(runs)
        const loadedAdapters = yield* Ref.get(adapters)
        if (Option.isNone(loadedRuns) || Option.isNone(loadedAdapters)) return undefined
        const info = (yield* loadedRuns.value.list).find((candidate) => candidate.runId === runId)
        return info === undefined ? undefined : { id: info.backend, registry: loadedAdapters.value }
      })
    const withBackend = <A>(
      runId: string,
      read: (loaded: AgentBackend) => Effect.Effect<Option.Option<A>>
    ) =>
      Effect.gen(function* () {
        const adapter = yield* adapterOf(runId)
        const loaded = adapter === undefined ? undefined : yield* adapter.registry.get(adapter.id)
        if (loaded === undefined || Option.isNone(loaded)) {
          return yield* Effect.logWarning('No agent adapter to read a transcript with', {
            runId,
            adapter: adapter?.id
          }).pipe(Effect.as(Option.none<A>()))
        }
        return yield* read(loaded.value.backend)
      })
    const transcripts = Transcripts.of({
      transcriptInfo: (runId, sessionId, cwd) =>
        withBackend(runId, (loaded) => loaded.transcriptInfo(sessionId, cwd)),
      readTranscriptAfter: (runId, sessionId, cwd, afterUuid) =>
        withBackend(runId, (loaded) => loaded.readTranscriptAfter(sessionId, cwd, afterUuid))
    })
    const current = (runId: string) =>
      Effect.gen(function* () {
        const adapter = yield* adapterOf(runId)
        if (adapter === undefined) return ModelsLoading.make({})
        return yield* adapter.registry
          .models(adapter.id)
          .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow))
      })
    return { transcripts, catalog: RunModelCatalog.of({ current }) }
  })

const followRunChat = (
  store: RunEventStore['Service'],
  projection: RunChatProjection['Service'],
  runId: string
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const later = yield* store.subscribe
      const snapshot = yield* projection.snapshot(runId)
      yield* Effect.logDebug('Following a run chat', { runId, seq: snapshot.seq })
      const events = later.pipe(
        Stream.filter(
          (committed) => committed.runId === runId && committed.sequence > snapshot.seq
        ),
        Stream.map((committed) =>
          RunEventCommitted.make({ sequence: committed.sequence, event: committed.event })
        )
      )
      return Stream.concat(Stream.make(RunChatSnapshot.make({ snapshot })), events)
    })
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(runEventsMigrations)
    yield* handOverFromHostDatabase(hostDatabaseOf(ctx.dataDir)).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeFileSystem.layer)
    )
    const workspace = yield* followWorkspace(ctx)
    const { transcripts, catalog } = yield* followBackend(ctx)
    const context = yield* Layer.build(
      RunChatProjectionLive.pipe(
        Layer.provideMerge(RunEventRecorderLive),
        Layer.provideMerge(RunEventStoreLive),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(SqlClient.SqlClient, sql),
            Layer.succeed(Transcripts, transcripts),
            Layer.succeed(RunModelCatalog, catalog),
            Layer.succeed(RunWorkspace, workspace),
            NodeCrypto.layer
          )
        )
      )
    )
    const store = Context.get(context, RunEventStore)
    const recorder = Context.get(context, RunEventRecorder)
    const projection = Context.get(context, RunChatProjection)
    const startSequence = yield* store.highestSequence
    const runEvents: RunEvents = {
      append: store.append,
      committed: store.committed,
      subscribe: store.subscribe,
      readAfter: store.readAfter,
      readTagged: store.readTagged,
      highestSequence: store.highestSequence,
      startSequence,
      record: recorder.open,
      snapshot: projection.snapshot,
      seed: projection.seed,
      release: projection.release
    }
    yield* ctx.provide(RunEventsKey, runEvents)
    yield* ctx.serve(FollowRunChat, ({ runId }) => followRunChat(store, projection, runId))
    yield* Effect.logInfo('Run event log provided', { plugin: ctx.name, startSequence })
  })

export default setup
