import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import {
  type LivePermissionQuery,
  makePermissionModeController
} from './permission-mode-controller'

const makeFakeQuery = (): { readonly query: LivePermissionQuery; readonly calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    query: {
      setPermissionMode: (mode) => {
        calls.push(mode)
        return Promise.resolve()
      }
    }
  }
}

describe('PermissionModeController', () => {
  it.effect('restores the pre-plan mode on the live query when an approved plan resolves', () =>
    Effect.gen(function* () {
      const { query, calls } = makeFakeQuery()
      const controller = yield* makePermissionModeController
      yield* controller.attachQuery(query)
      yield* controller.seed('acceptEdits')

      yield* controller.applyMode('plan')
      const restored = yield* controller.resolvePlan(true)

      assert.deepStrictEqual(calls, ['plan', 'acceptEdits'])
      assert.deepStrictEqual(restored, Option.some('acceptEdits'))
    })
  )

  it.effect('leaves the pane in plan and restores nothing when a plan is rejected', () =>
    Effect.gen(function* () {
      const { query, calls } = makeFakeQuery()
      const controller = yield* makePermissionModeController
      yield* controller.attachQuery(query)
      yield* controller.seed('auto')

      yield* controller.applyMode('plan')
      const restored = yield* controller.resolvePlan(false)
      const current = yield* controller.currentMode

      assert.deepStrictEqual(calls, ['plan'])
      assert.deepStrictEqual(restored, Option.none())
      assert.deepStrictEqual(current, Option.some('plan'))
    })
  )

  it.effect('does not touch the query when the requested mode equals the current mode', () =>
    Effect.gen(function* () {
      const { query, calls } = makeFakeQuery()
      const controller = yield* makePermissionModeController
      yield* controller.attachQuery(query)
      yield* controller.seed('auto')

      yield* controller.applyMode('auto')

      assert.deepStrictEqual(calls, [])
    })
  )

  it.effect('restores nothing when an approved plan was never entered via a mode switch', () =>
    Effect.gen(function* () {
      const { query, calls } = makeFakeQuery()
      const controller = yield* makePermissionModeController
      yield* controller.attachQuery(query)
      yield* controller.seed('default')

      const restored = yield* controller.resolvePlan(true)

      assert.deepStrictEqual(calls, [])
      assert.deepStrictEqual(restored, Option.none())
    })
  )

  it.effect('ignores a mode change made before any session has started', () =>
    Effect.gen(function* () {
      const { query, calls } = makeFakeQuery()
      const controller = yield* makePermissionModeController
      yield* controller.attachQuery(query)

      yield* controller.applyMode('acceptEdits')
      const current = yield* controller.currentMode

      assert.deepStrictEqual(calls, [])
      assert.deepStrictEqual(current, Option.none())
    })
  )
})
