import type { EffortLevel } from '@dia/plugin'
import {
  callHost,
  followHost,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSectionHeading,
  Skeleton,
  thinkingLevelLabel,
  useAdapters,
  useModelCatalogs
} from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import type { ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import { Effect, Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import {
  FollowTextGenerationSettings,
  SetTextGenerationSettings,
  type TextGenerationSettings
} from './calls'

type ModelOptionJson = Extract<
  ModelCatalogSnapshotJson['state'],
  { _tag: 'Ready' }
>['models'][number]

const SETTINGS_PLUGIN = 'dia-text-generation'

const modelsOf = (state: ModelCatalogSnapshotJson['state'] | undefined) =>
  state?._tag === 'Ready' ? state.models : []

const firstEffort = (model: ModelOptionJson | undefined): EffortLevel =>
  model?.effortLevels[0] ?? 'low'

/** Makes the atom that follows the saved settings for the `dia-text-generation` renderer entry `ctx`. */
export const makeTextGenerationSettingsAtom = (ctx: { readonly name: string }) =>
  Atom.make(followHost(ctx, FollowTextGenerationSettings, {}))

/** The atom {@link makeTextGenerationSettingsAtom} makes; {@link TextGenerationSettingsPage} reads it. */
export type TextGenerationSettingsAtom = ReturnType<typeof makeTextGenerationSettingsAtom>

const save = (settings: TextGenerationSettings) =>
  Effect.runFork(
    callHost(SETTINGS_PLUGIN, SetTextGenerationSettings, { settings }).pipe(
      Effect.tap(() => Effect.logInfo('Saved the text generation settings', settings)),
      Effect.catch((error) =>
        Effect.logWarning('Could not save the text generation settings', { reason: error._tag })
      )
    )
  )

/**
 * The selects that choose the adapter, model and effort that write thread titles. `settings` is
 * the saved choice and `onChange` receives the whole new choice. Changing the adapter picks that
 * adapter's first model; changing the adapter or the model picks the first effort the model lists,
 * or `low` when it lists none. The effort select is disabled while the model lists no effort.
 */
export function TextGenerationSettingsForm({
  settings,
  onChange
}: {
  readonly settings: TextGenerationSettings
  readonly onChange: (settings: TextGenerationSettings) => void
}) {
  const adapters = useAdapters().filter((adapter) => adapter.textGeneration)
  const catalogs = useModelCatalogs(adapters)
  const models = modelsOf(catalogs.get(settings.adapter))
  const model = models.find((option) => option.value === settings.model)
  const adapterLabel = adapters.find((adapter) => adapter.id === settings.adapter)?.label

  const changeAdapter = (adapter: string) => {
    const first = modelsOf(catalogs.get(adapter))[0]
    if (first === undefined) return
    onChange({ adapter, model: first.value, effort: firstEffort(first) })
  }
  const changeModel = (value: string) => {
    const next = models.find((option) => option.value === value)
    onChange({ ...settings, model: value, effort: firstEffort(next) })
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span id="title-adapter-label" className="text-xs text-ink-muted">
          Adapter
        </span>
        <Select
          value={settings.adapter}
          onValueChange={(value) => {
            if (value !== null) changeAdapter(value)
          }}
        >
          <SelectTrigger className="w-full" aria-labelledby="title-adapter-label">
            <SelectValue>{adapterLabel ?? settings.adapter}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {adapters.map((adapter) => (
                <SelectItem key={adapter.id} value={adapter.id}>
                  {adapter.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span id="title-model-label" className="text-xs text-ink-muted">
          Model
        </span>
        <Select
          value={settings.model}
          onValueChange={(value) => {
            if (value !== null) changeModel(value)
          }}
        >
          <SelectTrigger className="w-full" aria-labelledby="title-model-label">
            <SelectValue>{model?.displayName ?? settings.model}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {models.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.displayName}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span id="title-effort-label" className="text-xs text-ink-muted">
          Effort
        </span>
        <Select
          value={settings.effort}
          disabled={(model?.effortLevels.length ?? 0) === 0}
          onValueChange={(value) => {
            if (value !== null) onChange({ ...settings, effort: value })
          }}
        >
          <SelectTrigger className="w-full" aria-labelledby="title-effort-label">
            <SelectValue>{thinkingLevelLabel(settings.effort)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(model?.effortLevels ?? []).map((level) => (
                <SelectItem key={level} value={level}>
                  {thinkingLevelLabel(level)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

/**
 * The Text generation Settings page: the adapter, model and effort that write thread titles,
 * saved as they change. `settingsAtom` comes from {@link makeTextGenerationSettingsAtom}. Render
 * it inside a scrolling container; it sizes to its content.
 */
export function TextGenerationSettingsPage({
  settingsAtom
}: {
  readonly settingsAtom: TextGenerationSettingsAtom
}) {
  const result = useAtomValue(settingsAtom)
  const settings = AsyncResult.isSuccess(result) ? Option.getOrUndefined(result.value) : undefined
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6">
      <section className="flex flex-col gap-3" aria-labelledby="titles-heading">
        <SettingsSectionHeading id="titles-heading">Thread titles</SettingsSectionHeading>
        {settings === undefined ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <TextGenerationSettingsForm settings={settings} onChange={save} />
        )}
      </section>
    </div>
  )
}
