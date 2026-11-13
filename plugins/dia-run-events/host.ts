import {
  type HostPluginContext,
  hostDatabaseOf,
  type ModelCatalogState,
  ModelsLoading,
  type PluginSetup,
  type RunEvents,
  RunEventsKey
} from '@dia/plugin'
import { type AgentBackend, AgentBackendKey } from '@dia-plugin/dia-runs/backend'
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
    const backend = yield* Ref.make(Option.none<AgentBackend>())
    const catalog = yield* Ref.make<ModelCatalogState>(ModelsLoading.make({}))
    yield* ctx.whenProvided([AgentBackendKey], ({ agentBackend }) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Ref.set(backend, Option.some(agentBackend)), () =>
          Ref.set(backend, Option.none()).pipe(
            Effect.andThen(Ref.set(catalog, ModelsLoading.make({}))),
            Effect.andThen(
              Effect.logInfo('The agent backend was withdrawn; catch-up reads nothing')
            )
          )
        )
        yield* agentBackend.models().pipe(
          Stream.runForEach((state) => Ref.set(catalog, state)),
          Effect.forkScoped
        )
        yield* Effect.logInfo('Reading transcripts through the agent backend')
      })
    )
    const withBackend = <A>(
      sessionId: string,
      read: (loaded: AgentBackend) => Effect.Effect<Option.Option<A>>
    ) =>
      Effect.flatMap(Ref.get(backend), (loaded) =>
        Option.isSome(loaded)
          ? read(loaded.value)
          : Effect.logWarning('No agent backend to read a transcript with', { sessionId }).pipe(
              Effect.as(Option.none<A>())
            )
      )
    const transcripts = Transcripts.of({
      transcriptInfo: (sessionId, cwd) =>
        withBackend(sessionId, (loaded) => loaded.transcriptInfo(sessionId, cwd)),
      readTranscriptAfter: (sessionId, cwd, afterUuid) =>
        withBackend(sessionId, (loaded) => loaded.readTranscriptAfter(sessionId, cwd, afterUuid))
    })
    return { transcripts, catalog: RunModelCatalog.of({ current: Ref.get(catalog) }) }
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
