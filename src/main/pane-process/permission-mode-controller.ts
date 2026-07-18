import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode } from '@shared/domain/pane'
import { Effect, Option, Ref } from 'effect'

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
 * whatever the pane was doing beforehand. Create one per session with
 * {@link makePermissionModeController}; `seed` it whenever a (re)started query
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
 * Creates a fresh {@link PermissionModeController} with no query bound and no
 * mode seeded. Each instance owns its own state, giving tests full isolation.
 */
export const makePermissionModeController: Effect.Effect<PermissionModeController> = Effect.gen(
  function* () {
    const queryRef = yield* Ref.make<Option.Option<LivePermissionQuery>>(Option.none())
    const currentRef = yield* Ref.make<Option.Option<PermissionMode>>(Option.none())
    const previousRef = yield* Ref.make<Option.Option<PermissionMode>>(Option.none())

    const applyMode = Effect.fn('PermissionModeController.applyMode')(function* (
      mode: PermissionMode
    ) {
      const currentOpt = yield* Ref.get(currentRef)
      if (Option.isNone(currentOpt)) {
        yield* Effect.logWarning('Cannot set permission mode yet; no session started', { mode })
        return
      }
      const current = currentOpt.value
      if (mode === current) return
      if (mode === 'plan') yield* Ref.set(previousRef, Option.some(current))

      const queryOpt = yield* Ref.get(queryRef)
      if (Option.isSome(queryOpt)) {
        yield* Effect.tryPromise(() => queryOpt.value.setPermissionMode(mode)).pipe(
          Effect.tapErrorCause((cause) =>
            Effect.logError('setPermissionMode failed', { mode, cause })
          ),
          Effect.ignore
        )
      }
      yield* Ref.set(currentRef, Option.some(mode))
      yield* Effect.logInfo('Applied permission mode', { from: current, to: mode })
    })

    const resolvePlan = Effect.fn('PermissionModeController.resolvePlan')(function* (
      approved: boolean
    ) {
      if (!approved) return Option.none<PermissionMode>()
      const previousOpt = yield* Ref.get(previousRef)
      if (Option.isSome(previousOpt)) yield* applyMode(previousOpt.value)
      return previousOpt
    })

    return {
      attachQuery: (query) => Ref.set(queryRef, Option.some(query)),
      seed: (mode) => Ref.set(currentRef, Option.some(mode)),
      currentMode: Ref.get(currentRef),
      applyMode,
      resolvePlan
    }
  }
)
