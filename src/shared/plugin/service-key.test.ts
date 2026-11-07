import { describe, expectTypeOf, it } from '@effect/vitest'
import { Effect, type Option, Predicate } from 'effect'
import { type PluginServices, ServiceKey, type ServiceNotDeclaredError } from './api'

interface Counter {
  readonly count: number
}

const isCounter = (value: unknown): value is Counter =>
  Predicate.hasProperty(value, 'count') && typeof value.count === 'number'

const CounterService = ServiceKey.make('counter', isCounter)

describe('ServiceKey types', () => {
  it('reads the type the key was made with from inject', () => {
    const read = (ctx: PluginServices) => ctx.inject(CounterService)

    expectTypeOf(read).returns.toEqualTypeOf<
      Effect.Effect<Option.Option<Counter>, ServiceNotDeclaredError>
    >()
  })

  it('reads unknown from inject with a string key', () => {
    const read = (ctx: PluginServices) => ctx.inject('counter')

    expectTypeOf(read).returns.toEqualTypeOf<
      Effect.Effect<Option.Option<unknown>, ServiceNotDeclaredError>
    >()
  })

  it('passes whenProvided each value under its key name with the key type', () => {
    const watch = (ctx: PluginServices) =>
      ctx.whenProvided([CounterService, 'raw'], (services) => {
        expectTypeOf(services).toEqualTypeOf<{
          readonly counter: Counter
          readonly raw: unknown
        }>()
        return Effect.void
      })

    expectTypeOf(watch).toBeFunction()
  })

  it('accepts a value of the key type and rejects any other value in provide', () => {
    const provideCounter = (ctx: PluginServices) => ctx.provide(CounterService, { count: 1 })
    const provideWrongShape = (ctx: PluginServices) =>
      // @ts-expect-error a ServiceKey<Counter> takes only a Counter
      ctx.provide(CounterService, { count: 'one' })

    expectTypeOf(provideCounter).toBeFunction()
    expectTypeOf(provideWrongShape).toBeFunction()
  })
})
