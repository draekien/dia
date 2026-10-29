// @effect-diagnostics globalDate:off -- the health check age is compared against wall-clock time; no Effect runtime exists in the renderer.
// @effect-diagnostics asyncFunction:off -- React callbacks await the Promise-based window.dia bridge; no Effect runtime exists in the renderer.

import { PermissionModeItems } from '@renderer/components/permission-mode-items'
import { type AdapterStatusJson, useAdapterStatus } from '@renderer/hooks/use-adapter-status'
import { type ModelCatalog, useModelCatalog } from '@renderer/hooks/use-model-catalog'
import { useModelPreferences } from '@renderer/hooks/use-model-preferences'
import { formatWhen } from '@renderer/lib/format-when'
import {
  CREATE_PERMISSION_MODE_OPTIONS,
  disabledPermissionModesFor,
  offeredPermissionModes,
  permissionModeLabel
} from '@renderer/lib/permission-modes'
import {
  fitThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelsFor
} from '@renderer/lib/thinking-levels'
import { cn } from '@renderer/lib/utils'
import {
  type AdapterPreferences,
  type AgentDefaults,
  EMPTY_ADAPTER_PREFERENCES,
  keepsAModelVisible,
  LAST_VISIBLE_MODEL_MESSAGE,
  type ModelPreference,
  pickerModels
} from '@shared/domain/model-preferences'
import {
  DEFAULT_THINKING_LEVEL,
  type StartupPermissionMode,
  type ThinkingLevel
} from '@shared/domain/pane'
import type { ModelCatalogSnapshotJson } from '@shared/ipc/contract'
import { Duration } from 'effect'
import {
  ChevronRightIcon,
  EyeOffIcon,
  FileIcon,
  Loader2Icon,
  RefreshCwIcon,
  StarIcon,
  XIcon
} from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { Skeleton } from '../ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const STALE_CHECK = Duration.minutes(5)

type Health = AdapterStatusJson['health']
type ModelOptionJson = Extract<
  ModelCatalogSnapshotJson['state'],
  { _tag: 'Ready' }
>['models'][number]

const healthLabel = (health: Health, checking: boolean): string => {
  switch (health._tag) {
    case 'HealthNotChecked':
      return checking ? 'Checking…' : 'Not checked'
    case 'HealthNotInstalled':
      return 'Not installed'
    case 'HealthError':
      return "Can't run"
    case 'HealthUnknown':
      return 'Sign-in unknown'
    case 'HealthNotSignedIn':
      return 'Not signed in'
    case 'HealthReady':
      return 'Ready'
  }
}

const healthDetail = (health: Health): string | undefined => {
  switch (health._tag) {
    case 'HealthNotSignedIn':
      return 'Run `claude auth login` and try again.'
    case 'HealthError':
    case 'HealthUnknown':
      return health.message
    default:
      return undefined
  }
}

const versionOf = (health: Health): string | undefined =>
  'version' in health ? health.version : undefined

const installPathOf = (health: Health): string | undefined =>
  'installPath' in health ? health.installPath : undefined

const accountOf = (health: Health): string | undefined =>
  health._tag === 'HealthReady'
    ? [health.email, health.subscriptionType].filter((part) => part !== undefined).join(' · ') ||
      'Signed in'
    : undefined

const checkedAtOf = (health: Health): string | undefined =>
  'checkedAt' in health ? health.checkedAt : undefined

const isStale = (health: Health): boolean => {
  const checkedAt = checkedAtOf(health)
  return (
    checkedAt !== undefined &&
    Date.now() - new Date(checkedAt).getTime() > Duration.toMillis(STALE_CHECK)
  )
}

function SectionHeading({ id, children }: { readonly id: string; readonly children: string }) {
  return (
    <h3 id={id} className="text-sm font-medium text-ink">
      {children}
    </h3>
  )
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-ink">{children}</dd>
    </div>
  )
}

function HealthSection({ status }: { readonly status: AdapterStatusJson | undefined }) {
  if (status === undefined) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
    )
  }
  const { health, checking, installPathOverride } = status
  const detail = healthDetail(health)
  const installPath = installPathOf(health) ?? installPathOverride
  const checkedAt = checkedAtOf(health)

  const change = async () => {
    const path = await window.dia.pickFile()
    if (path !== null) await window.dia.adapter.setInstallPath(path)
  }

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2">
        <Row label="Status">
          <span className="flex items-baseline gap-2">
            <span>{healthLabel(health, checking)}</span>
            {checkedAt === undefined ? null : (
              <span className="text-xs text-ink-muted tabular-nums">
                checked {formatWhen(checkedAt)}
              </span>
            )}
          </span>
        </Row>
        <Row label="Version">
          <span className="font-mono text-xs">{versionOf(health) ?? '—'}</span>
        </Row>
        <Row label="Account">{accountOf(health) ?? '—'}</Row>
        <Row label="Executable">
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-xs break-all" title={installPath ?? undefined}>
              {installPath ?? 'Not found'}
            </span>
            <span className="text-xs text-ink-muted">
              {installPathOverride !== null
                ? 'Chosen by you'
                : installPathOf(health) === undefined
                  ? 'Searched PATH'
                  : 'Found on PATH'}
            </span>
          </span>
        </Row>
      </dl>
      {detail === undefined ? null : (
        <p className="max-h-32 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-ink">
          {detail}
        </p>
      )}
      <div className="flex items-center gap-1">
        <Button size="xs" variant="outline" disabled={checking} onClick={() => void change()}>
          <FileIcon />
          Change
        </Button>
        {installPathOverride === null ? null : (
          <Button
            size="xs"
            variant="ghost"
            disabled={checking}
            onClick={() => void window.dia.adapter.setInstallPath(null)}
          >
            Use PATH
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          aria-disabled={checking}
          onClick={checking ? undefined : () => void window.dia.adapter.checkHealth()}
        >
          {checking ? <Loader2Icon className="motion-safe:animate-spin" /> : <RefreshCwIcon />}
          Check
        </Button>
      </div>
    </div>
  )
}

function DefaultsSection({
  models,
  preferences
}: {
  readonly models: ReadonlyArray<ModelOptionJson>
  readonly preferences: AdapterPreferences
}) {
  const { defaults } = preferences
  const { favourites, others } = pickerModels(models, preferences)
  const listed = [...favourites, ...others]
  const model = listed.find((option) => option.value === defaults.model) ?? listed[0]
  const thinkingLevels = thinkingLevelsFor(model)
  const thinkingLevel = fitThinkingLevel(
    defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    thinkingLevels
  )
  const permissionMode = defaults.permissionMode ?? 'auto'

  const update = (next: AgentDefaults) => void window.dia.adapter.setDefaults(next)

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span id="default-model-label" className="text-xs text-ink-muted">
          Model
        </span>
        <Select
          value={model?.value}
          onValueChange={(value) => update({ ...defaults, model: value })}
        >
          <SelectTrigger className="w-full" aria-labelledby="default-model-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {listed.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.displayName}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span id="default-thinking-label" className="text-xs text-ink-muted">
          Thinking
        </span>
        <Select
          value={thinkingLevel}
          onValueChange={(value: ThinkingLevel) => update({ ...defaults, thinkingLevel: value })}
        >
          <SelectTrigger className="w-full" aria-labelledby="default-thinking-label">
            <SelectValue>{thinkingLevelLabel(thinkingLevel)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {thinkingLevels.map((level) => (
              <SelectItem key={level} value={level}>
                {thinkingLevelLabel(level)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span id="default-permissions-label" className="text-xs text-ink-muted">
          Permissions
        </span>
        <Select
          value={permissionMode}
          onValueChange={(value: StartupPermissionMode) =>
            update({ ...defaults, permissionMode: value })
          }
        >
          <SelectTrigger className="w-full" aria-labelledby="default-permissions-label">
            <SelectValue>{permissionModeLabel(permissionMode)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <PermissionModeItems
              options={offeredPermissionModes(
                CREATE_PERMISSION_MODE_OPTIONS,
                disabledPermissionModesFor([], model),
                permissionMode
              )}
            />
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

interface ModelRowEntry {
  readonly value: string
  readonly displayName: string
  readonly offered: boolean
  readonly preference: ModelPreference | undefined
  readonly canHide: boolean
}

function PreferenceToggle({
  label,
  pressed,
  blockedReason,
  onToggle,
  children
}: {
  readonly label: string
  readonly pressed: boolean
  readonly blockedReason: string | undefined
  readonly onToggle: () => void
  readonly children: React.ReactNode
}) {
  const button = (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      tabIndex={-1}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={blockedReason !== undefined}
      className={cn(pressed ? 'text-ink' : 'text-ink-muted', '[&_svg]:size-3.5')}
      onClick={blockedReason === undefined ? onToggle : undefined}
    >
      {children}
    </Button>
  )
  if (blockedReason === undefined) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{blockedReason}</TooltipContent>
    </Tooltip>
  )
}

function ModelRow({
  entry,
  active,
  onFocus,
  onSet,
  rowRef
}: {
  readonly entry: ModelRowEntry
  readonly active: boolean
  readonly onFocus: () => void
  readonly onSet: (preference: ModelPreference | null) => void
  readonly rowRef: (element: HTMLLIElement | null) => void
}) {
  const favourite = entry.preference === 'favourite'
  const hidden = entry.preference === 'hidden'
  const hideBlocked = hidden || entry.canHide ? undefined : LAST_VISIBLE_MODEL_MESSAGE
  const toggleFavourite = () => onSet(favourite ? null : 'favourite')
  const toggleHidden = () => onSet(hidden ? null : 'hidden')

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !entry.offered) return
    const key = event.key.toLowerCase()
    if (key === 'f') {
      event.preventDefault()
      toggleFavourite()
    }
    if (key === 'h' && hideBlocked === undefined) {
      event.preventDefault()
      toggleHidden()
    }
  }

  return (
    <li
      ref={rowRef}
      tabIndex={active ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      aria-label={entry.displayName}
      className="flex items-center gap-3 rounded-md px-2 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      data-model={entry.value}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={cn('text-sm', hidden ? 'text-ink-muted' : 'text-ink')}>
          {entry.displayName}
        </span>
        <span className="truncate font-mono text-xs text-ink-muted">{entry.value}</span>
        {entry.offered ? null : <span className="text-xs text-ink-muted">No longer offered</span>}
      </div>
      {entry.offered ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <PreferenceToggle
            label={`Favourite ${entry.displayName}`}
            pressed={favourite}
            blockedReason={undefined}
            onToggle={toggleFavourite}
          >
            <StarIcon fill={favourite ? 'currentColor' : 'none'} />
          </PreferenceToggle>
          <PreferenceToggle
            label={`Hide ${entry.displayName}`}
            pressed={hidden}
            blockedReason={hideBlocked}
            onToggle={toggleHidden}
          >
            <EyeOffIcon />
          </PreferenceToggle>
        </div>
      ) : (
        <Button type="button" size="xs" variant="ghost" tabIndex={-1} onClick={() => onSet(null)}>
          <XIcon />
          Remove
        </Button>
      )}
    </li>
  )
}

interface ModelSections {
  readonly favourites: ReadonlyArray<ModelRowEntry>
  readonly others: ReadonlyArray<ModelRowEntry>
  readonly hidden: ReadonlyArray<ModelRowEntry>
}

const modelSections = (
  models: ReadonlyArray<ModelOptionJson>,
  preferences: AdapterPreferences
): ModelSections => {
  const entryFor = (value: string): ModelRowEntry => {
    const model = models.find((option) => option.value === value)
    return {
      value,
      displayName: model?.displayName ?? value,
      offered: model !== undefined,
      preference: preferences.models[value],
      canHide: model !== undefined && keepsAModelVisible(models, preferences, model.value, 'hidden')
    }
  }
  const favourites = Object.entries(preferences.models)
    .filter(([, preference]) => preference === 'favourite')
    .map(([value]) => entryFor(value))
  const modelsWith = (preference: ModelPreference | undefined) =>
    models
      .filter((model) => preferences.models[model.value] === preference)
      .map((model) => entryFor(model.value))
  return { favourites, others: modelsWith(undefined), hidden: modelsWith('hidden') }
}

function ModelList({
  sections,
  onSet
}: {
  readonly sections: ModelSections
  readonly onSet: (model: string, preference: ModelPreference | null) => void
}) {
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const [active, setActive] = useState({ value: '', index: 0 })
  const rows = useRef(new Map<string, HTMLLIElement>())
  const restoreFocus = useRef(false)
  const shown = [...sections.favourites, ...sections.others, ...(hiddenOpen ? sections.hidden : [])]
  const found = shown.findIndex((entry) => entry.value === active.value)
  const activeIndex = found === -1 ? Math.min(active.index, shown.length - 1) : found
  const activeValue = shown[activeIndex]?.value

  useEffect(() => {
    if (!restoreFocus.current || document.activeElement !== document.body) return
    restoreFocus.current = false
    if (activeValue !== undefined) rows.current.get(activeValue)?.focus()
  })

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0 || !(event.target instanceof HTMLLIElement)) return
    event.preventDefault()
    const next = Math.max(0, Math.min(shown.length - 1, activeIndex + step))
    rows.current.get(shown[next].value)?.focus()
  }

  const row = (entry: ModelRowEntry) => (
    <ModelRow
      key={entry.value}
      entry={entry}
      active={entry.value === activeValue}
      onFocus={() => setActive({ value: entry.value, index: shown.indexOf(entry) })}
      onSet={(preference) => {
        restoreFocus.current = true
        onSet(entry.value, preference)
      }}
      rowRef={(element) => {
        if (element === null) rows.current.delete(entry.value)
        else rows.current.set(entry.value, element)
      }}
    />
  )
  const section = (title: string, entries: ReadonlyArray<ModelRowEntry>) =>
    entries.length === 0 ? null : (
      <div className="flex flex-col gap-0.5">
        <h4 className="px-2 py-1 text-xs text-ink-muted">{title}</h4>
        <ul className="flex flex-col">{entries.map(row)}</ul>
      </div>
    )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the focusable rows inside
    <div
      className="flex flex-col gap-2"
      onKeyDown={move}
      onBlur={(event) => {
        if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) {
          restoreFocus.current = false
        }
      }}
    >
      {section('Favourites', sections.favourites)}
      {section('Other models', sections.others)}
      {sections.hidden.length === 0 ? null : (
        <div className="flex flex-col gap-0.5">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={hiddenOpen}
            aria-controls="hidden-models"
            className="self-start text-ink-muted"
            onClick={() => setHiddenOpen((open) => !open)}
          >
            <ChevronRightIcon
              data-icon="inline-start"
              className={cn(
                'transition-transform duration-150 ease-out motion-reduce:transition-none',
                hiddenOpen && 'rotate-90'
              )}
            />
            Hidden · {sections.hidden.length}
          </Button>
          {hiddenOpen ? (
            <ul id="hidden-models" className="flex flex-col">
              {sections.hidden.map(row)}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  )
}

function ModelsSection({
  catalog,
  preferences
}: {
  readonly catalog: ModelCatalog
  readonly preferences: AdapterPreferences
}) {
  const { state, refresh } = catalog
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const refreshing = state !== undefined && state._tag !== 'Loading' && state.refreshing

  const set = async (model: string, preference: ModelPreference | null) => {
    const refused = await window.dia.adapter.setModelPreference(model, preference)
    setRefusal(refused?.message)
  }

  const refreshButton = (label: string) => (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-disabled={refreshing}
      onClick={refreshing ? undefined : refresh}
    >
      {refreshing ? <Loader2Icon className="motion-safe:animate-spin" /> : <RefreshCwIcon />}
      {label}
    </Button>
  )

  if (state === undefined || state._tag === 'Loading') {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-52" />
      </div>
    )
  }

  if (state._tag === 'Unavailable') {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink">Couldn't load models</span>
          {refreshButton('Retry')}
        </div>
        <p className="max-h-32 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-ink-muted">
          {state.message}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <ModelList
        sections={modelSections(state.models, preferences)}
        onSet={(model, preference) => void set(model, preference)}
      />
      <div className="flex items-center justify-between gap-2 px-2">
        <span
          className="text-xs text-ink-muted tabular-nums"
          title={state.lastRefreshError ?? undefined}
        >
          {state.lastRefreshError === undefined ? 'List from' : "Couldn't refresh · list from"}{' '}
          {formatWhen(state.fetchedAt)}
        </span>
        {refreshButton('Refresh')}
      </div>
      <p role="status" className="px-2 text-xs text-ink empty:hidden">
        {refusal}
      </p>
      <p className="px-2 text-xs text-ink-muted">
        Press <kbd className="font-mono">F</kbd> to favourite or <kbd className="font-mono">H</kbd>{' '}
        to hide the focused model.
      </p>
    </div>
  )
}

/**
 * The Claude Code install status as one short label ("Ready", "Not installed", …), for the status
 * line of the Claude Code row in the adapter list. Renders nothing until the first status arrives.
 */
export function ClaudeCodeHealthLabel() {
  const status = useAdapterStatus()
  if (status === undefined) return null
  return <span>{healthLabel(status.health, status.checking)}</span>
}

/**
 * The Claude Code adapter settings: its install health with the executable it runs, the defaults
 * new agents start with, and the model list with favourite and hidden toggles. It re-checks the
 * install on mount when the last check is more than five minutes old. Render it inside a
 * scrolling container; it sizes to its content.
 */
export function ClaudeCodeSettings() {
  const status = useAdapterStatus()
  const catalog = useModelCatalog()
  const preferences = useModelPreferences() ?? EMPTY_ADAPTER_PREFERENCES
  const checkedOnOpen = useRef(false)
  const models = catalog.state?._tag === 'Ready' ? catalog.state.models : []

  useEffect(() => {
    if (status === undefined || checkedOnOpen.current) return
    checkedOnOpen.current = true
    if (!status.checking && isStale(status.health)) void window.dia.adapter.checkHealth()
  }, [status])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6">
      <section className="flex flex-col gap-3" aria-labelledby="health-heading">
        <SectionHeading id="health-heading">Health</SectionHeading>
        <HealthSection status={status} />
      </section>
      <section className="flex flex-col gap-3 border-t pt-6" aria-labelledby="defaults-heading">
        <SectionHeading id="defaults-heading">Defaults for new agents</SectionHeading>
        <DefaultsSection models={models} preferences={preferences} />
      </section>
      <section className="flex flex-col gap-3 border-t pt-6" aria-labelledby="models-heading">
        <SectionHeading id="models-heading">Models</SectionHeading>
        <ModelsSection catalog={catalog} preferences={preferences} />
      </section>
    </div>
  )
}
