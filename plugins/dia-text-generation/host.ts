import { type HostPluginContext, type PluginSetup, RunEventsKey } from '@dia/plugin'
import { AgentAdaptersKey } from '@dia-plugin/dia-agent-adapters/registry'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Deferred, Effect, Option, Stream, SubscriptionRef } from 'effect'
import { startAutoTitle } from './auto-title'
import { FollowTextGenerationSettings, RegenerateTitle, SetTextGenerationSettings } from './calls'
import { regenerateTitle } from './regenerate'
import { makeTitleSettings } from './settings'
import { makeTitleWriter } from './writer'

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

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const settings = yield* makeTitleSettings(ctx.dataDir)

    yield* ctx.serve(FollowTextGenerationSettings, () => settings.follow)
    yield* ctx.serve(SetTextGenerationSettings, ({ settings: next }) => settings.set(next))

    yield* ctx.whenProvided([AgentAdaptersKey, RunEventsKey], ({ agentAdapters, runEvents }) =>
      Effect.gen(function* () {
        const writer = makeTitleWriter({
          settings: settings.current,
          adapters: Stream.runHead(agentAdapters.adapters).pipe(
            Effect.map(Option.getOrElse(() => []))
          )
        })
        const deps = { snapshot: runEvents.snapshot, writer, rename: ctx.renameTab }
        const workspace = yield* followWorkspace(ctx)
        yield* startAutoTitle({
          ...deps,
          events: runEvents.subscribe,
          workspace: SubscriptionRef.get(workspace)
        })
        yield* ctx.serve(RegenerateTitle, ({ paneId }) => regenerateTitle(deps, paneId))
      })
    )
    yield* Effect.logInfo('Text generation set up', { plugin: ctx.name })
  }).pipe(Effect.provide(NodeServices.layer))

export default setup
