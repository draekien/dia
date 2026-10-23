import type {
  PermissionResponse,
  PlanReviewResponse,
  QuestionResponse
} from '@shared/domain/attention'
import { Deferred, Effect, Schema } from 'effect'

/**
 * A pane-local marker that a pending request was abandoned because the user sent
 * a new message before answering. It is not a `@shared/domain/attention`
 * response — it never leaves the pane process — but resolving a `Deferred` with
 * it (rather than dropping it silently) lets `toPermissionResult` deny the stale
 * tool call with `interrupt: true`, which both releases the blocked `canUseTool`
 * and aborts the superseded turn. Construct with `Superseded.make({})`.
 */
export const Superseded = Schema.TaggedStruct('Superseded', {})
export type Superseded = typeof Superseded.Type

/**
 * A resolution supplied for a pending `UserInputRequest`: the user's
 * `PermissionResponse` (for a tool `PermissionRequest`), `QuestionResponse`
 * (for a `ClarifyingQuestion`), or `PlanReviewResponse` (for a `PlanReview`), or
 * a pane-local {@link Superseded} marker when a new message abandoned the ask.
 * All are disjoint on `_tag`.
 */
export type UserInputResolution =
  | PermissionResponse
  | QuestionResponse
  | PlanReviewResponse
  | Superseded

/**
 * Owns the set of tool-permission / clarifying-question requests a pane session
 * has surfaced and is blocked awaiting. Register a request to obtain a
 * `Deferred` the `canUseTool` callback awaits; `resolve` completes it with the
 * user's answer; `interruptAll` resolves every outstanding request with
 * {@link Superseded} (used when a new message supersedes them, so the blocked
 * callbacks unblock and abort their turns); `drop` abandons every outstanding
 * request without resolving it (used on teardown/restart paths where the query
 * is replaced). Callers hold only the `Deferred` and the `requestId`, never the
 * registry's internal bookkeeping.
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
   * Resolves every outstanding request with {@link Superseded} and clears the
   * registry, returning the `requestId`s that were resolved. Each awaiting
   * `canUseTool` callback unblocks and (via `toPermissionResult`) denies its
   * tool call with `interrupt: true`, aborting the superseded turn. A subsequent
   * `resolve` for a superseded id returns `false`.
   */
  readonly interruptAll: Effect.Effect<ReadonlyArray<string>>
  /**
   * Abandons every outstanding request without resolving its `Deferred`,
   * returning the `requestId`s that were dropped. The awaiting `canUseTool`
   * callbacks are left pending on purpose (the query is being torn down and
   * replaced, so the leaked promise dies with it); a subsequent `resolve` for a
   * dropped id returns `false`.
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
    interruptAll: Effect.gen(function* () {
      const entries = [...pending.entries()]
      pending.clear()
      const superseded = Superseded.make({})
      for (const [, deferred] of entries) yield* Deferred.succeed(deferred, superseded)
      return entries.map(([requestId]) => requestId)
    }),
    drop: Effect.sync(() => {
      const requestIds = [...pending.keys()]
      pending.clear()
      return requestIds
    }),
    isPending: (requestId) => Effect.sync(() => pending.has(requestId))
  }
}
