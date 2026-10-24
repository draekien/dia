import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import {
  makeSessionPermissions,
  PENDING_USER_INPUT_KEY,
  PERMISSION_MODE_CONTROLLER_KEY,
  type PendingUserInput,
  type PermissionModeController
} from './permissions-seam'

const stubPending = { tag: 'pending' } as unknown as PendingUserInput
const stubController = { tag: 'controller' } as unknown as PermissionModeController

const registryProviding = (provided: Record<string, unknown>) => ({
  inject: (key: string) => Effect.succeed(Option.fromNullishOr(provided[key]))
})

const bothProvided = {
  [PENDING_USER_INPUT_KEY]: () => stubPending,
  [PERMISSION_MODE_CONTROLLER_KEY]: () => Effect.succeed(stubController)
}

describe('makeSessionPermissions', () => {
  it.effect('uses both services the permissions plugin provides', () =>
    Effect.gen(function* () {
      const permissions = yield* makeSessionPermissions(registryProviding(bothProvided))

      assert.isTrue(permissions.available)
      assert.strictEqual(permissions.pendingUserInput, stubPending)
      assert.strictEqual(permissions.modeController, stubController)
    })
  )

  it.effect('creates fresh services on every call so sessions share no state', () =>
    Effect.gen(function* () {
      const registry = registryProviding({
        [PENDING_USER_INPUT_KEY]: () => ({}) as PendingUserInput,
        [PERMISSION_MODE_CONTROLLER_KEY]: () => Effect.succeed({} as PermissionModeController)
      })

      const first = yield* makeSessionPermissions(registry)
      const second = yield* makeSessionPermissions(registry)

      assert.notStrictEqual(first.pendingUserInput, second.pendingUserInput)
    })
  )

  const unavailableCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['no plugin provides either key', {}],
    [
      'only the mode controller is provided',
      { [PERMISSION_MODE_CONTROLLER_KEY]: bothProvided[PERMISSION_MODE_CONTROLLER_KEY] }
    ],
    [
      'only the pending registry is provided',
      { [PENDING_USER_INPUT_KEY]: bothProvided[PENDING_USER_INPUT_KEY] }
    ],
    ['a provided value is not a function', { ...bothProvided, [PENDING_USER_INPUT_KEY]: 'nope' }],
    [
      'the pending factory throws',
      {
        ...bothProvided,
        [PENDING_USER_INPUT_KEY]: () => {
          throw new Error('boom')
        }
      }
    ],
    [
      'the controller factory throws',
      {
        ...bothProvided,
        [PERMISSION_MODE_CONTROLLER_KEY]: () => {
          throw new Error('boom')
        }
      }
    ]
  ]

  for (const [name, provided] of unavailableCases) {
    it.effect(`is unavailable when ${name}`, () =>
      Effect.gen(function* () {
        const permissions = yield* makeSessionPermissions(registryProviding(provided))

        assert.isFalse(permissions.available)
        assert.deepStrictEqual(yield* permissions.pendingUserInput.interruptAll, [])
        assert.deepStrictEqual(yield* permissions.modeController.currentMode, Option.none())
        assert.deepStrictEqual(yield* permissions.modeController.resolvePlan(true), Option.none())
      })
    )
  }

  it.effect('an unavailable controller never records a mode change', () =>
    Effect.gen(function* () {
      const permissions = yield* makeSessionPermissions(registryProviding({}))

      yield* permissions.modeController.seed('default')
      yield* permissions.modeController.applyMode('plan')

      assert.deepStrictEqual(yield* permissions.modeController.currentMode, Option.none())
    })
  )
})
