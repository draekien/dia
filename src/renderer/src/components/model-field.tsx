import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import type { ModelCatalog } from '@renderer/hooks/use-model-catalog'
import { formatWhen } from '@renderer/lib/format-when'
import { cn } from '@renderer/lib/utils'
import { type AdapterPreferences, pickerModels } from '@shared/domain/model-preferences'
import { Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type CatalogState = NonNullable<ModelCatalog['state']>

const isRefreshing = (state: CatalogState | undefined): boolean =>
  state !== undefined && state._tag !== 'Loading' && state.refreshing

const refreshOutcome = (state: CatalogState): string =>
  state._tag === 'Ready' && state.lastRefreshError === undefined
    ? 'Model list updated'
    : "Couldn't refresh models"

/**
 * Whether `model` is one the New agent form offers with `catalog` and `preferences`: a favourite
 * or visible model of a ready list. Disable Start while it is false.
 */
export const isOfferedModel = (
  catalog: ModelCatalog,
  preferences: AdapterPreferences | undefined,
  model: string | undefined
): boolean => {
  if (catalog.state?._tag !== 'Ready' || preferences === undefined || model === undefined) {
    return false
  }
  const { favourites, others } = pickerModels(catalog.state.models, preferences)
  return [...favourites, ...others].some((option) => option.value === model)
}

interface ModelFieldProps {
  readonly catalog: ModelCatalog
  readonly preferences: AdapterPreferences | undefined
  readonly value: string | undefined
  readonly onValueChange: (value: string) => void
  readonly disabled: boolean
}

/**
 * The New agent form's model choice: the favourite models, then the other visible models, from
 * {@link ModelCatalog} and the adapter's `preferences`. While `value` is `undefined` and both are
 * known, it reports the default model through `onValueChange` (`preferences.defaults.model` when
 * offered, else the first offered model). A `value` that stops being offered stays selected and is
 * marked "No longer offered"; check {@link isOfferedModel} before starting an agent. It offers a
 * refresh, and a retry when no list could be read, and announces refresh outcomes to screen
 * readers.
 */
export function ModelField({
  catalog,
  preferences,
  value,
  onValueChange,
  disabled
}: ModelFieldProps) {
  const { state, refresh } = catalog
  const [announcement, setAnnouncement] = useState('')
  const wasRefreshing = useRef(false)
  const refreshing = isRefreshing(state)
  const picked =
    state?._tag === 'Ready' && preferences !== undefined
      ? pickerModels(state.models, preferences)
      : undefined
  const offered = picked === undefined ? undefined : [...picked.favourites, ...picked.others]
  const defaultModel = preferences?.defaults.model
  const offeredValue = offered?.some((model) => model.value === value) ?? true

  useEffect(() => {
    if (value !== undefined || offered === undefined || offered.length === 0) return
    const preferred = offered.find((model) => model.value === defaultModel) ?? offered[0]
    onValueChange(preferred.value)
  }, [offered, defaultModel, value, onValueChange])

  useEffect(() => {
    if (state === undefined) return
    if (refreshing && !wasRefreshing.current) setAnnouncement('Refreshing models')
    if (!refreshing && wasRefreshing.current) setAnnouncement(refreshOutcome(state))
    wasRefreshing.current = refreshing
  }, [state, refreshing])

  const requestRefresh = () => {
    if (!refreshing) refresh()
  }

  return (
    <div className="flex flex-col gap-1">
      <span id="model-label" className="text-xs text-ink-muted">
        Model
      </span>
      {state?._tag === 'Unavailable' ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-ink">Couldn't load models</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-disabled={refreshing}
              onClick={requestRefresh}
            >
              {refreshing ? (
                <Loader2Icon className="motion-safe:animate-spin" />
              ) : (
                <RefreshCwIcon />
              )}
              Retry
            </Button>
          </div>
          <p className="max-h-32 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-ink-muted">
            {state.message}
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Select
            value={value ?? ''}
            onValueChange={onValueChange}
            disabled={disabled || offered === undefined}
          >
            <SelectTrigger
              className="min-w-0 flex-1"
              aria-labelledby="model-label"
              aria-describedby={offeredValue ? undefined : 'model-not-offered'}
            >
              <SelectValue placeholder="Loading models…" />
            </SelectTrigger>
            <SelectContent>
              {offeredValue || value === undefined ? null : (
                <SelectGroup>
                  <SelectItem value={value} className="font-mono">
                    {value}
                  </SelectItem>
                </SelectGroup>
              )}
              {picked === undefined || picked.favourites.length === 0 ? null : (
                <SelectGroup aria-label="Favourite models">
                  {picked.favourites.map((model) => (
                    <SelectItem key={model.value} value={model.value}>
                      {model.displayName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {picked === undefined ||
              picked.favourites.length === 0 ||
              picked.others.length === 0 ? null : (
                <SelectSeparator />
              )}
              <SelectGroup>
                {picked?.others.map((model) => (
                  <SelectItem key={model.value} value={model.value}>
                    {model.displayName}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {offered === undefined ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Refresh models"
                  aria-disabled={refreshing}
                  onClick={requestRefresh}
                >
                  <RefreshCwIcon className={cn(refreshing && 'motion-safe:animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh models</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      {offeredValue ? null : (
        <p id="model-not-offered" className="text-xs text-ink-muted">
          No longer offered · choose another model
        </p>
      )}
      {state?._tag === 'Ready' && state.lastRefreshError !== undefined ? (
        <p className="text-xs text-ink-muted" title={state.lastRefreshError}>
          Couldn't refresh · list from {formatWhen(state.fetchedAt)}
        </p>
      ) : null}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
