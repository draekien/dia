import { useModelCatalog } from '@renderer/hooks/use-model-catalog'
import { useModelPreferences } from '@renderer/hooks/use-model-preferences'
import { EMPTY_ADAPTER_PREFERENCES, pickerModels } from '@shared/domain/model-preferences'
import { Bot } from 'lucide-react'
import { openSettings } from './settings/open-settings'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from './ui/select'

const MANAGE_MODELS = 'dia:manage-models'

/**
 * The composer's model choice for a tab running `value`. It lists favourite models, then the
 * other visible models, then "Manage models…", which opens the Claude Code page of the Settings dialog. A `value` the list
 * does not offer shows as its raw id. Choosing a different model calls `onChange`.
 */
export function ModelPicker({
  value,
  onChange
}: {
  readonly value: string
  readonly onChange: (model: string) => void
}) {
  const { state } = useModelCatalog()
  const preferences = useModelPreferences() ?? EMPTY_ADAPTER_PREFERENCES
  const models = state?._tag === 'Ready' ? state.models : []
  const { favourites, others } = pickerModels(models, preferences)
  const listed = [...favourites, ...others].some((model) => model.value === value)

  const choose = (next: string) => {
    if (next === MANAGE_MODELS) openSettings({ page: 'adapters', adapter: 'claude-code' })
    else if (next !== value) onChange(next)
  }

  return (
    <Select value={value} onValueChange={choose}>
      <SelectTrigger
        size="sm"
        aria-label="Model"
        className="gap-1 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent/50"
      >
        <Bot />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {listed ? null : (
          <SelectGroup>
            <SelectItem value={value} className="font-mono">
              {value}
            </SelectItem>
          </SelectGroup>
        )}
        {favourites.length === 0 ? null : (
          <SelectGroup aria-label="Favourite models">
            {favourites.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.displayName}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {favourites.length === 0 || others.length === 0 ? null : <SelectSeparator />}
        {others.length === 0 ? null : (
          <SelectGroup>
            {others.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.displayName}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        <SelectSeparator />
        <SelectGroup>
          <SelectItem value={MANAGE_MODELS}>Manage models…</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
