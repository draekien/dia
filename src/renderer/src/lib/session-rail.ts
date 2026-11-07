import { useAtomValue } from '@effect/atom-react'
import type { PaneId } from '@shared/domain/pane'
import type { ListEntry } from '@shared/plugin/list-slot'
import { Effect, Option, Schema } from 'effect'
import { Atom } from 'effect/reactivity'
import { type ComponentType, useEffect } from 'react'
import { appRegistry } from './workspace-atoms'

/**
 * A card the session rail draws: an entry of the chat plugin's rail card list. The rail draws the
 * frame and `title`; `component` draws the body for the visible pane.
 */
export type RailCardView = ListEntry<{
  readonly id: string
  readonly order: number
  readonly title: string
  readonly component: ComponentType<{ readonly paneId: PaneId }>
}>

/** The app-wide key of `card`, `<plugin>.<id>`, under which the user's choice to hide it is saved. */
export const railCardKey = (card: RailCardView): string => `${card.key.plugin}.${card.key.id}`

const OPEN_KEY = 'dia.rail.open'
const HIDDEN_KEY = 'dia.rail.hidden'
const CARD_WIDTH = 288
const CARD_GAP = 16
const RAIL_SPACE = CARD_WIDTH + 2 * CARD_GAP

const log = (message: string, annotations?: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

const decodeHidden = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

const chosenOpenAtom = Atom.make<boolean | null>(null).pipe(Atom.keepAlive)

/** Whether the user wants the cards shown while they fit. Set it to change and persist it. */
export const railOpenAtom = Atom.writable(
  (get): boolean => get(chosenOpenAtom) ?? localStorage.getItem(OPEN_KEY) !== '0',
  (ctx, open: boolean) => {
    ctx.set(chosenOpenAtom, open)
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    log('Saved the session rail open state', { open })
  }
).pipe(Atom.keepAlive)

const chosenHiddenAtom = Atom.make<ReadonlyArray<string> | null>(null).pipe(Atom.keepAlive)

/** The keys of the cards the user hid. Set it to change and persist the list. */
export const hiddenRailCardsAtom = Atom.writable(
  (get): ReadonlyArray<string> =>
    get(chosenHiddenAtom) ??
    Option.getOrElse(decodeHidden(localStorage.getItem(HIDDEN_KEY) ?? '[]'), () => []),
  (ctx, hidden: ReadonlyArray<string>) => {
    ctx.set(chosenHiddenAtom, hidden)
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden))
    log('Saved the hidden session rail cards', { hidden })
  }
).pipe(Atom.keepAlive)

const railFitsAtom = Atom.make(false).pipe(Atom.keepAlive)
/** Whether the cards are shown over the transcript because they do not fit beside it. */
export const railPeekAtom = Atom.make(false).pipe(Atom.keepAlive)

/** Whether the cards are on screen: the user's choice while they fit, else a temporary show. */
export const railShownAtom = Atom.make((get): boolean =>
  get(railFitsAtom) ? get(railOpenAtom) : get(railPeekAtom)
).pipe(Atom.keepAlive)

const railCardShownAtom = Atom.family((key: string) =>
  Atom.make((get): boolean => get(railShownAtom) && !get(hiddenRailCardsAtom).includes(key))
)

/**
 * Where a transcript column of at most `columnMax` px sits in a pane `width` px wide, given
 * whether the rail is `open`. `fits` says the cards fit beside the column; `shiftLeft` is how far
 * to move the centred column left so the cards do not cover it (0 when it need not move).
 */
export const railLayout = ({
  width,
  columnMax,
  open
}: {
  width: number
  columnMax: number
  open: boolean
}): { readonly fits: boolean; readonly shiftLeft: number } => {
  const fits = width >= columnMax + RAIL_SPACE
  if (!fits || !open) return { fits, shiftLeft: 0 }
  return { fits, shiftLeft: Math.max(0, RAIL_SPACE - (width - columnMax) / 2) }
}

const recordFits = (fits: boolean): void => {
  if (appRegistry.get(railFitsAtom) === fits) return
  appRegistry.set(railFitsAtom, fits)
  appRegistry.set(railPeekAtom, false)
  log('The session rail cards fit changed', { fits })
}

/**
 * {@link railLayout} for the visible pane, with the rail's open state read for you. Call it from
 * the component that owns the pane's transcript column, with the pane's content `width`
 * (`undefined` before the first measurement); it also tells the header toggle whether the cards fit.
 */
export function useRailLayout(
  width: number | undefined,
  columnMax: number
): { readonly fits: boolean; readonly shiftLeft: number } {
  const open = useAtomValue(railOpenAtom)
  const layout = railLayout({ width: width ?? 0, columnMax, open })
  useEffect(() => {
    if (width !== undefined) recordFits(layout.fits)
  }, [width, layout.fits])
  return layout
}

/**
 * Flips the rail: while the cards fit it turns them on or off and saves that; otherwise it shows
 * them over the transcript, or hides them again, without changing the saved choice.
 */
export const toggleRail = (): void => {
  if (appRegistry.get(railFitsAtom)) {
    appRegistry.set(railOpenAtom, !appRegistry.get(railOpenAtom))
    return
  }
  appRegistry.set(railPeekAtom, !appRegistry.get(railPeekAtom))
  log('Toggled the temporary session rail', { peek: appRegistry.get(railPeekAtom) })
}

/** Hides the cards shown over the transcript by {@link toggleRail}. Does nothing otherwise. */
export const endRailPeek = (): void => {
  if (!appRegistry.get(railPeekAtom)) return
  appRegistry.set(railPeekAtom, false)
  log('Ended the temporary session rail')
}

/** Hides or shows the card with `key`, and saves the choice. */
export const setRailCardHidden = (key: string, hidden: boolean): void => {
  const others = appRegistry.get(hiddenRailCardsAtom).filter((entry) => entry !== key)
  appRegistry.set(hiddenRailCardsAtom, hidden ? [...others, key] : others)
}

/** Shows every card again. */
export const showAllRailCards = (): void => appRegistry.set(hiddenRailCardsAtom, [])

/**
 * Brings the card with `key` into view: unhides it and turns the rail on, or shows the cards over
 * the transcript when they do not fit. Use it from a warning that stands in for a hidden card.
 */
export const revealRailCard = (key: string): void => {
  setRailCardHidden(key, false)
  if (appRegistry.get(railFitsAtom)) appRegistry.set(railOpenAtom, true)
  else appRegistry.set(railPeekAtom, true)
}

/** Whether the card with `key` is on screen now. */
export function useRailCardShown(key: string): boolean {
  return useAtomValue(railCardShownAtom(key))
}
