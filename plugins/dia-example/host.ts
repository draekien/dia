import { diaTool, type HostPluginContext, isRunScope, type PluginSetup } from '@dia/plugin'
import { ReadGreeting } from '@dia-plugin/dia-example/messages'
import { IssuesKey } from '@dia-plugin/dia-issues/service'
import { type Tools, ToolsKey } from '@dia-plugin/dia-tools/tools'
import { Effect, Option, Ref, Schema, Stream } from 'effect'

const approvalTool = (tools: Tools) =>
  diaTool({
    name: 'example_approval',
    description:
      "Ask the user to approve an example change in dia's window, and report whether they approved it. It changes nothing; it shows how a dia tool asks for approval.",
    input: Schema.Struct({
      change: Schema.NonEmptyString.annotate({ description: 'The change to show the user.' })
    }),
    run: Effect.fn('ExampleApproval.run')(function* (input, scope) {
      const answer = yield* tools.requestApproval(scope, {
        title: 'Apply an example change',
        before: '',
        after: input.change
      })
      yield* Effect.logInfo('Example approval answered', { answer })
      return {
        text:
          answer === 'approved' ? 'The user approved the change.' : 'The user declined the change.',
        isError: false
      }
    })
  })

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
    yield* ctx.whenProvided([ToolsKey], ({ tools }) =>
      tools
        .register(approvalTool(tools), { when: isRunScope })
        .pipe(Effect.tap(() => Effect.logInfo('Example approval tool registered')))
    )
    yield* ctx.serve(ReadGreeting, () =>
      Ref.get(objectiveCount).pipe(
        Effect.map(
          Option.match({
            onNone: () => `Hello from the ${ctx.name} plugin's host entry`,
            onSome: (count) => `Hello from the ${ctx.name} plugin's host entry, ${count} objectives`
          })
        )
      )
    )
    yield* Effect.logInfo('Example plugin opened', { plugin: ctx.name })
  })

export default setup
