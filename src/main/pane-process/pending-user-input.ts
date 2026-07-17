import type { PermissionResponse, QuestionResponse } from '@shared/domain/attention'
import { Deferred, Effect } from 'effect'

/**
 * A resolution the user supplied for a pending `UserInputRequest`: either a
 * `PermissionResponse` (for a tool `PermissionRequest`) or a `QuestionResponse`
 * (for a `ClarifyingQuestion`). The two are disjoint on `_tag`.
 */
export type UserInputResolution = PermissionResponse | QuestionResponse

/**
 * Owns the set of tool-permission / clarifying-question requests a pane session
 * has surfaced and is blocked awaiting. Register a request to obtain a
 * `Deferred` the `canUseTool` callback awaits; `resolve` completes it with the
 * user's answer; `drop` abandons every outstanding request (used when a
 * redirect supersedes them). Callers hold only the `Deferred` and the
 * `requestId`, never the registry's internal bookkeeping.
 */
export interface PendingUserInput {
  /**
   * Registers a new pending request under `requestId` and returns the `Deferred`
   * to await for its resolution. A later `register` with the same `requestId`
   * replaces the prior entry.
   */
  readonly register: (requestId: string) => Effect.Effect<Deferred.Deferred<UserInputResolution>>
  /**
   * Completes the request registered under `requestId` with `resolution` and
   * forgets it. Returns `true` if a matching pending request existed, `false`
   * if none did (already resolved, dropped, or never registered) — so a stale
   * or duplicate resolution is a no-op rather than an error or double-resolve.
   */
  readonly resolve: (requestId: string, resolution: UserInputResolution) => Effect.Effect<boolean>
  /**
   * Abandons every outstanding request without resolving its `Deferred`,
   * returning the `requestId`s that were dropped. The awaiting `canUseTool`
   * callbacks are left pending on purpose (the SDK drops them once a redirect
   * moves it on); a subsequent `resolve` for a dropped id returns `false`.
   */
  readonly drop: Effect.Effect<ReadonlyArray<string>>
  /** Whether a request is currently registered under `requestId`. */
  readonly isPending: (requestId: string) => Effect.Effect<boolean>
}

/**
 * Creates an empty {@link PendingUserInput} registry. Each instance owns its own
 * request set, so a fresh one gives tests full isolation; a pane session creates
 * one and shares it between its `canUseTool` callback and its inbound-message
 * handler.
 */
export const makePendingUserInput = (): PendingUserInput => {
  const pending = new Map<string, Deferred.Deferred<UserInputResolution>>()

  return {
    register: (requestId) =>
      Effect.map(Deferred.make<UserInputResolution>(), (deferred) => {
        pending.set(requestId, deferred)
        return deferred
      }),
    resolve: Effect.fn('PendingUserInput.resolve')(function* (
      requestId: string,
      resolution: UserInputResolution
    ) {
      const deferred = pending.get(requestId)
      if (deferred === undefined) return false
      pending.delete(requestId)
      yield* Deferred.succeed(deferred, resolution)
      return true
    }),
    drop: Effect.sync(() => {
      const requestIds = [...pending.keys()]
      pending.clear()
      return requestIds
    }),
    isPending: (requestId) => Effect.sync(() => pending.has(requestId))
  }
}
