import { LEGACY_ADAPTER_ID, type ModelOption, ModelsReady, ModelsUnavailable } from '@dia/plugin'
import { unavailableBackend } from '@dia-plugin/dia-agent-adapters/backend'
import { DateTime, Effect, Option, Stream } from 'effect'
import type { RunChoices } from './run-settings'

/** A model option named `value` that supports `auto` when `autoMode` is true. */
export const model = (value: string, autoMode = false): ModelOption => ({
  value,
  displayName: value,
  description: '',
  adaptiveThinking: true,
  effortLevels: [],
  autoMode,
  fastMode: false
})

/**
 * Run choices on one adapter, `adapter` (`dia-claude-code` by default), that is registered, whose
 * catalog is ready with `models` and that disables `disabled` everywhere. The default selection is
 * the first of `models` on it.
 */
export const fakeChoices = (
  models: readonly [ModelOption, ...Array<ModelOption>],
  disabled: ReadonlyArray<'auto' | 'bypassPermissions'> = [],
  adapter = LEGACY_ADAPTER_ID
): RunChoices => ({
  adapters: {
    get: (id) =>
      Effect.succeed(
        id === adapter
          ? Option.some({
              id,
              label: id,
              textGeneration: Option.none(),
              backend: {
                ...unavailableBackend('fake'),
                disabledPermissionModes: () => Effect.succeed(disabled)
              }
            })
          : Option.none()
      ),
    models: (id) =>
      id === adapter
        ? Stream.make(
            ModelsReady.make({ models, fetchedAt: DateTime.makeUnsafe(0), refreshing: false })
          )
        : Stream.make(ModelsUnavailable.make({ message: `${id} is not loaded`, refreshing: false }))
  },
  defaultSelection: Effect.succeed(Option.some({ backend: adapter, model: models[0].value }))
})
