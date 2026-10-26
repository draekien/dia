import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import type { ModelCatalog } from '@renderer/hooks/use-model-catalog'
import { formatWhen } from '@renderer/lib/format-when'
import { cn } from '@renderer/lib/utils'
import { Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type CatalogState = NonNullable<ModelCatalog['state']>

const isRefreshing = (state: CatalogState | undefined): boolean =>
  state !== undefined && state._tag !== 'Loading' && state.refreshing

const refreshOutcome = (state: CatalogState): string =>
  state._tag === 'Ready' && state.lastRefreshError === undefined
    ? 'Model list updated'
    : "Couldn't refresh models"

interface ModelFieldProps {
  readonly catalog: ModelCatalog
  readonly value: string | undefined
  readonly onValueChange: (value: string) => void
  readonly disabled: boolean
}

/**
 * The New agent form's model choice, fed by {@link ModelCatalog}. It selects the first model
 * whenever `value` is not in the list (on first load, or after a refresh dropped the chosen
 * model) and reports that through `onValueChange`; `value` stays `undefined` while no list is
 * known, so the form cannot start an agent. It offers a refresh, and a retry when no list could
 * be read, and announces refresh outcomes to screen readers.
 */
export function ModelField({ catalog, value, onValueChange, disabled }: ModelFieldProps) {
  const { state, refresh } = catalog
  const [announcement, setAnnouncement] = useState('')
  const wasRefreshing = useRef(false)
  const refreshing = isRefreshing(state)
  const models = state?._tag === 'Ready' ? state.models : undefined

  useEffect(() => {
    if (models === undefined || models.some((model) => model.value === value)) return
    const first = models[0]
    if (value !== undefined) setAnnouncement(`Model changed to ${first.displayName}`)
    onValueChange(first.value)
  }, [models, value, onValueChange])

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
            disabled={disabled || models === undefined}
          >
            <SelectTrigger className="min-w-0 flex-1" aria-labelledby="model-label">
              <SelectValue placeholder="Loading models…" />
            </SelectTrigger>
            <SelectContent>
              {models?.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {models === undefined ? null : (
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
