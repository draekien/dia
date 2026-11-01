import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import type { EventFrame } from '@shared/ipc/rpc'
import { Effect, Result, Stream } from 'effect'
import {
  attentionChanged,
  INITIAL_RULE_STATE,
  type RuleStep,
  summaryChanged,
  workspaceChanged
} from './notification-rule'

const summaryStepOf = (frame: EventFrame): Result.Result<RuleStep, void> =>
  frame._tag !== 'ReloadHistory' && frame.event._tag === 'AgentSummaryChanged'
    ? Result.succeed(summaryChanged(frame.event.summary))
    : Result.failVoid

const ruleSteps = (ctx: HostPluginContext): Stream.Stream<RuleStep> =>
  Stream.mergeAll(
    [
      Stream.map(ctx.workspace, workspaceChanged),
      Stream.map(ctx.window.attended, attentionChanged),
      Stream.filterMap(ctx.events, summaryStepOf)
    ],
    { concurrency: 'unbounded' }
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* ruleSteps(ctx).pipe(
      Stream.mapAccum(
        () => INITIAL_RULE_STATE,
        (state, step) => step(state)
      ),
      Stream.runForEach((notification) =>
        Effect.logInfo('Notifying about an agent', { paneId: notification.paneId }).pipe(
          Effect.andThen(ctx.window.notify(notification))
        )
      ),
      Effect.forkScoped
    )
    yield* Effect.logInfo('Watching agents for notifications', { plugin: ctx.name })
  })

export default setup
