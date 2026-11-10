import type { PluginServices } from '@dia/plugin'
import { callHost, type PluginCallInvalid, type PluginNotServing } from '@dia/renderer-plugin'
import { type Cause, Effect, type Option, Result, Schema } from 'effect'
import type { AsyncResult, Atom } from 'effect/reactivity'
import type { Rpc } from 'effect/rpc'
import type { IssuesView } from './calls'
import { type AssigneeGroup, type AssigneeRef, WORK_TITLE_MAX_LENGTH, WorkTitle } from './domain'

/** Why a call to the issues host entry failed: its own error, or the plugin call failures. */
export type IssuesCallFailure<R extends Rpc.AnyWithProps> =
  | Rpc.Error<R>
  | PluginNotServing
  | PluginCallInvalid

/**
 * Sends one issues call and returns its result. `target` names what the call changes, for the log.
 * The page follows `WatchIssues`, so the change shows when the host publishes it.
 */
export type IssuesCall = <R extends Rpc.AnyWithProps>(
  rpc: R,
  payload: Rpc.PayloadConstructor<R>,
  target: string
) => Promise<Result.Result<Rpc.Success<R>, IssuesCallFailure<R>>>

/**
 * The atom following the issues `WatchIssues` stream: `None` while the issues host entry is not
 * serving, otherwise the latest `IssuesView`.
 */
export type IssuesAtom = Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<IssuesView>, PluginCallInvalid | Cause.NoSuchElementError>
>

/** The issues calls of the `issues` renderer entry `ctx`. */
export const issuesCall =
  (ctx: Pick<PluginServices, 'name'>): IssuesCall =>
  (rpc, payload, target) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo('Issues change', { tag: rpc._tag, target })
        const result = yield* Effect.result(callHost(ctx, rpc, payload))
        if (Result.isFailure(result)) {
          yield* Effect.logWarning('Issues change failed', {
            tag: rpc._tag,
            target,
            reason: (result.failure as { readonly _tag: string })._tag
          })
        }
        return result
      })
    )

/**
 * The text to show for a failed issues call: the copy for each issues error, and the plugin call
 * failures' message.
 */
export const failureText = (failure: { readonly _tag: string }): string => {
  switch (failure._tag) {
    case 'IssueNotFound':
      return 'This issue was removed'
    case 'IssueNotAssignable':
      return 'This issue has started or is closed'
    case 'IssueNotStarted':
      return 'This issue has not started'
    case 'IssueNotInTriage':
      return 'This issue is no longer in Triage'
    case 'ObjectiveNotFound':
      return 'This objective was removed'
    case 'ProjectNotFound':
      return 'This project was removed'
    case 'AssigneeNotFound':
      return 'This assignee is no longer listed'
    case 'PluginNotServing':
    case 'PluginCallInvalid':
      return (failure as PluginNotServing | PluginCallInvalid).message
    default:
      return failure._tag
  }
}

/** A new random id for an objective or issue the user creates; call it in a React handler. */
export const newId = (): string =>
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- a React handler outside any Effect; the id only has to be unique.
  crypto.randomUUID()

const decodeWorkTitle = Schema.decodeUnknownResult(WorkTitle)

/**
 * Reads an objective or issue title field: the trimmed title, or the message to show beside the
 * field when it is blank or longer than {@link WORK_TITLE_MAX_LENGTH}.
 */
export const readWorkTitle = (text: string): Result.Result<WorkTitle, string> =>
  Result.mapError(decodeWorkTitle(text.trim()), () =>
    text.trim() === '' ? 'Enter a title' : `Use at most ${WORK_TITLE_MAX_LENGTH} characters`
  )

/**
 * The name to show for `assignee` against `providers`: `none` when null, the listed name, `Removed
 * assignee` when its provider is held but does not list it, and `<provider> not loaded` when its
 * provider is not held.
 */
export const assigneeLabel = (
  assignee: AssigneeRef | null,
  providers: ReadonlyArray<AssigneeGroup>,
  none: string
): string => {
  if (assignee === null) return none
  const group = providers.find((provider) => provider.provider === assignee.provider)
  if (group === undefined) return `${assignee.provider} not loaded`
  return group.assignees.find((listed) => listed.id === assignee.id)?.name ?? 'Removed assignee'
}
