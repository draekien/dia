import { type HostPluginContext, type PluginSetup, type RunEvents, RunEventsKey } from '@dia/plugin'
import { type AgentAdapters, AgentAdaptersKey } from '@dia-plugin/dia-agent-adapters/registry'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Option, Ref, Stream } from 'effect'
import { startAutoTitle } from './auto-title'
import {
  FollowTextGenerationSettings,
  RegenerateTitle,
  SetTextGenerationSettings,
  TitleNotGenerated
} from './calls'
import { regenerateTitle } from './regenerate'
import { makeTitleSettings } from './settings'
import { makeTitleWriter } from './writer'

const provided = <A>(ref: Ref.Ref<Option.Option<A>>, name: string, value: A) =>
  Effect.acquireRelease(Ref.set(ref, Option.some(value)), () =>
    Ref.set(ref, Option.none()).pipe(
      Effect.andThen(Effect.logInfo('A service this plugin reads was withdrawn', { service: name }))
    )
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const settings = yield* makeTitleSettings(ctx.dataDir)
    const adapters = yield* Ref.make(Option.none<AgentAdapters>())
    const runEvents = yield* Ref.make(Option.none<RunEvents>())

    const writer = makeTitleWriter({
      settings: settings.current,
      adapters: Ref.get(adapters).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed([]),
            onSome: (registry) =>
              Stream.runHead(registry.adapters).pipe(Effect.map(Option.getOrElse(() => [])))
          })
        )
      )
    })

    yield* ctx.whenProvided([AgentAdaptersKey], ({ agentAdapters }) =>
      provided(adapters, 'agentAdapters', agentAdapters)
    )
    yield* ctx.whenProvided([RunEventsKey], ({ runEvents: events }) =>
      Effect.gen(function* () {
        yield* provided(runEvents, 'runEvents', events)
        yield* startAutoTitle({
          events: events.subscribe,
          snapshot: events.snapshot,
          workspace: ctx.workspace,
          writer,
          rename: ctx.renameTab
        })
      })
    )

    yield* ctx.serve(FollowTextGenerationSettings, () => settings.follow)
    yield* ctx.serve(SetTextGenerationSettings, ({ settings: next }) => settings.set(next))
    yield* ctx.serve(RegenerateTitle, ({ paneId }) =>
      Effect.gen(function* () {
        const events = yield* Ref.get(runEvents)
        if (Option.isNone(events)) {
          return yield* new TitleNotGenerated({ reason: 'The run event log is not loaded' })
        }
        yield* regenerateTitle(
          { snapshot: events.value.snapshot, writer, rename: ctx.renameTab },
          paneId
        )
      })
    )
    yield* Effect.logInfo('Text generation set up', { plugin: ctx.name })
  }).pipe(Effect.provide(NodeServices.layer))

export default setup
