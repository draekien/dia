import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { ReadGreeting } from '@dia-plugin/example/messages'
import { OrgService } from '@dia-plugin/org/service'
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
    const jobTitleCount = yield* Ref.make(Option.none<number>())
    yield* ctx.whenProvided([OrgService], ({ org }) =>
      Effect.gen(function* () {
        const jobTitles = yield* org.jobTitles
        yield* Ref.set(jobTitleCount, Option.some(jobTitles.length))
        yield* Effect.addFinalizer(() => Ref.set(jobTitleCount, Option.none()))
        yield* Effect.logInfo('Example plugin read the org', { jobTitles: jobTitles.length })
      })
    )
    yield* ctx.serve(ReadGreeting, () =>
      Ref.get(jobTitleCount).pipe(
        Effect.map(
          Option.match({
            onNone: () => `Hello from the ${ctx.name} plugin's host entry`,
            onSome: (count) =>
              `Hello from the ${ctx.name} plugin's host entry · ${count} job titles`
          })
        )
      )
    )
    yield* Effect.logInfo('Example plugin opened', { plugin: ctx.name })
  })

export default setup
