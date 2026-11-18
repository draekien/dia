import type { ModelCatalogState } from '@dia/plugin'
import { unavailableBackend } from '@dia-plugin/dia-agent-adapters/backend'
import type { AgentAdapter } from '@dia-plugin/dia-agent-adapters/registry'
import { assert, describe, it } from '@effect/vitest'
import { DateTime, Effect, Fiber, Option, Stream, SubscriptionRef } from 'effect'
import { makeDefaultSelection } from './default-selection'

const adapter = (id: string): AgentAdapter => ({
  id,
  label: id,
  textGeneration: Option.none(),
  backend: unavailableBackend('fake')
})

const loading: ModelCatalogState = { _tag: 'Loading' }

const option = (value: string) => ({
  value,
  displayName: value,
  description: '',
  adaptiveThinking: true,
  effortLevels: [] as [],
  autoMode: true,
  fastMode: false
})

const ready = (first: string, ...rest: ReadonlyArray<string>): ModelCatalogState => ({
  _tag: 'Ready',
  models: [option(first), ...rest.map(option)],
  fetchedAt: DateTime.makeUnsafe(0),
  refreshing: false
})

const world = (
  adapters: ReadonlyArray<AgentAdapter>,
  catalogs: Readonly<Record<string, ModelCatalogState>>,
  defaults: { readonly selection?: { readonly backend: string; readonly model: string } } = {}
) =>
  Effect.gen(function* () {
    const refs = new Map<string, SubscriptionRef.SubscriptionRef<ModelCatalogState>>()
    for (const [id, state] of Object.entries(catalogs)) {
      refs.set(id, yield* SubscriptionRef.make(state))
    }
    const defaultSelection = makeDefaultSelection({
      preferences: Effect.succeed({ adapters: {}, defaults }),
      adapters: Stream.succeed(adapters),
      models: (id) =>
        SubscriptionRef.changes(refs.get(id) as SubscriptionRef.SubscriptionRef<ModelCatalogState>)
    })
    return { defaultSelection, refs }
  })

describe('makeDefaultSelection', () => {
  it.effect('answers the stored default selection without reading any catalog', () =>
    Effect.gen(function* () {
      const stored = { backend: 'not-loaded', model: 'm1' }
      const { defaultSelection } = yield* world([], {}, { selection: stored })

      assert.deepStrictEqual(yield* defaultSelection, Option.some(stored))
    })
  )

  it.effect('answers none while no adapter is registered', () =>
    Effect.gen(function* () {
      const { defaultSelection } = yield* world([], {})

      assert.deepStrictEqual(yield* defaultSelection, Option.none())
    })
  )

  it.effect('takes the first model of the first adapter in registry order', () =>
    Effect.gen(function* () {
      const { defaultSelection } = yield* world([adapter('a'), adapter('b')], {
        a: ready('a1', 'a2'),
        b: ready('b1')
      })

      assert.deepStrictEqual(yield* defaultSelection, Option.some({ backend: 'a', model: 'a1' }))
    })
  )

  it.effect('skips an adapter whose catalog is not ready', () =>
    Effect.gen(function* () {
      const { defaultSelection } = yield* world([adapter('a'), adapter('b'), adapter('c')], {
        a: loading,
        b: { _tag: 'Unavailable', message: 'offline', refreshing: false },
        c: ready('c1')
      })

      assert.deepStrictEqual(yield* defaultSelection, Option.some({ backend: 'c', model: 'c1' }))
    })
  )

  it.effect('waits until a catalog is ready', () =>
    Effect.gen(function* () {
      const { defaultSelection, refs } = yield* world([adapter('a')], { a: loading })

      const fiber = yield* Effect.forkChild(defaultSelection)
      yield* Effect.yieldNow
      assert.isUndefined(fiber.pollUnsafe())
      yield* SubscriptionRef.set(
        refs.get('a') as SubscriptionRef.SubscriptionRef<ModelCatalogState>,
        ready('a1')
      )

      assert.deepStrictEqual(yield* Fiber.join(fiber), Option.some({ backend: 'a', model: 'a1' }))
    })
  )
})
