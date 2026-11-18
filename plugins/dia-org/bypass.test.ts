import { unavailableBackend } from '@dia-plugin/dia-agent-adapters/backend'
import type { AgentAdapter, AgentAdapters } from '@dia-plugin/dia-agent-adapters/registry'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Option, Ref, Stream } from 'effect'
import { bypassAvailable } from './bypass'

const adapter = (id: string, disabled: ReadonlyArray<'bypassPermissions'>): AgentAdapter => ({
  id,
  label: id,
  textGeneration: Option.none(),
  backend: {
    ...unavailableBackend('fake'),
    disabledPermissionModes: () => Effect.succeed(disabled)
  }
})

const registryOf = (...adapters: ReadonlyArray<AgentAdapter>) =>
  Ref.make(
    Option.some({
      adapters: Stream.make(adapters),
      get: (id: string) => Effect.succeed(Option.fromNullishOr(adapters.find((a) => a.id === id)))
    } as unknown as AgentAdapters)
  )

const ALLOWING = adapter('allowing', [])
const REFUSING = adapter('refusing', ['bypassPermissions'])

describe('bypassAvailable', () => {
  it.effect('reads the adapter a selection names', () =>
    Effect.gen(function* () {
      const registry = yield* registryOf(ALLOWING, REFUSING)

      const results = [
        yield* bypassAvailable(registry, [{ backend: 'allowing', model: 'm' }]),
        yield* bypassAvailable(registry, [{ backend: 'refusing', model: 'm' }])
      ]

      assert.deepStrictEqual(results, [true, false])
    })
  )

  it.effect('is true when any selection names an adapter that allows bypass', () =>
    Effect.gen(function* () {
      const registry = yield* registryOf(ALLOWING, REFUSING)

      const available = yield* bypassAvailable(registry, [
        { backend: 'refusing', model: 'm' },
        { backend: 'allowing', model: 'm' }
      ])

      assert.isTrue(available)
    })
  )

  it.effect('counts every registered adapter for a job title with no selection', () =>
    Effect.gen(function* () {
      const registry = yield* registryOf(REFUSING, ALLOWING)

      assert.isTrue(yield* bypassAvailable(registry, [null]))
    })
  )

  it.effect('is false when the selection names an adapter that is not registered', () =>
    Effect.gen(function* () {
      const registry = yield* registryOf(ALLOWING)

      assert.isFalse(yield* bypassAvailable(registry, [{ backend: 'unloaded', model: 'm' }]))
    })
  )

  it.effect('is false while no adapter registry is provided', () =>
    Effect.gen(function* () {
      const registry = yield* Ref.make(Option.none<AgentAdapters>())

      assert.isFalse(yield* bypassAvailable(registry, [null]))
    })
  )
})
