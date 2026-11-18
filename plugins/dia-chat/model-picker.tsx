import {
  CLAUDE_CODE_SETTINGS,
  openSettings,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  useAdapters,
  useModelCatalogs,
  useModelPreferences
} from '@dia/renderer-plugin'
import {
  adapterPreferencesOf,
  EMPTY_MODEL_PREFERENCES,
  type ModelSelection,
  pickerModels
} from '@shared/domain/model-preferences'
import { composerSettingTrigger } from './composer-settings'

const MANAGE_MODELS = 'dia:manage-models'

const keyOf = (selection: ModelSelection): string =>
  JSON.stringify([selection.backend, selection.model])

/**
 * The composer's model choice for a thread on `value`. It renders one group per registered agent
 * adapter, headed by the adapter's label, listing that adapter's favourite models first and then
 * its other visible models, then "Manage models", which opens the Claude Code page of the Settings
 * dialog. With `only` set, the list holds just that adapter's group: a thread keeps the adapter
 * its run started on. A `value` the list does not offer shows as its raw model id. Choosing a
 * different model calls `onChange` with the adapter and model.
 */
export function ModelPicker({
  value,
  only,
  onChange
}: {
  readonly value: ModelSelection
  readonly only?: string
  readonly onChange: (selection: ModelSelection) => void
}) {
  const adapters = useAdapters()
  const shown = only === undefined ? adapters : adapters.filter(({ id }) => id === only)
  const catalogs = useModelCatalogs(shown)
  const preferences = useModelPreferences() ?? EMPTY_MODEL_PREFERENCES

  const groups = shown.map((adapter) => {
    const state = catalogs.get(adapter.id)
    const models = state?._tag === 'Ready' ? state.models : []
    const { favourites, others } = pickerModels(
      models,
      adapterPreferencesOf(preferences, adapter.id)
    )
    return { adapter, models: [...favourites, ...others] }
  })
  const offered = new Map(
    groups.flatMap(({ adapter, models }) =>
      models.map((model) => [keyOf({ backend: adapter.id, model: model.value }), model] as const)
    )
  )
  const label = offered.get(keyOf(value))?.displayName

  const choose = (next: string) => {
    if (next === MANAGE_MODELS) return openSettings(CLAUDE_CODE_SETTINGS)
    const [backend, model] = JSON.parse(next) as [string, string]
    if (backend !== value.backend || model !== value.model) onChange({ backend, model })
  }

  return (
    <Select
      value={keyOf(value)}
      onValueChange={(next) => {
        if (next !== null) choose(next)
      }}
    >
      <SelectTrigger size="sm" aria-label="Model" className={composerSettingTrigger()}>
        <SelectValue>{label ?? value.model}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {label === undefined ? (
          <SelectGroup>
            <SelectItem value={keyOf(value)} className="font-mono">
              {value.model}
            </SelectItem>
          </SelectGroup>
        ) : null}
        {groups.map(({ adapter, models }) =>
          models.length === 0 ? null : (
            <SelectGroup key={adapter.id}>
              <SelectLabel>{adapter.label}</SelectLabel>
              {models.map((model) => (
                <SelectItem
                  key={model.value}
                  value={keyOf({ backend: adapter.id, model: model.value })}
                >
                  {model.displayName}
                </SelectItem>
              ))}
            </SelectGroup>
          )
        )}
        <SelectSeparator />
        <SelectGroup>
          <SelectItem value={MANAGE_MODELS}>Manage models</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
