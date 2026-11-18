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
import type { ReactNode } from 'react'
import {
  FollowTextGenerationSettings,
  SetTextGenerationSettings,
  TEXT_GENERATION_PLUGIN,
  type TextGenerationSettings
} from './calls'

type ModelOptionJson = Extract<
  ModelCatalogSnapshotJson['state'],
  { _tag: 'Ready' }
>['models'][number]

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
    callHost(TEXT_GENERATION_PLUGIN, SetTextGenerationSettings, { settings }).pipe(
      Effect.tap(() => Effect.logInfo('Saved the text generation settings', settings)),
      Effect.catch((error) =>
        Effect.logWarning('Could not save the text generation settings', { reason: error._tag })
      )
    )
  )

function Field({
  id,
  label,
  value,
  display,
  disabled,
  onValueChange,
  children
}: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly display: ReactNode
  readonly disabled?: boolean
  readonly onValueChange: (value: string) => void
  readonly children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={id} className="text-xs text-ink-muted">
        {label}
      </span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onValueChange(next)
        }}
      >
        <SelectTrigger className="w-full" aria-labelledby={id}>
          <SelectValue>{display}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>{children}</SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

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
      <Field
        id="title-adapter-label"
        label="Adapter"
        value={settings.adapter}
        display={adapterLabel ?? settings.adapter}
        onValueChange={changeAdapter}
      >
        {adapters.map((adapter) => (
          <SelectItem key={adapter.id} value={adapter.id}>
            {adapter.label}
          </SelectItem>
        ))}
      </Field>
      <Field
        id="title-model-label"
        label="Model"
        value={settings.model}
        display={model?.displayName ?? settings.model}
        onValueChange={changeModel}
      >
        {models.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.displayName}
          </SelectItem>
        ))}
      </Field>
      <Field
        id="title-effort-label"
        label="Effort"
        value={settings.effort}
        display={thinkingLevelLabel(settings.effort)}
        disabled={(model?.effortLevels.length ?? 0) === 0}
        onValueChange={(value) => onChange({ ...settings, effort: value as EffortLevel })}
      >
        {(model?.effortLevels ?? []).map((level) => (
          <SelectItem key={level} value={level}>
            {thinkingLevelLabel(level)}
          </SelectItem>
        ))}
      </Field>
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
