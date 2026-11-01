import { useAtomValue } from '@effect/atom-react'
import type { PaneId } from '@shared/domain/pane'
import { EllipsisIcon, PanelRightIcon } from 'lucide-react'
import { useEffect, useId } from 'react'
import {
  endRailPeek,
  hiddenRailCardsAtom,
  type RegisteredRailCard,
  railCardsAtom,
  railPeekAtom,
  railShownAtom,
  setRailCardHidden,
  showAllRailCards,
  toggleRail,
  visibleRailCardsAtom
} from '../lib/session-rail'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const MODIFIER_KEY =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)
    ? '⌘'
    : 'Ctrl'

const insideRail = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-session-rail]') !== null

function useEndPeekOnOutsideFocus(peeking: boolean): void {
  useEffect(() => {
    if (!peeking) return
    const onOutside = (event: Event): void => {
      if (!insideRail(event.target)) endRailPeek()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') endRailPeek()
    }
    document.addEventListener('pointerdown', onOutside)
    document.addEventListener('focusin', onOutside)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onOutside)
      document.removeEventListener('focusin', onOutside)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [peeking])
}

function CardChoice({
  card,
  hidden
}: {
  readonly card: RegisteredRailCard
  readonly hidden: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <label htmlFor={id} className="flex h-7 cursor-default items-center gap-2 text-sm text-ink">
      <Checkbox
        id={id}
        checked={!hidden}
        onCheckedChange={(next) => setRailCardHidden(card.key, next !== true)}
      />
      {card.title}
    </label>
  )
}

function CardMenu({ title }: { readonly title: string }): React.JSX.Element {
  const cards = useAtomValue(railCardsAtom)
  const hidden = useAtomValue(hiddenRailCardsAtom)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="-my-1 -mr-1.5 text-ink-muted"
          aria-label={`${title} card options`}
        >
          <EllipsisIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent data-session-rail align="end" className="flex w-56 flex-col gap-1 p-3">
        <span className="pb-1 text-xs font-medium text-ink-muted">Cards</span>
        {cards.map((card) => (
          <CardChoice key={card.key} card={card} hidden={hidden.includes(card.key)} />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function RailCardFrame({
  card,
  paneId
}: {
  readonly card: RegisteredRailCard
  readonly paneId: PaneId
}): React.JSX.Element {
  const titleId = useId()
  const Body = card.component
  return (
    <section
      aria-labelledby={titleId}
      className="pointer-events-auto flex shrink-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 id={titleId} className="text-xs font-medium text-ink-muted">
          {card.title}
        </h2>
        <CardMenu title={card.title} />
      </header>
      <Body paneId={paneId} />
    </section>
  )
}

function AllCardsHidden(): React.JSX.Element {
  return (
    <section className="pointer-events-auto flex items-center justify-between gap-2 rounded-lg border border-border bg-card py-2 pr-2 pl-3 text-xs text-ink-muted">
      All cards hidden
      <Button variant="ghost" size="xs" onClick={showAllRailCards}>
        Show cards
      </Button>
    </section>
  )
}

/**
 * The session rail for `paneId`: the cards plugins added with `addRailCard`, stacked at the top
 * right of the nearest positioned ancestor, over whatever is beneath them. Renders nothing while
 * the rail is off or the cards do not fit and are not shown temporarily. Render it inside the
 * pane's positioned container and size the transcript column with `useRailLayout`.
 */
export function SessionRail({ paneId }: { readonly paneId: PaneId }): React.JSX.Element | null {
  const shown = useAtomValue(railShownAtom)
  const peeking = useAtomValue(railPeekAtom)
  const cards = useAtomValue(railCardsAtom)
  const visible = useAtomValue(visibleRailCardsAtom)
  useEndPeekOnOutsideFocus(peeking)
  if (!shown || cards.length === 0) return null
  return (
    <aside
      data-session-rail
      aria-label="Session details"
      className="pointer-events-none absolute top-4 right-4 bottom-4 z-20 flex w-72 animate-in flex-col gap-2 overflow-y-auto scrollbar-app duration-200 fade-in slide-in-from-right-2 motion-reduce:animate-none"
    >
      {visible.length === 0 ? (
        <AllCardsHidden />
      ) : (
        visible.map((card) => <RailCardFrame key={card.key} card={card} paneId={paneId} />)
      )}
    </aside>
  )
}

/**
 * The content header's rail button, pressed while the cards are on screen, with the shortcut
 * Ctrl/⌘ Shift B. While the cards fit it turns the rail on or off; otherwise it shows the cards
 * over the transcript until focus returns to it. Render it in the header of a tab.
 */
export function RailToggle(): React.JSX.Element {
  const shown = useAtomValue(railShownAtom)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key.toLowerCase() === 'b' &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault()
        toggleRail()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-session-rail
          variant="ghost"
          size="icon-xs"
          aria-label="Session details"
          aria-pressed={shown}
          onClick={toggleRail}
        >
          <PanelRightIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        Session details ({MODIFIER_KEY} Shift B)
      </TooltipContent>
    </Tooltip>
  )
}
