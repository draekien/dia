import {
  type GitOps,
  type HostPluginContext,
  hostSettingsOf,
  MetaRepoKey,
  NO_SESSION_ADDITIONS,
  PermissionAnswer,
  PlanReviewAnswer,
  type PluginCallAttempt,
  type PluginSetup,
  QuestionAnswer,
  type RunEvents,
  RunEventsKey,
  RunsKey,
  type SessionMetaRepo,
  WorktreesKey
} from '@dia/plugin'
import { unavailableBackend } from '@dia-plugin/dia-agent-adapters/backend'
import {
  type AgentAdapter,
  type AgentAdapters,
  AgentAdaptersKey,
  notLoadedMessage
} from '@dia-plugin/dia-agent-adapters/registry'
import { ToolsKey } from '@dia-plugin/dia-tools/tools'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Crypto, Effect, Option, Stream, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  EditQueuedMessage,
  FollowModelPreferences,
  GetModelPreferences,
  GetSlashCommands,
  GetUsageLimitResume,
  InterruptRun,
  OpenRunInTab,
  RemoveQueuedMessage,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion,
  ResumeParkedRun,
  RewindToCheckpoint,
  SendMessage,
  SendQueuedMessageNow,
  SetAgentDefaults,
  SetModelPreference,
  SetUsageLimitResume,
  StartRun
} from './calls'
import { makeDefaultSelection } from './default-selection'
import { makeFeeds } from './feeds'
import { handOverSettings, storeUsageLimitResume, usageLimitResumeOf } from './handover'
import { runsMigrations } from './migrations'
import { makeRunRegistry } from './run-registry'
import { makeRunRows, type RunRows } from './run-rows'
import { makeRunTools } from './run-tools'

const follow = <A>(
  ctx: HostPluginContext,
  ref: SubscriptionRef.SubscriptionRef<Option.Option<A>>,
  name: string,
  value: A
) =>
  Effect.acquireRelease(
    SubscriptionRef.set(ref, Option.some(value)).pipe(
      Effect.andThen(Effect.logInfo('A service runs use was provided', { plugin: ctx.name, name }))
    ),
    () =>
      SubscriptionRef.set(ref, Option.none()).pipe(
        Effect.andThen(
          Effect.logInfo('A service runs use was withdrawn', { plugin: ctx.name, name })
        )
      )
  )

const followProviders = Effect.fn('Runs.followProviders')(function* (ctx: HostPluginContext) {
  const adapters = yield* SubscriptionRef.make(Option.none<AgentAdapters>())
  const runEvents = yield* SubscriptionRef.make(Option.none<RunEvents>())
  const gitOps = yield* SubscriptionRef.make(Option.none<GitOps>())
  const meta = yield* SubscriptionRef.make(Option.none<SessionMetaRepo>())
  yield* ctx.whenProvided([AgentAdaptersKey], ({ agentAdapters }) =>
    follow(ctx, adapters, 'agentAdapters', agentAdapters)
  )
  yield* ctx.whenProvided([RunEventsKey], ({ runEvents: provided }) =>
    follow(ctx, runEvents, 'runEvents', provided)
  )
  yield* ctx.whenProvided([WorktreesKey], ({ worktrees }) =>
    follow(ctx, gitOps, 'worktrees', worktrees)
  )
  yield* ctx.whenProvided([MetaRepoKey], ({ metaRepo }) => follow(ctx, meta, 'metaRepo', metaRepo))
  return { adapters, runEvents, gitOps, meta }
})

const followModels = (
  adapters: SubscriptionRef.SubscriptionRef<Option.Option<AgentAdapters>>,
  id: string
) =>
  SubscriptionRef.changes(adapters).pipe(
    Stream.switchMap(
      Option.match({
        onNone: () => unavailableBackend(notLoadedMessage(id)).models(),
        onSome: (agentAdapters) => agentAdapters.models(id)
      })
    )
  )

const once =
  (rows: RunRows) =>
  (tag: string, runId: string, call: PluginCallAttempt, apply: Effect.Effect<void>) =>
    Effect.gen(function* () {
      if (!(yield* rows.claim(call.id, runId, tag))) {
        return yield* Effect.logDebug('Ignored a session call already applied', {
          tag,
          runId,
          requestId: call.id,
          resent: call.resent
        })
      }
      yield* apply
    })

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(runsMigrations)
    const rows = yield* makeRunRows.pipe(Effect.provideService(SqlClient.SqlClient, sql))
    yield* handOverSettings(rows, hostSettingsOf(ctx.dataDir)).pipe(
      Effect.provide(NodeFileSystem.layer)
    )
    const providers = yield* followProviders(ctx)
    const registered = SubscriptionRef.changes(providers.adapters).pipe(
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.succeed<ReadonlyArray<AgentAdapter>>([]),
          onSome: (agentAdapters) => agentAdapters.adapters
        })
      )
    )
    const currentAdapters = registered.pipe(
      Stream.take(1),
      Stream.runHead,
      Effect.map(Option.getOrElse((): ReadonlyArray<AgentAdapter> => []))
    )
    const backendOf = (id: string) =>
      Effect.gen(function* () {
        const agentAdapters = yield* SubscriptionRef.get(providers.adapters)
        const adapter = Option.isSome(agentAdapters)
          ? yield* agentAdapters.value.get(id)
          : Option.none<AgentAdapter>()
        return Option.match(adapter, {
          onNone: () => unavailableBackend(notLoadedMessage(id)),
          onSome: (found) => found.backend
        })
      })
    const modelsOf = (id: string) =>
      followModels(providers.adapters, id).pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.map(Option.getOrThrow)
      )
    const crypto = yield* Effect.provide(Crypto.Crypto, NodeCrypto.layer)
    const runTools = yield* makeRunTools.pipe(Effect.provide(NodeCrypto.layer))

    const sessionAdditions = Effect.flatMap(
      SubscriptionRef.get(providers.meta),
      Option.match({
        onNone: () => Effect.succeed(NO_SESSION_ADDITIONS),
        onSome: (repo) =>
          repo.forNewSession.pipe(
            Effect.catchDefect((defect) =>
              Effect.logError('The meta repo forNewSession effect died', { defect }).pipe(
                Effect.as(NO_SESSION_ADDITIONS)
              )
            )
          )
      })
    )

    const feeds = yield* makeFeeds({ models: modelsOf, rows })
    const defaultSelection = makeDefaultSelection({
      preferences: Effect.map(feeds.preferences.current, (snapshot) => snapshot.preferences),
      adapters: registered,
      models: (id) => followModels(providers.adapters, id)
    })

    const registry = yield* makeRunRegistry({
      rows,
      backendOf,
      adapters: currentAdapters,
      runEvents: SubscriptionRef.get(providers.runEvents),
      gitOps: SubscriptionRef.get(providers.gitOps),
      additions: sessionAdditions,
      sessionTools: runTools.sessionTools,
      usageLimitResume: usageLimitResumeOf(rows),
      newRunId: crypto.randomUUIDv4().pipe(Effect.orDie),
      defaultSelection
    })
    const { runs } = registry
    const sessionCall = once(rows)

    yield* ctx.whenProvided([ToolsKey], ({ tools }) =>
      runTools.follow(tools, ctx.pluginTools(runs.awaitIdle))
    )
    yield* ctx.provide(RunsKey, runs)

    yield* ctx.serve(SendMessage, ({ runId, text, mode, attachments }, call) =>
      sessionCall('SendMessage', runId, call, runs.send(runId, text, mode, attachments))
    )
    yield* ctx.serve(EditQueuedMessage, ({ runId, messageId, text, attachments }, call) =>
      sessionCall(
        'EditQueuedMessage',
        runId,
        call,
        runs.editQueued(runId, messageId, text, attachments)
      )
    )
    yield* ctx.serve(RemoveQueuedMessage, ({ runId, messageId }, call) =>
      sessionCall('RemoveQueuedMessage', runId, call, runs.removeQueued(runId, messageId))
    )
    yield* ctx.serve(SendQueuedMessageNow, ({ runId, messageId }, call) =>
      sessionCall('SendQueuedMessageNow', runId, call, runs.sendQueuedNow(runId, messageId))
    )
    yield* ctx.serve(ResolvePermission, ({ runId, requestId, response }, call) =>
      sessionCall(
        'ResolvePermission',
        runId,
        call,
        runs.answer(runId, requestId, PermissionAnswer.make({ response }))
      )
    )
    yield* ctx.serve(ResolveQuestion, ({ runId, requestId, response }, call) =>
      sessionCall(
        'ResolveQuestion',
        runId,
        call,
        runs.answer(runId, requestId, QuestionAnswer.make({ response }))
      )
    )
    yield* ctx.serve(ResolvePlanReview, ({ runId, requestId, approved }, call) =>
      sessionCall(
        'ResolvePlanReview',
        runId,
        call,
        runs.answer(runId, requestId, PlanReviewAnswer.make({ approved }))
      )
    )
    yield* ctx.serve(InterruptRun, ({ runId }, call) =>
      sessionCall('InterruptRun', runId, call, runs.interrupt(runId))
    )
    yield* ctx.serve(ResumeParkedRun, ({ runId }, call) =>
      sessionCall('ResumeParkedRun', runId, call, runs.resumeParked(runId))
    )
    yield* ctx.serve(RewindToCheckpoint, ({ runId, messageUuid, resumeAnchorUuid }, call) =>
      sessionCall(
        'RewindToCheckpoint',
        runId,
        call,
        runs.rewind(runId, messageUuid, resumeAnchorUuid)
      )
    )
    yield* ctx.serve(StartRun, (options) => runs.start(options))
    yield* ctx.serve(OpenRunInTab, ({ runId }) =>
      runs.openInTab(runId).pipe(
        Effect.as(true),
        Effect.catchTag('RunNotFoundError', () =>
          Effect.logWarning('No run to open in a tab', { runId }).pipe(Effect.as(false))
        )
      )
    )
    yield* ctx.serve(GetUsageLimitResume, () => usageLimitResumeOf(rows))
    yield* ctx.serve(SetUsageLimitResume, ({ mode }) =>
      storeUsageLimitResume(rows, mode).pipe(Effect.andThen(registry.setUsageLimitResume(mode)))
    )
    yield* ctx.serve(GetModelPreferences, () => feeds.preferences.current)
    yield* ctx.serve(SetModelPreference, ({ adapter, model, preference }) =>
      feeds.preferences.set(adapter, model, Option.fromNullishOr(preference))
    )
    yield* ctx.serve(SetAgentDefaults, ({ defaults }) => feeds.preferences.setDefaults(defaults))
    yield* ctx.serve(FollowModelPreferences, () => feeds.preferences.changes)
    yield* ctx.serve(GetSlashCommands, ({ adapter, cwd }) =>
      Effect.gen(function* () {
        yield* Effect.logDebug('Reading slash commands', { adapter, cwd })
        const additions = yield* sessionAdditions
        const loaded = yield* backendOf(adapter)
        return yield* loaded.slashCommands(cwd, additions)
      })
    )

    yield* Effect.gen(function* () {
      yield* ctx.pluginsSettled
      yield* registry.normaliseWaiting
      const recovered = new Map<string, AgentAdapter>()
      yield* registered.pipe(
        Stream.runForEach((adapters) =>
          Effect.forEach(
            adapters.filter((adapter) => recovered.get(adapter.id) !== adapter),
            (adapter) =>
              Effect.sync(() => recovered.set(adapter.id, adapter)).pipe(
                Effect.andThen(registry.recover(adapter.id))
              ),
            { discard: true }
          )
        )
      )
    }).pipe(Effect.forkScoped)
    yield* Effect.logInfo('Run service provided', { plugin: ctx.name })
  })

export default setup
