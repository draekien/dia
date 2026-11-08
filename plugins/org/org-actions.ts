import { AgentName, type PluginServices } from '@dia/plugin'
import {
  callHost,
  type PluginCallInvalid,
  type PluginNotServing,
  toast
} from '@dia/renderer-plugin'
import { RegistryContext } from '@effect/atom-react'
import { type Cause, Effect, type Option, Result, Schema } from 'effect'
import { type AsyncResult, type Atom, AtomRegistry } from 'effect/reactivity'
import type { Rpc } from 'effect/rpc'
import { useContext } from 'react'
import type { OrgSnapshot, WorkView } from './calls'
import {
  type HiredAgent,
  JOB_TITLE_NAME_MAX_LENGTH,
  type JobTitle,
  type JobTitleId,
  JobTitleName,
  WORK_TITLE_MAX_LENGTH,
  WorkTitle
} from './domain'
import type { OrgView } from './org-view'

/** Why a call to the org's host entry failed: its own error, or the plugin call failures. */
export type OrgCallFailure<R extends Rpc.AnyWithProps> =
  | Rpc.Error<R>
  | PluginNotServing
  | PluginCallInvalid

/** The atom holding the last `ReadOrg` result; both org pages read it. */
export type OrgAtom = Atom.Atom<
  AsyncResult.AsyncResult<OrgSnapshot, PluginNotServing | PluginCallInvalid>
>

/**
 * Sends one org call and returns its result. `target` names what the call changes, for the log.
 * On success, and on a `JobTitleNotFound` or `HireNotFound` (the screen is out of date), the
 * promise resolves only after `orgAtom` holds a snapshot read after the call.
 */
export type OrgCall = <R extends Rpc.AnyWithProps>(
  rpc: R,
  payload: Rpc.PayloadConstructor<R>,
  target: string
) => Promise<Result.Result<Rpc.Success<R>, OrgCallFailure<R>>>

/**
 * The atom following the org's `WatchWork` stream: `None` while the org host entry is not
 * serving, otherwise the latest `WorkView`. The Objectives page reads it.
 */
export type WorkAtom = Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<WorkView>, PluginCallInvalid | Cause.NoSuchElementError>
>

const STALE = new Set(['JobTitleNotFound', 'HireNotFound'])

/**
 * The org calls of the `org` renderer entry `ctx`, refreshing `orgAtom` after each change. Call
 * inside the app's `RegistryContext`.
 */
export const useOrgCall = (ctx: Pick<PluginServices, 'name'>, orgAtom: OrgAtom): OrgCall => {
  const registry = useContext(RegistryContext)
  return (rpc, payload, target) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo('Org change', { tag: rpc._tag, target })
        const result = yield* Effect.result(callHost(ctx, rpc, payload))
        const reason = Result.isFailure(result)
          ? (result.failure as { readonly _tag: string })._tag
          : undefined
        if (reason !== undefined) {
          yield* Effect.logWarning('Org change failed', { tag: rpc._tag, target, reason })
        }
        if (reason === undefined || STALE.has(reason)) {
          registry.refresh(orgAtom)
          yield* Effect.ignore(
            AtomRegistry.getResult(registry, orgAtom, { suspendOnWaiting: true })
          )
        }
        return result
      })
    )
}

/**
 * The text to show for a failure every org call can have: the plugin call failures' message, and
 * the copy for a job title or agent that is gone. Undefined for a call's own errors.
 */
export const commonFailureText = (failure: { readonly _tag: string }): string | undefined => {
  switch (failure._tag) {
    case 'JobTitleNotFound':
      return 'This job title was removed'
    case 'HireNotFound':
      return 'This agent was dismissed'
    case 'PluginNotServing':
    case 'PluginCallInvalid':
      return (failure as PluginNotServing | PluginCallInvalid).message
    default:
      return undefined
  }
}

/** Shows an error toast titled `title` with the reason of `failure`. */
export const toastFailure = (title: string, failure: { readonly _tag: string }): void => {
  toast.add({ title, description: commonFailureText(failure) ?? failure._tag, type: 'error' })
}

/** The name of `agent`'s job title in `jobTitles`, or undefined when `jobTitles` lacks it. */
export const jobTitleName = (
  agent: HiredAgent,
  jobTitles: ReadonlyArray<JobTitle>
): string | undefined => jobTitles.find((jobTitle) => jobTitle.id === agent.jobTitleId)?.name

/** The name the org screens show for `agent`: its name, or `Unnamed <job title name>`. */
export const agentName = (agent: HiredAgent, jobTitles: ReadonlyArray<JobTitle>): string =>
  agent.name ?? `Unnamed ${jobTitleName(agent, jobTitles) ?? 'agent'}`

const decodeJobTitleName = Schema.decodeUnknownResult(JobTitleName)
const decodeAgentName = Schema.decodeUnknownResult(AgentName)
const decodeWorkTitle = Schema.decodeUnknownResult(WorkTitle)

/**
 * Reads a job title name field: the trimmed name, or the message to show beside the field when it
 * is blank or longer than {@link JOB_TITLE_NAME_MAX_LENGTH}.
 */
export const readJobTitleName = (text: string): Result.Result<JobTitleName, string> =>
  Result.mapError(decodeJobTitleName(text.trim()), () =>
    text.trim() === '' ? 'Enter a name' : `Use at most ${JOB_TITLE_NAME_MAX_LENGTH} characters`
  )

/** A new random id for an objective or task the user creates; call it in a React handler. */
export const newId = (): string =>
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- a React handler outside any Effect; the id only has to be unique.
  crypto.randomUUID()

/**
 * Reads an objective or task title field: the trimmed title, or the message to show beside the
 * field when it is blank or longer than {@link WORK_TITLE_MAX_LENGTH}.
 */
export const readWorkTitle = (text: string): Result.Result<WorkTitle, string> =>
  Result.mapError(decodeWorkTitle(text.trim()), () =>
    text.trim() === '' ? 'Enter a title' : `Use at most ${WORK_TITLE_MAX_LENGTH} characters`
  )

/**
 * Reads an agent name field: the trimmed name, null when blank (an unnamed agent), or the message
 * to show beside the field when it is longer than `AgentName` allows.
 */
export const readAgentName = (text: string): Result.Result<AgentName | null, string> =>
  text.trim() === ''
    ? Result.succeed(null)
    : Result.mapError(decodeAgentName(text.trim()), () => 'Use a shorter name')

/**
 * What every Org sub-page gets: the snapshot to draw, the org calls, a way to show another view,
 * and a way to open the Hire dialog with `jobTitleId` chosen, or none chosen when null.
 */
export interface OrgScreen {
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
  readonly show: (view: OrgView) => void
  readonly openHire: (jobTitleId: JobTitleId | null) => void
}
