import type { LivePermissionQuery, PermissionModeController } from '@dia/plugin'
import type { PermissionMode } from '@shared/domain/pane'
import { Effect, Option, Ref } from 'effect'

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
          Effect.tapCause((cause) => Effect.logError('setPermissionMode failed', { mode, cause })),
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
