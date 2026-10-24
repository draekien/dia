import type {
  PermissionResponse,
  PlanReviewResponse,
  QuestionResponse
} from '@shared/domain/attention'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Data, type Deferred, Effect, Option, Predicate, Schema } from 'effect'

/**
 * Service key under which the essential `permissions` plugin provides a
 * `() => PendingUserInput` factory.
 */
export const PENDING_USER_INPUT_KEY = 'pendingUserInput'

/**
 * A pane-local marker that a pending request was abandoned because the user sent
 * a new message before answering. It is not a `@shared/domain/attention`
 * response — it never leaves the Host — but resolving a `Deferred` with
 * it (rather than dropping it silently) lets the agent backend deny the stale
 * tool call and abort the superseded turn. Construct with `Superseded.make({})`.
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
 * `Deferred` the agent backend awaits; `resolve` completes it with the
 * user's answer; `interruptAll` resolves every outstanding request with
 * {@link Superseded} (used when a new message supersedes them, so the blocked
 * callbacks unblock and abort their turns); `drop` abandons every outstanding
 * request without resolving it (used on teardown/restart paths where the agent
 * session is replaced). Callers hold only the `Deferred` and the `requestId`, never the
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
   * registry, returning the `requestId`s that were resolved. A subsequent
   * `resolve` for a superseded id returns `false`.
   */
  readonly interruptAll: Effect.Effect<ReadonlyArray<string>>
  /**
   * Abandons every outstanding request without resolving its `Deferred`,
   * returning the `requestId`s that were dropped. The awaiting callers are left
   * pending on purpose (the agent session is being torn down and replaced); a
   * subsequent `resolve` for a dropped id returns `false`.
   */
  readonly drop: Effect.Effect<ReadonlyArray<string>>
  /** Whether a request is currently registered under `requestId`. */
  readonly isPending: (requestId: string) => Effect.Effect<boolean>
}

class PendingUserInputPluginError extends Data.TaggedError('PendingUserInputPluginError')<{
  readonly cause: unknown
}> {}

/**
 * Creates a fresh {@link PendingUserInput} for one agent session from the factory the loaded
 * `permissions` plugin provides under {@link PENDING_USER_INPUT_KEY}. Returns `None`, after
 * logging why, when no plugin provides the key, the value is not a function, or the factory
 * throws; the caller must then deny every tool call. Call it once per session; each call creates
 * a new registry, and a plugin reload applies from the next call.
 */
export const resolvePendingUserInput = Effect.fn('PendingUserInput.resolve')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const provided = yield* registry.inject(PENDING_USER_INPUT_KEY)
  if (Option.isNone(provided)) {
    yield* Effect.logError(
      'The permissions plugin is not loaded; every tool call in this session will be denied'
    )
    return Option.none<PendingUserInput>()
  }
  if (!Predicate.isFunction(provided.value)) {
    yield* Effect.logError('The pendingUserInput service is not a function; denying tool calls', {
      received: typeof provided.value
    })
    return Option.none<PendingUserInput>()
  }
  const factory = provided.value as () => PendingUserInput
  return yield* Effect.try({
    try: () => Option.some(factory()),
    catch: (cause) => new PendingUserInputPluginError({ cause })
  }).pipe(
    Effect.catch((error) =>
      Effect.logError('The pendingUserInput factory threw; denying tool calls', {
        cause: error.cause
      }).pipe(Effect.as(Option.none<PendingUserInput>()))
    )
  )
})
