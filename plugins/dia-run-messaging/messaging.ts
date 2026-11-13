import {
  type DiaTool,
  type DiaToolResult,
  diaTool,
  type RunEvents,
  type RunInfo,
  type Runs,
  type ToolScope
} from '@dia/plugin'
import { Data, Deferred, Duration, Effect, Exit, Option, Schema, Scope, Stream } from 'effect'
import {
  type Finish,
  finishOf,
  isSettled,
  type RunStep,
  replyOf,
  timesSeen,
  watchRun
} from './turns'

const SEEN_LIMIT = Duration.seconds(30)
const DEFAULT_WAIT_SECONDS = 300
const MAX_WAIT_SECONDS = 1800

const result = (text: string, isError = false): DiaToolResult => ({ text, isError })

const replyText = (reply: string) => (reply === '' ? '(no reply)' : reply)

const finishedText = (runId: string, finish: Finish) =>
  `Run ${runId} ${finish.ending}. Its last reply:\n\n${replyText(finish.reply)}`

const deliveryText = (runId: string, finish: Finish) =>
  finish.ending === 'completed'
    ? `Run ${runId} completed the task you delegated. Its reply:\n\n${replyText(finish.reply)}`
    : `Run ${runId} ${finish.ending} before completing the task you delegated. Its last reply:\n\n${replyText(finish.reply)}`

class ToolRefusal extends Data.TaggedError('ToolRefusal')<{ readonly text: string }> {}

const refused = (text: string) => Effect.fail(new ToolRefusal({ text }))

const callerOf = (scope: ToolScope) =>
  scope.runId === undefined
    ? refused('Only a dia run can call this tool.')
    : Effect.succeed(scope.runId)

const refusalToResult = <R>(effect: Effect.Effect<DiaToolResult, ToolRefusal, R>) =>
  effect.pipe(
    Effect.catch((refusal) =>
      Effect.logInfo('Refused a run messaging call', { reason: refusal.text }).pipe(
        Effect.as(result(refusal.text, true))
      )
    )
  )

/**
 * The run messaging tools over `runs` and `runEvents` (`docs/designs/dia-run-messaging.md`):
 * `run_send`, `run_wait` and `run_delegate`, each for a run scope. Register them with
 * `when: isRunScope`. A delegated run's reply is delivered from a fiber in the calling scope, so
 * closing that scope drops deliveries still waiting.
 */
export const makeMessagingTools = Effect.fnUntraced(function* (
  runs: Runs,
  runEvents: RunEvents
): Effect.fn.Return<ReadonlyArray<DiaTool>, never, Scope.Scope> {
  const deliveries = yield* Scope.Scope

  const runInfo = (runId: string) =>
    Effect.map(runs.list, (list) => Option.fromUndefinedOr(list.find((run) => run.runId === runId)))

  const target = Effect.fnUntraced(function* (caller: string, runId: string) {
    if (runId === caller) return yield* refused('A run cannot message or wait for itself.')
    const info = yield* runInfo(runId)
    if (Option.isNone(info)) return yield* refused(`No run has the id ${runId}.`)
    if (info.value.status === 'archived') return yield* refused(`Run ${runId} is archived.`)
    return info.value
  })

  const send = Effect.fn('RunMessaging.send')(function* (
    input: { readonly runId: string; readonly text: string },
    scope: ToolScope
  ) {
    const caller = yield* callerOf(scope)
    yield* target(caller, input.runId)
    const message = `Message from run ${caller}:\n\n${input.text}`
    const follow = yield* watchRun(runEvents)
    const steps = yield* follow(input.runId)
    yield* runs.send(input.runId, message, 'queue')
    if (!(yield* runs.isLive(input.runId))) {
      return yield* refused(`Run ${input.runId} could not be opened; the message was not sent.`)
    }
    const seen = yield* steps.pipe(
      Stream.mapAccum(
        () => Option.none<number>(),
        (before, step) => {
          const count = timesSeen(step.state, message)
          const baseline = Option.getOrElse(before, () => count)
          return [Option.some(baseline), [count > baseline]] as const
        }
      ),
      Stream.filter((isNew) => isNew),
      Stream.runHead,
      Effect.timeoutOption(SEEN_LIMIT)
    )
    yield* Effect.logInfo('Sent a message to a run', {
      from: caller,
      to: input.runId,
      seen: Option.isSome(seen)
    })
    return Option.isSome(seen)
      ? result(`Sent to run ${input.runId}.`)
      : result(`Sent to run ${input.runId}; it has not shown the message yet.`)
  }, Effect.scoped)

  const timedOut = Effect.fnUntraced(function* (runId: string) {
    const { state } = yield* runEvents.snapshot(runId)
    yield* Effect.logWarning('A run wait timed out', { runId, attention: state.attention._tag })
    return state.attention._tag === 'AwaitingPermission'
      ? result(`Run ${runId} waits for the user to answer a request.`)
      : result(`Run ${runId} is still working; call run_wait again.`)
  })

  const wait = Effect.fn('RunMessaging.wait')(function* (
    input: { readonly runId: string; readonly timeoutSeconds?: number },
    scope: ToolScope
  ) {
    const caller = yield* callerOf(scope)
    const info: RunInfo = yield* target(caller, input.runId)
    if (!info.live) {
      yield* runEvents.seed(input.runId)
      const { state } = yield* runEvents.snapshot(input.runId)
      return result(
        `Run ${input.runId} is not running. Its last reply:\n\n${replyText(replyOf(state))}`
      )
    }
    const follow = yield* watchRun(runEvents)
    const outcome = yield* (yield* follow(input.runId)).pipe(
      Stream.map((step, index) =>
        index === 0 && isSettled(step.state)
          ? Option.some(
              `Run ${input.runId} is idle. Its last reply:\n\n${replyText(replyOf(step.state))}`
            )
          : Option.map(finishOf(step), (finish) => finishedText(input.runId, finish))
      ),
      Stream.filter(Option.isSome),
      Stream.runHead,
      Effect.timeoutOption(Duration.seconds(input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS))
    )
    yield* Effect.logInfo('Waited for a run', { by: caller, runId: input.runId })
    return yield* Option.match(Option.flatten(Option.flatten(outcome)), {
      onNone: () => timedOut(input.runId),
      onSome: (text) => Effect.succeed(result(text))
    })
  }, Effect.scoped)

  const deliver = Effect.fnUntraced(function* (
    caller: string,
    runId: string,
    steps: Stream.Stream<RunStep>,
    seen: Deferred.Deferred<void>,
    task: string
  ) {
    const finish = yield* steps.pipe(
      Stream.tap((step) =>
        timesSeen(step.state, task) > 0 ? Deferred.succeed(seen, undefined) : Effect.void
      ),
      Stream.filterEffect(() => Deferred.isDone(seen)),
      Stream.map(finishOf),
      Stream.filter(Option.isSome),
      Stream.runHead
    )
    if (Option.isNone(finish)) {
      return yield* Effect.logWarning('A delegated run ended its log before finishing', { runId })
    }
    yield* runs.send(caller, deliveryText(runId, finish.value.value), 'queue')
    yield* Effect.logInfo('Delivered a delegated run reply', {
      to: caller,
      from: runId,
      ending: finish.value.value.ending
    })
  })

  const delegate = Effect.fn('RunMessaging.delegate')(function* (
    input: { readonly task: string },
    scope: ToolScope
  ) {
    const caller = yield* callerOf(scope)
    const info = yield* runInfo(caller)
    if (Option.isNone(info)) return yield* refused(`Run ${caller} has no stored settings to copy.`)
    const subscription = yield* Scope.fork(deliveries)
    const seen = yield* Deferred.make<void>()
    const runId = yield* Effect.gen(function* () {
      const follow = yield* watchRun(runEvents).pipe(Scope.provide(subscription))
      const runId = yield* runs.start({
        cwd: info.value.cwd,
        model: info.value.model,
        thinkingLevel: info.value.thinkingLevel,
        permissionMode: info.value.permissionMode,
        text: input.task
      })
      yield* deliver(caller, runId, yield* follow(runId), seen, input.task).pipe(
        Effect.onInterrupt(() =>
          Effect.logWarning('Dropped a delegated run delivery', { to: caller, from: runId })
        ),
        Effect.ensuring(Scope.close(subscription, Exit.void)),
        Effect.forkIn(deliveries)
      )
      return runId
    }).pipe(Effect.onError(() => Scope.close(subscription, Exit.void)))
    const shown = yield* Deferred.await(seen).pipe(Effect.timeoutOption(SEEN_LIMIT))
    yield* Effect.logInfo('Delegated a task to a new run', {
      from: caller,
      runId,
      seen: Option.isSome(shown)
    })
    return result(
      `Started run ${runId} in ${info.value.cwd}. Its reply arrives as your next message; end your turn to wait for it.`
    )
  })

  return [
    diaTool({
      name: 'run_send',
      description:
        'Send a message to another dia run. An idle run starts a turn with it; a working run gets it when its turn ends. Returns once the run shows the message. Use run_wait to read its answer.',
      input: Schema.Struct({
        runId: Schema.NonEmptyString.annotate({ description: 'The id of the run to message.' }),
        text: Schema.NonEmptyString.annotate({ description: 'The message.' })
      }),
      run: (input, scope) => refusalToResult(send(input, scope))
    }),
    diaTool({
      name: 'run_wait',
      description:
        'Wait until a dia run has finished its work and return its last reply. An idle run returns at once. On timeout, call again. Do not wait for a run you delegated to: its reply arrives as your next message.',
      input: Schema.Struct({
        runId: Schema.NonEmptyString.annotate({ description: 'The id of the run to wait for.' }),
        timeoutSeconds: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_WAIT_SECONDS })).annotate({
            description: `Seconds to wait before returning; default ${DEFAULT_WAIT_SECONDS}.`
          })
        )
      }),
      run: (input, scope) => refusalToResult(wait(input, scope))
    }),
    diaTool({
      name: 'run_delegate',
      description:
        'Start a new dia run in your working directory, with your model and permission mode, and give it a task. It sees only the task, not your conversation. Its reply arrives as your next message once it finishes; end your turn to wait for it.',
      input: Schema.Struct({
        task: Schema.NonEmptyString.annotate({
          description: 'The complete task; the new run sees nothing else.'
        })
      }),
      run: (input, scope) => refusalToResult(delegate(input, scope))
    })
  ]
})
