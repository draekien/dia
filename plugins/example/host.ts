import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { ReadGreeting } from '@dia-plugin/example/messages'
import { IssuesKey } from '@dia-plugin/issues/service'
import { Effect, Option, Ref, Stream } from 'effect'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    let frames = 0
    yield* Effect.addFinalizer(() =>
      Effect.logInfo('Example plugin closed', { plugin: ctx.name, framesSeen: frames })
    )
    yield* ctx.events.pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          frames += 1
        })
      ),
      Effect.forkScoped
    )
    const objectiveCount = yield* Ref.make(Option.none<number>())
    yield* ctx.whenProvided([IssuesKey], ({ issues }) =>
      Effect.gen(function* () {
        const { objectives } = yield* issues.snapshot
        yield* Ref.set(objectiveCount, Option.some(objectives.length))
        yield* Effect.addFinalizer(() => Ref.set(objectiveCount, Option.none()))
        yield* Effect.logInfo('Example plugin read the issues', { objectives: objectives.length })
      })
    )
    yield* ctx.serve(ReadGreeting, () =>
      Ref.get(objectiveCount).pipe(
        Effect.map(
          Option.match({
            onNone: () => `Hello from the ${ctx.name} plugin's host entry`,
            onSome: (count) =>
              `Hello from the ${ctx.name} plugin's host entry · ${count} objectives`
          })
        )
      )
    )
    yield* Effect.logInfo('Example plugin opened', { plugin: ctx.name })
  })

export default setup
