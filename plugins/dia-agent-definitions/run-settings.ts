import { type Runs, type StartRunOptions, startPermissionMode } from '@dia/plugin'
import type { AgentAdapters } from '@dia-plugin/dia-agent-adapters/registry'
import { Effect, Option, Stream } from 'effect'
import type { AgentDefinition } from './registry'

/** The run options {@link runSettings} chooses; the caller adds `cwd`, the prompt and the rest. */
export type RunSettings = Pick<
  StartRunOptions,
  'model' | 'backend' | 'thinkingLevel' | 'permissionMode'
>

/**
 * What a run's start options are chosen from: `adapters` to find the backend of the selection's
 * adapter, and `defaultSelection`, the model of a caller that has no selection of its own.
 */
export interface RunChoices {
  readonly adapters: Pick<AgentAdapters, 'get' | 'models'>
  readonly defaultSelection: Runs['defaultSelection']
}

/**
 * The model, backend, thinking level and permission mode a run of agent definition `definition`
 * starts with in `cwd`, or none when the definition has no selection and no adapter is loaded to
 * give a default. The model is the definition's selection or `choices.defaultSelection`; the
 * permission mode is the one `startPermissionMode` gives (ADR-0054) with `bypassOptedIn`. Waits
 * until the selection's adapter has a ready model list; an adapter that is not registered does not
 * wait, and its run ends with the adapter's not-loaded message.
 */
export const runSettings = Effect.fn('AgentDefinitions.runSettings')(function* (
  choices: RunChoices,
  definition: Pick<AgentDefinition, 'name' | 'selection' | 'thinkingLevel'>,
  cwd: string,
  bypassOptedIn: boolean
) {
  const selection =
    definition.selection === null
      ? Option.getOrNull(yield* choices.defaultSelection)
      : definition.selection
  if (selection === null) {
    yield* Effect.logWarning('No agent adapter is loaded', { definition: definition.name })
    return Option.none<RunSettings>()
  }
  const adapter = yield* choices.adapters.get(selection.backend)
  const catalog = Option.isNone(adapter)
    ? Option.none()
    : yield* choices.adapters.models(selection.backend).pipe(
        Stream.filter((state) => state._tag === 'Ready'),
        Stream.runHead,
        Effect.map(Option.map((state) => state.models))
      )
  const models = Option.getOrElse(catalog, () => [])
  const input = {
    modelSupportsAuto: models.find((option) => option.value === selection.model)?.autoMode ?? false,
    disabled: Option.isNone(adapter)
      ? []
      : yield* adapter.value.backend.disabledPermissionModes(cwd),
    bypassOptedIn
  }
  const permissionMode = startPermissionMode(input)
  yield* Effect.logInfo('Chose a run permission mode', { ...selection, ...input, permissionMode })
  return Option.some<RunSettings>({
    model: selection.model,
    backend: selection.backend,
    thinkingLevel: definition.thinkingLevel,
    permissionMode
  })
})
