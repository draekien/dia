import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { Effect, Stream } from 'effect'
import { ReadGreeting } from './messages'

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
    yield* ctx.serve(ReadGreeting, () =>
      Effect.succeed(`Hello from the ${ctx.name} plugin's host entry`)
    )
    yield* Effect.logInfo('Example plugin opened', { plugin: ctx.name })
  })

export default setup
