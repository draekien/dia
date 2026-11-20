import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { type AgentDefinition, AgentDefinitionName } from './registry'
import { runSettings } from './run-settings'
import { fakeChoices, model } from './run-settings.fake'

const definition = (
  selection: AgentDefinition['selection']
): Pick<AgentDefinition, 'name' | 'selection' | 'thinkingLevel'> => ({
  name: AgentDefinitionName.make('Engineer'),
  selection,
  thinkingLevel: 'high'
})

describe('runSettings', () => {
  const choices = fakeChoices([model('opus', true)], [], 'adapter-a')

  it.effect("starts on the backend of the definition's selection, with its model", () =>
    Effect.gen(function* () {
      const settings = yield* runSettings(
        choices,
        definition({ backend: 'adapter-a', model: 'opus' }),
        '/repo',
        false
      )

      assert.deepStrictEqual(
        settings,
        Option.some({
          model: 'opus',
          backend: 'adapter-a',
          thinkingLevel: 'high',
          permissionMode: 'auto'
        })
      )
    })
  )

  it.effect('starts a definition with no selection on the default selection', () =>
    Effect.gen(function* () {
      const settings = yield* runSettings(choices, definition(null), '/repo', false)

      assert.deepStrictEqual(
        Option.map(settings, ({ backend, model }) => [backend, model]),
        Option.some(['adapter-a', 'opus'])
      )
    })
  )

  it.effect('starts no run for a definition with no selection while no adapter is loaded', () =>
    Effect.gen(function* () {
      const none = { ...choices, defaultSelection: Effect.succeed(Option.none()) }

      const settings = yield* runSettings(none, definition(null), '/repo', false)

      assert.isTrue(Option.isNone(settings))
    })
  )

  it.effect('still starts a run whose selection names an adapter that is not registered', () =>
    Effect.gen(function* () {
      const settings = yield* runSettings(
        choices,
        definition({ backend: 'unloaded-adapter', model: 'beta' }),
        '/repo',
        false
      )

      assert.deepStrictEqual(
        Option.map(settings, ({ backend, model, permissionMode }) => [
          backend,
          model,
          permissionMode
        ]),
        Option.some(['unloaded-adapter', 'beta', 'default'])
      )
    })
  )
})
