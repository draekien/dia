// @effect-diagnostics globalDate:off -- the health check age is compared against wall-clock time; no Effect runtime exists in the renderer.
// @effect-diagnostics asyncFunction:off -- React callbacks await the Promise-based window.dia bridge; no Effect runtime exists in the renderer.
import { type AdapterStatusJson, useAdapterStatus } from '@renderer/hooks/use-adapter-status'
import { type ModelCatalog, useModelCatalog } from '@renderer/hooks/use-model-catalog'
import { useModelPreferences } from '@renderer/hooks/use-model-preferences'
import { formatWhen } from '@renderer/lib/format-when'
import { CREATE_PERMISSION_MODE_OPTIONS } from '@renderer/lib/permission-modes'
import { THINKING_LEVEL_OPTIONS } from '@renderer/lib/thinking-levels'
import { cn } from '@renderer/lib/utils'
import {
  type AdapterPreferences,
  type AgentDefaults,
  EMPTY_ADAPTER_PREFERENCES,
  keepsAModelVisible,
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
  ArrowLeftIcon,
  EyeOffIcon,
  FileIcon,
  Loader2Icon,
  RefreshCwIcon,
  StarIcon,
  XIcon
} from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from './ui/select'
import { Skeleton } from './ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const OPEN_EVENT = 'dia:open-settings-page'
const STALE_CHECK = Duration.minutes(5)
const FIRST_LISTED = 'dia:first-listed'
const LAST_VISIBLE = 'At least one model must stay visible'

/**
 * Asks the app shell to show the Settings page, from anywhere in the renderer (the command
 * palette, the model picker and the install notice use it). A mounted shell that listens with
 * {@link onSettingsPageRequested} responds.
 */
export function openSettingsPage(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

/**
 * Calls `listener` whenever {@link openSettingsPage} is called. Returns a function that stops
 * listening.
 */
export function onSettingsPageRequested(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener)
  return () => window.removeEventListener(OPEN_EVENT, listener)
}

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
              {installPathOverride === null ? 'Found on PATH' : 'Chosen by you'}
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
          Change…
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
  const modelValue =
    defaults.model !== undefined && listed.some((model) => model.value === defaults.model)
      ? defaults.model
      : FIRST_LISTED

  const update = (next: AgentDefaults) => void window.dia.adapter.setDefaults(next)

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span id="default-model-label" className="text-xs text-ink-muted">
          Model
        </span>
        <Select
          value={modelValue}
          onValueChange={(value) =>
            update({ ...defaults, model: value === FIRST_LISTED ? undefined : value })
          }
        >
          <SelectTrigger className="w-full" aria-labelledby="default-model-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={FIRST_LISTED}>First listed</SelectItem>
            </SelectGroup>
            {listed.length === 0 ? null : <SelectSeparator />}
            <SelectGroup>
              {listed.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.displayName}
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
          value={defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL}
          onValueChange={(value: ThinkingLevel) => update({ ...defaults, thinkingLevel: value })}
        >
          <SelectTrigger className="w-full" aria-labelledby="default-thinking-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THINKING_LEVEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
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
          value={defaults.permissionMode ?? 'auto'}
          onValueChange={(value: StartupPermissionMode) =>
            update({ ...defaults, permissionMode: value })
          }
        >
          <SelectTrigger className="w-full" aria-labelledby="default-permissions-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CREATE_PERMISSION_MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
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

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 'f' && entry.offered) {
      event.preventDefault()
      onSet(favourite ? null : 'favourite')
    }
    if (key === 'h' && entry.offered && (hidden || entry.canHide)) {
      event.preventDefault()
      onSet(hidden ? null : 'hidden')
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
            onToggle={() => onSet(favourite ? null : 'favourite')}
          >
            <StarIcon fill={favourite ? 'currentColor' : 'none'} />
          </PreferenceToggle>
          <PreferenceToggle
            label={`Hide ${entry.displayName}`}
            pressed={hidden}
            blockedReason={hidden || entry.canHide ? undefined : LAST_VISIBLE}
            onToggle={() => onSet(hidden ? null : 'hidden')}
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

const modelEntries = (
  models: ReadonlyArray<ModelOptionJson>,
  preferences: AdapterPreferences
): ReadonlyArray<ModelRowEntry> => {
  const offered = new Set(models.map((model) => model.value))
  const listed = models.map((model) => ({
    value: model.value,
    displayName: model.displayName,
    offered: true,
    preference: preferences.models[model.value],
    canHide: keepsAModelVisible(models, preferences, model.value, 'hidden')
  }))
  const gone = Object.entries(preferences.models)
    .filter(([value, preference]) => preference === 'favourite' && !offered.has(value))
    .map(([value]) => ({
      value,
      displayName: value,
      offered: false,
      preference: 'favourite' as const,
      canHide: false
    }))
  return [...listed, ...gone]
}

function ModelList({
  entries,
  onSet
}: {
  readonly entries: ReadonlyArray<ModelRowEntry>
  readonly onSet: (model: string, preference: ModelPreference | null) => void
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  const rows = useRef<Array<HTMLLIElement | null>>([])
  const active = Math.min(activeIndex, entries.length - 1)

  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = Math.max(0, Math.min(entries.length - 1, active + step))
    setActiveIndex(next)
    rows.current[next]?.focus()
  }

  return (
    <ul className="flex flex-col" aria-label="Models" onKeyDown={move}>
      {entries.map((entry, index) => (
        <ModelRow
          key={entry.value}
          entry={entry}
          active={index === active}
          onFocus={() => setActiveIndex(index)}
          onSet={(preference) => onSet(entry.value, preference)}
          rowRef={(element) => {
            rows.current[index] = element
          }}
        />
      ))}
    </ul>
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
        entries={modelEntries(state.models, preferences)}
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
 * The Settings page: for the agent adapter (Claude Code), its install health with the executable
 * it runs, the defaults new agents start with, and the model list with favourite and hidden
 * toggles. It re-checks the install on open when the last check is more than five minutes old.
 * Pressing Escape calls `onClose`. Render it in place of the pane area; it fills the space it is
 * given.
 */
export function SettingsPage({ onClose }: { readonly onClose: () => void }) {
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

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="settings-heading">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Button size="xs" variant="ghost" onClick={onClose}>
          <ArrowLeftIcon />
          Agents
        </Button>
        <h1 id="settings-heading" className="text-base font-semibold tracking-tight text-ink">
          Settings
        </h1>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6">
          <h2 className="text-base font-semibold text-ink">Claude Code</h2>
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
      </ScrollArea>
    </section>
  )
}
