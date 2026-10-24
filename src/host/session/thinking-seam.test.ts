import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import {
  resolveThinkingOptions,
  THINKING_OPTIONS_KEY,
  type ThinkingOptionsFactory
} from './thinking-seam'

const registryProviding = (provided: Option.Option<unknown>) => ({
  inject: (key: string) =>
    Effect.succeed(key === THINKING_OPTIONS_KEY ? provided : Option.none<unknown>())
})

describe('resolveThinkingOptions', () => {
  it.effect('returns what the provided factory returns for the level', () =>
    Effect.gen(function* () {
      const factory: ThinkingOptionsFactory = (level) => ({
        thinking: { type: 'adaptive' },
        effort: level === 'high' ? 'high' : 'low'
      })
      const options = yield* resolveThinkingOptions(registryProviding(Option.some(factory)), 'high')
      assert.deepStrictEqual(options, { thinking: { type: 'adaptive' }, effort: 'high' })
    })
  )

  it.effect('returns empty options when no plugin provides the service', () =>
    Effect.gen(function* () {
      const options = yield* resolveThinkingOptions(registryProviding(Option.none()), 'off')
      assert.deepStrictEqual(options, {})
    })
  )

  it.effect('returns empty options when the provided service is not a function', () =>
    Effect.gen(function* () {
      const options = yield* resolveThinkingOptions(
        registryProviding(Option.some({ thinking: 'off' })),
        'off'
      )
      assert.deepStrictEqual(options, {})
    })
  )

  it.effect('returns empty options when the factory throws', () =>
    Effect.gen(function* () {
      const factory: ThinkingOptionsFactory = () => {
        throw new Error('boom')
      }
      const options = yield* resolveThinkingOptions(
        registryProviding(Option.some(factory)),
        'medium'
      )
      assert.deepStrictEqual(options, {})
    })
  )
})
