import { cn } from '@renderer/lib/utils'
import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { useEffect, useRef } from 'react'
import { ScrollArea } from './ui/scroll-area'

/**
 * The DOM id of the menu's listbox for a pane, used to wire the input's
 * `aria-controls`. Stable per `paneId`.
 */
export const slashMenuListboxId = (paneId: string): string => `${paneId}-slash-menu`

/**
 * The DOM id of one menu option, used to wire the input's `aria-activedescendant`
 * to the highlighted command. Stable per `paneId` and `index`.
 */
export const slashMenuOptionId = (paneId: string, index: number): string =>
  `${paneId}-slash-option-${index}`

/**
 * The `/` command popover for a pane's message input: a listbox of `commands`
 * floating above the input, with `highlightedIndex` shown as the active option.
 * Purely presentational and controlled — selection state and keyboard
 * navigation live in the parent input; this only renders and reports intent.
 * `onSelect` fires when an option is clicked, `onHighlight` when the pointer
 * moves over one (keep it in sync with keyboard navigation). Render only when
 * there is at least one command to show. Options use `onMouseDown` with
 * `preventDefault` so clicking never blurs the textarea.
 */
export function SlashCommandMenu({
  paneId,
  commands,
  highlightedIndex,
  onSelect,
  onHighlight
}: {
  paneId: string
  commands: ReadonlyArray<SlashCommandInfo>
  highlightedIndex: number
  onSelect: (command: SlashCommandInfo) => void
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
        id={slashMenuListboxId(paneId)}
        role="listbox"
        aria-label="Slash commands"
        className="p-1"
      >
        {commands.map((command, index) => {
          const isActive = index === highlightedIndex
          return (
            // The combobox owns focus and keyboard nav (aria-activedescendant on the input);
            // options are intentionally non-focusable and selected via the input's Enter/Tab.
            // biome-ignore lint/a11y/useFocusableInteractive: activedescendant pattern keeps focus on the input, not the options
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled at the input, onClick is the pointer affordance
            <div
              key={command.name}
              id={slashMenuOptionId(paneId, index)}
              role="option"
              aria-selected={isActive}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => onHighlight(index)}
              onClick={() => onSelect(command)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                isActive && 'bg-accent text-accent-foreground'
              )}
            >
              <span className="shrink-0 whitespace-nowrap font-mono" title={`/${command.name}`}>
                /{command.name}
              </span>
              {command.argumentHint !== '' && (
                <span
                  className={cn(
                    'shrink-0 whitespace-nowrap font-mono text-xs',
                    isActive ? 'text-accent-foreground/70' : 'text-muted-foreground'
                  )}
                >
                  {command.argumentHint}
                </span>
              )}
              {command.description !== '' && (
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-xs',
                    isActive ? 'text-accent-foreground/70' : 'text-muted-foreground'
                  )}
                >
                  {command.description}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
