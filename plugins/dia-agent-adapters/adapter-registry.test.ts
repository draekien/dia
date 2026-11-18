import { ModelsUnavailable } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Option, Scope, Stream } from 'effect'
import { makeAgentAdapterRegistry } from './adapter-registry'
import { type AgentBackend, unavailableBackend } from './backend'
import { isAgentAdapters, type TextGeneration } from './registry'

const backendReporting = (message: string): AgentBackend => ({
  ...unavailableBackend('unused'),
  models: () => Stream.make(ModelsUnavailable.make({ message, refreshing: false }))
})

const current = <A>(stream: Stream.Stream<A>) =>
  stream.pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow))

describe('agent adapter registry', () => {
  it.effect('registers an adapter under the name of the registering plugin', () =>
    Effect.gen(function* () {
      const { service } = yield* makeAgentAdapterRegistry()

      yield* service.register(
        { name: 'dia-claude-code' },
        {
          label: 'Claude Code',
          backend: backendReporting('x')
        }
      )

      const found = yield* service.get('dia-claude-code')
      assert.deepStrictEqual(
        Option.map(found, ({ id, label }) => ({ id, label })),
        Option.some({ id: 'dia-claude-code', label: 'Claude Code' })
      )
    }).pipe(Effect.scoped)
  )

  it.effect('lists adapters by label, then id', () =>
    Effect.gen(function* () {
      const { service } = yield* makeAgentAdapterRegistry()
      const backend = backendReporting('x')

      yield* service.register({ name: 'plugin-z' }, { label: 'Alpha', backend })
      yield* service.register({ name: 'plugin-b' }, { label: 'Beta', backend })
      yield* service.register({ name: 'plugin-a' }, { label: 'Beta', backend })

      const listed = yield* current(service.adapters)
      assert.deepStrictEqual(
        listed.map(({ id }) => id),
        ['plugin-z', 'plugin-a', 'plugin-b']
      )
    }).pipe(Effect.scoped)
  )

  it.effect(
    'replaces an adapter registered again and keeps the new one when the old scope closes',
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeAgentAdapterRegistry()
        const oldScope = yield* Scope.make()
        const newScope = yield* Scope.make()
        yield* service
          .register({ name: 'dia-claude-code' }, { label: 'Old', backend: backendReporting('old') })
          .pipe(Scope.provide(oldScope))
        yield* service
          .register({ name: 'dia-claude-code' }, { label: 'New', backend: backendReporting('new') })
          .pipe(Scope.provide(newScope))

        yield* Scope.close(oldScope, Exit.void)

        const found = yield* service.get('dia-claude-code')
        assert.deepStrictEqual(
          Option.map(found, ({ label }) => label),
          Option.some('New')
        )
        yield* Scope.close(newScope, Exit.void)
      })
  )

  it.effect('unregisters an adapter when its scope closes', () =>
    Effect.gen(function* () {
      const { service } = yield* makeAgentAdapterRegistry()
      const scope = yield* Scope.make()
      yield* service
        .register(
          { name: 'dia-claude-code' },
          { label: 'Claude Code', backend: backendReporting('x') }
        )
        .pipe(Scope.provide(scope))

      yield* Scope.close(scope, Exit.void)

      assert.deepStrictEqual(yield* service.get('dia-claude-code'), Option.none())
    })
  )

  it.effect('registers nothing for a backend that is not an agent backend', () =>
    Effect.gen(function* () {
      const { service } = yield* makeAgentAdapterRegistry()

      yield* service.register(
        { name: 'broken' },
        { label: 'Broken', backend: { models: () => Stream.empty } as never }
      )

      assert.deepStrictEqual(yield* service.get('broken'), Option.none())
      assert.deepStrictEqual(yield* current(service.adapters), [])
    }).pipe(Effect.scoped)
  )

  const textGeneration: TextGeneration = {
    defaultModel: 'haiku',
    generate: () => Effect.succeed('title')
  }

  it.effect('offers a registered textGeneration to readers and summarises it as true', () =>
    Effect.gen(function* () {
      const { service, summaries } = yield* makeAgentAdapterRegistry()

      yield* service.register(
        { name: 'with' },
        { label: 'With', backend: backendReporting('x'), textGeneration }
      )

      const found = yield* service.get('with')
      assert.deepStrictEqual(
        Option.map(found, (adapter) => adapter.textGeneration),
        Option.some(Option.some(textGeneration))
      )
      assert.deepStrictEqual(yield* current(summaries), [
        { id: 'with', label: 'With', textGeneration: true }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect('registers an adapter without textGeneration as having none', () =>
    Effect.gen(function* () {
      const { service, summaries } = yield* makeAgentAdapterRegistry()

      yield* service.register(
        { name: 'without' },
        { label: 'Without', backend: backendReporting('x') }
      )

      const found = yield* service.get('without')
      assert.deepStrictEqual(
        Option.map(found, (adapter) => adapter.textGeneration),
        Option.some(Option.none())
      )
      assert.deepStrictEqual(yield* current(summaries), [
        { id: 'without', label: 'Without', textGeneration: false }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect.each([
    ['an empty defaultModel', { defaultModel: '', generate: textGeneration.generate }],
    ['a missing generate', { defaultModel: 'haiku' }],
    ['a non-function generate', { defaultModel: 'haiku', generate: 'x' }],
    ['a non-string defaultModel', { defaultModel: 1, generate: textGeneration.generate }]
  ])('registers the adapter without textGeneration for %s', ([, invalid]) =>
    Effect.gen(function* () {
      const { service, summaries } = yield* makeAgentAdapterRegistry()

      yield* service.register(
        { name: 'bad' },
        { label: 'Bad', backend: backendReporting('x'), textGeneration: invalid as never }
      )

      const found = yield* service.get('bad')
      assert.deepStrictEqual(
        Option.map(found, (adapter) => adapter.textGeneration),
        Option.some(Option.none())
      )
      assert.deepStrictEqual(yield* current(summaries), [
        { id: 'bad', label: 'Bad', textGeneration: false }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("reports a registered adapter's models and an unregistered adapter as not loaded", () =>
    Effect.gen(function* () {
      const { service } = yield* makeAgentAdapterRegistry()
      yield* service.register(
        { name: 'loaded' },
        { label: 'L', backend: backendReporting('from loaded') }
      )

      const loaded = yield* current(service.models('loaded'))
      const missing = yield* current(service.models('missing'))

      assert.deepStrictEqual(
        [loaded, missing],
        [
          ModelsUnavailable.make({ message: 'from loaded', refreshing: false }),
          ModelsUnavailable.make({ message: 'missing is not loaded', refreshing: false })
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('answers a status read of an unregistered adapter as not loaded', () =>
    Effect.gen(function* () {
      const registry = yield* makeAgentAdapterRegistry()

      const snapshot = yield* registry.status.current('missing')

      assert.deepStrictEqual(
        [
          snapshot.status.health._tag,
          'message' in snapshot.status.health && snapshot.status.health.message
        ],
        ['HealthError', 'missing is not loaded']
      )
    })
  )

  it('recognises the registry service and rejects other values', () => {
    const service = Effect.runSync(
      makeAgentAdapterRegistry().pipe(Effect.map(({ service }) => service))
    )

    assert.deepStrictEqual(
      [
        isAgentAdapters(service),
        isAgentAdapters({ register: () => undefined }),
        isAgentAdapters(null)
      ],
      [true, false, false]
    )
  })
})
