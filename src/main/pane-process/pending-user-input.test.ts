import { assert, describe, it } from '@effect/vitest'
import type { PermissionResponse } from '@shared/domain/attention'
import { Deferred, Effect } from 'effect'
import { makePendingUserInput, type UserInputResolution } from './pending-user-input'

const allow: PermissionResponse = { _tag: 'Allow' }
const deny: PermissionResponse = { _tag: 'Deny', message: 'no' }

describe('PendingUserInput', () => {
  it.effect('resolves a registered request once and reports the match', () =>
    Effect.gen(function* () {
      const registry = makePendingUserInput()
      const deferred = yield* registry.register('req-1')

      const matched = yield* registry.resolve('req-1', allow)
      const resolution: UserInputResolution = yield* Deferred.await(deferred)

      assert.isTrue(matched)
      assert.deepStrictEqual(resolution, allow)
      assert.isFalse(yield* registry.isPending('req-1'))
    })
  )

  it.effect('does not resolve a request twice', () =>
    Effect.gen(function* () {
      const registry = makePendingUserInput()
      const deferred = yield* registry.register('req-1')

      const first = yield* registry.resolve('req-1', allow)
      const second = yield* registry.resolve('req-1', deny)
      const resolution = yield* Deferred.await(deferred)

      assert.isTrue(first)
      assert.isFalse(second)
      assert.deepStrictEqual(resolution, allow)
    })
  )

  it.effect('reports no match for an unknown requestId', () =>
    Effect.gen(function* () {
      const registry = makePendingUserInput()
      const matched = yield* registry.resolve('never-registered', allow)
      assert.isFalse(matched)
    })
  )

  it.effect('drop leaves the pending Deferred unresolved and blocks a later resolve', () =>
    Effect.gen(function* () {
      const registry = makePendingUserInput()
      const deferred = yield* registry.register('req-1')

      const dropped = yield* registry.drop
      const resolvedAfterDrop = yield* Deferred.isDone(deferred)
      const lateResolve = yield* registry.resolve('req-1', allow)

      assert.deepStrictEqual(dropped, ['req-1'])
      assert.isFalse(resolvedAfterDrop)
      assert.isFalse(lateResolve)
      assert.isFalse(yield* registry.isPending('req-1'))
    })
  )

  it.effect('drop returns every outstanding requestId', () =>
    Effect.gen(function* () {
      const registry = makePendingUserInput()
      yield* registry.register('req-1').pipe(Effect.asVoid)
      yield* registry.register('req-2').pipe(Effect.asVoid)

      const dropped = yield* registry.drop

      assert.deepStrictEqual([...dropped].sort(), ['req-1', 'req-2'])
    })
  )

  it.effect('interruptAll resolves every request with Superseded and empties the registry', () =>
    Effect.gen(function* () {
      const registry = makePendingUserInput()
      const first = yield* registry.register('req-1')
      const second = yield* registry.register('req-2')

      const interrupted = yield* registry.interruptAll
      const firstResolution = yield* Deferred.await(first)
      const secondResolution = yield* Deferred.await(second)

      assert.deepStrictEqual([...interrupted].sort(), ['req-1', 'req-2'])
      assert.deepStrictEqual(firstResolution, { _tag: 'Superseded' })
      assert.deepStrictEqual(secondResolution, { _tag: 'Superseded' })
      assert.isFalse(yield* registry.isPending('req-1'))
      assert.isFalse(yield* registry.isPending('req-2'))
    })
  )

  it.effect('interruptAll makes a later resolve for a superseded id a no-op', () =>
    Effect.gen(function* () {
      const registry = makePendingUserInput()
      const deferred = yield* registry.register('req-1')

      yield* registry.interruptAll
      const lateResolve = yield* registry.resolve('req-1', allow)
      const resolution = yield* Deferred.await(deferred)

      assert.isFalse(lateResolve)
      assert.deepStrictEqual(resolution, { _tag: 'Superseded' })
    })
  )
})
