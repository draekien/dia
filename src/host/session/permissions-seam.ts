import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type {
  PermissionResponse,
  PlanReviewResponse,
  QuestionResponse
} from '@shared/domain/attention'
import type { PermissionMode } from '@shared/domain/pane'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Data, Deferred, Effect, Option, Predicate, Schema } from 'effect'

/**
 * Service key under which the essential `permissions` plugin provides a
 * `() => PendingUserInput` factory.
 */
export const PENDING_USER_INPUT_KEY = 'pendingUserInput'

/**
 * Service key under which the essential `permissions` plugin provides a
 * `() => Effect<PermissionModeController>` factory.
 */
export const PERMISSION_MODE_CONTROLLER_KEY = 'permissionModeController'

/**
 * A pane-local marker that a pending request was abandoned because the user sent
 * a new message before answering. It is not a `@shared/domain/attention`
 * response — it never leaves the Host — but resolving a `Deferred` with
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
 * The slice of the Agent SDK's live `Query` the controller drives: just the
 * ability to change a running session's permission mode. Narrowed so a fake is
 * trivial to supply in tests.
 */
export type LivePermissionQuery = Pick<Query, 'setPermissionMode'>

/**
 * Owns a pane session's live permission-mode state and applies changes to the
 * running Agent SDK query. It tracks the current mode plus the mode held before
 * the pane last switched into `plan`, so an approved plan can be restored to
 * whatever the pane was doing beforehand. `seed` it whenever a (re)started query
 * begins, `attachQuery` the live `Query` once it exists, then route inbound
 * mode changes through `applyMode` and plan resolutions through `resolvePlan`.
 */
export interface PermissionModeController {
  /**
   * Binds the live `Query` whose mode {@link PermissionModeController.applyMode}
   * will change. Call once per (re)started session, after the query is created.
   */
  readonly attachQuery: (query: LivePermissionQuery) => Effect.Effect<void>
  /**
   * Records the mode a freshly (re)started session begins in, without touching
   * the query. Call from session startup with `config.permissionMode` so the
   * controller's current mode matches the options the query was created with.
   */
  readonly seed: (mode: PermissionMode) => Effect.Effect<void>
  /** The mode the session is currently in, or `None` before the first `seed`. */
  readonly currentMode: Effect.Effect<Option.Option<PermissionMode>>
  /**
   * Applies `mode` to the live query and updates the current mode. A no-op when
   * `mode` equals the current mode or before any `seed`. Switching into `plan`
   * first records the mode being left so {@link PermissionModeController.resolvePlan}
   * can restore it. A failed `setPermissionMode` is logged and swallowed.
   */
  readonly applyMode: (mode: PermissionMode) => Effect.Effect<void>
  /**
   * Resolves a plan review. On approval, restores the mode held before the pane
   * switched into `plan` (applying it to the live query) and returns it as
   * `Some` so the caller can broadcast the change; returns `None` when rejected
   * or when no pre-plan mode was recorded, in which case the mode is left as-is.
   */
  readonly resolvePlan: (approved: boolean) => Effect.Effect<Option.Option<PermissionMode>>
}

/**
 * The services one agent session uses to gate tool calls. `available` is `true` when the
 * `permissions` plugin provided both; when it is `false` the other two do nothing and the caller
 * must deny every tool call.
 */
export interface SessionPermissions {
  readonly pendingUserInput: PendingUserInput
  readonly modeController: PermissionModeController
  readonly available: boolean
}

const unavailablePendingUserInput: PendingUserInput = {
  register: () => Deferred.make<UserInputResolution>(),
  resolve: () => Effect.succeed(false),
  interruptAll: Effect.succeed([]),
  drop: Effect.succeed([]),
  isPending: () => Effect.succeed(false)
}

const unavailableModeController: PermissionModeController = {
  attachQuery: () => Effect.void,
  seed: () => Effect.void,
  currentMode: Effect.succeed(Option.none()),
  applyMode: (mode) =>
    Effect.logWarning('Cannot set permission mode; the permissions plugin is not loaded', { mode }),
  resolvePlan: () => Effect.succeed(Option.none())
}

class PermissionsPluginError extends Data.TaggedError('PermissionsPluginError')<{
  readonly cause: unknown
}> {}

const createFromPlugin = <A>(
  registry: Pick<PluginRegistry, 'inject'>,
  key: string,
  build: (factory: () => unknown) => Effect.Effect<A, PermissionsPluginError>
): Effect.Effect<Option.Option<A>> =>
  Effect.gen(function* () {
    const provided = yield* registry.inject(key)
    if (Option.isNone(provided)) {
      yield* Effect.logWarning('No plugin provides a permissions service', { key })
      return Option.none<A>()
    }
    if (!Predicate.isFunction(provided.value)) {
      yield* Effect.logWarning('A permissions service is not a function', {
        key,
        received: typeof provided.value
      })
      return Option.none<A>()
    }
    const factory = provided.value as () => unknown
    return yield* build(factory).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logError('A permissions service failed to start', { key, cause: error.cause }).pipe(
          Effect.as(Option.none<A>())
        )
      )
    )
  })

/**
 * Creates the permission services for one agent session from the factories the loaded
 * `permissions` plugin provides under {@link PENDING_USER_INPUT_KEY} and
 * {@link PERMISSION_MODE_CONTROLLER_KEY}. When either is missing, is not a function or throws,
 * the result has `available: false` and inert services, so the caller denies tool calls instead
 * of asking nobody. Call it once per session; a plugin reload applies from the next call.
 */
export const makeSessionPermissions = Effect.fn('SessionPermissions.make')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const pending = yield* createFromPlugin(registry, PENDING_USER_INPUT_KEY, (factory) =>
    Effect.try({
      try: () => factory() as PendingUserInput,
      catch: (cause) => new PermissionsPluginError({ cause })
    })
  )
  const controller = yield* createFromPlugin(registry, PERMISSION_MODE_CONTROLLER_KEY, (factory) =>
    Effect.try({
      try: () => factory() as Effect.Effect<PermissionModeController>,
      catch: (cause) => new PermissionsPluginError({ cause })
    }).pipe(Effect.flatten)
  )
  if (Option.isNone(pending) || Option.isNone(controller)) {
    yield* Effect.logError(
      'The permissions plugin is unavailable; every tool call in this session will be denied'
    )
    return {
      pendingUserInput: unavailablePendingUserInput,
      modeController: unavailableModeController,
      available: false
    } satisfies SessionPermissions
  }
  return {
    pendingUserInput: pending.value,
    modeController: controller.value,
    available: true
  } satisfies SessionPermissions
})
