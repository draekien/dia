import { cn } from '@dia/renderer-plugin'
import { type KeyboardEvent, type ReactNode, useId } from 'react'

/** One row of an {@link EntryList}: its id and what the row shows. */
export interface Entry {
  readonly id: string
  readonly content: ReactNode
}

const MOVES: Record<string, (index: number, last: number) => number> = {
  ArrowDown: (index, last) => Math.min(index + 1, last),
  ArrowUp: (index) => Math.max(index - 1, 0),
  Home: () => 0,
  End: (_, last) => last
}

/**
 * A single-select `listbox` of `entries` named `label`, for the left column of a list and detail
 * page. Clicking a row, or Arrow Up, Arrow Down, Home and End while the list has focus, calls
 * `onSelect` with the row's id; the row whose id is `selectedId` shows the selected-row fill.
 */
export function EntryList({
  label,
  entries,
  selectedId,
  onSelect
}: {
  readonly label: string
  readonly entries: ReadonlyArray<Entry>
  readonly selectedId: string | undefined
  readonly onSelect: (id: string) => void
}) {
  const listId = useId()
  const optionId = (id: string) => `${listId}-${id}`

  const move = (event: KeyboardEvent) => {
    const step = MOVES[event.key]
    if (step === undefined || entries.length === 0) return
    event.preventDefault()
    const index = entries.findIndex((entry) => entry.id === selectedId)
    const next = entries[step(Math.max(index, 0), entries.length - 1)]
    if (next !== undefined) onSelect(next.id)
  }

  return (
    <div
      role="listbox"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={selectedId === undefined ? undefined : optionId(selectedId)}
      onKeyDown={move}
      className="flex flex-col gap-px rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {entries.map((entry) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard
        <div
          key={entry.id}
          id={optionId(entry.id)}
          role="option"
          tabIndex={-1}
          aria-selected={entry.id === selectedId}
          onClick={() => onSelect(entry.id)}
          className={cn(
            'flex min-w-0 cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-secondary',
            entry.id === selectedId && 'bg-primary/10 font-medium hover:bg-primary/10'
          )}
        >
          {entry.content}
        </div>
      ))}
    </div>
  )
}
