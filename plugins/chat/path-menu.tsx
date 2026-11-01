import { cn, ScrollArea } from '@dia/renderer-plugin'
import type { ProjectEntry } from '@shared/domain/attachment'
import { FileIcon, FolderIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'

/** The DOM id of a pane's `@` path listbox, for the input's `aria-controls`. Stable per `paneId`. */
export const pathMenuListboxId = (paneId: string): string => `${paneId}-path-menu`

/**
 * The DOM id of one path option, for the input's `aria-activedescendant`. Stable per `paneId`
 * and `index`.
 */
export const pathMenuOptionId = (paneId: string, index: number): string =>
  `${paneId}-path-option-${index}`

/**
 * The `@` path popover above a pane's message input: a listbox of `entries` (paths relative to
 * the working directory), with `highlightedIndex` as the active option. Controlled like the `/`
 * menu: keyboard navigation lives in the input. `onSelect` fires when an option is clicked,
 * `onHighlight` when the pointer moves over one. Shows `Searching files…` while `loading` and
 * `No matching files` when nothing matches.
 */
export function PathMenu({
  paneId,
  entries,
  loading,
  highlightedIndex,
  onSelect,
  onHighlight
}: {
  paneId: string
  entries: ReadonlyArray<ProjectEntry>
  loading: boolean
  highlightedIndex: number
  onSelect: (entry: ProjectEntry) => void
  onHighlight: (index: number) => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.children.item(highlightedIndex)?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  return (
    <ScrollArea
      className={cn(
        'absolute right-0 bottom-full left-0 z-50 mb-2 rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none',
        '[&>[data-slot=scroll-area-viewport]]:max-h-64',
        '[&>[data-slot=scroll-area-viewport]>div]:block!'
      )}
    >
      <div
        ref={listRef}
        id={pathMenuListboxId(paneId)}
        role="listbox"
        aria-label="Files and folders"
        aria-busy={loading}
        className="p-1"
      >
        {entries.length === 0 && (
          <div className="px-2 py-1.5 text-muted-foreground text-sm">
            {loading ? 'Searching files…' : 'No matching files'}
          </div>
        )}
        {entries.map((entry, index) => {
          const isActive = index === highlightedIndex
          const slash = entry.path.lastIndexOf('/')
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: activedescendant pattern keeps focus on the input, not the options
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled at the input, onClick is the pointer affordance
            <div
              key={entry.path}
              id={pathMenuOptionId(paneId, index)}
              role="option"
              aria-selected={isActive}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => onHighlight(index)}
              onClick={() => onSelect(entry)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm [&_svg]:size-3.5 [&_svg]:shrink-0',
                isActive && 'bg-accent text-accent-foreground'
              )}
            >
              {entry.kind === 'directory' ? <FolderIcon /> : <FileIcon />}
              <span className="min-w-0 truncate" title={entry.path}>
                {slash >= 0 && (
                  <span
                    className={isActive ? 'text-accent-foreground/70' : 'text-muted-foreground'}
                  >
                    {entry.path.slice(0, slash + 1)}
                  </span>
                )}
                {entry.path.slice(slash + 1)}
                {entry.kind === 'directory' && '/'}
              </span>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
