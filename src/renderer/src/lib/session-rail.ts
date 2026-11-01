import { useAtomValue } from '@effect/atom-react'
import type { PaneId } from '@shared/domain/pane'
import type { PluginServices } from '@shared/plugin/api'
import { Effect, Option, Schema, type Scope } from 'effect'
import { Atom } from 'effect/reactivity'
import { type ComponentType, useEffect } from 'react'
import { appRegistry } from './workspace-atoms'

/** A card a plugin adds to the session rail with {@link addRailCard}. */
export interface RailCard {
  /** Unique within the plugin, for example `context`. */
  readonly id: string
  /** The card's header text, for example `Context`. */
  readonly title: string
  /** Renders the card's body for the visible pane; the rail draws the frame and header. */
  readonly component: ComponentType<{ readonly paneId: PaneId }>
}

/** A {@link RailCard} as the rail holds it, with its app-wide `key` (`<plugin>.<id>`). */
export interface RegisteredRailCard extends RailCard {
  readonly key: string
}

const OPEN_KEY = 'dia.rail.open'
const HIDDEN_KEY = 'dia.rail.hidden'
const CARD_WIDTH = 288
const CARD_GAP = 16
const RAIL_SPACE = CARD_WIDTH + 2 * CARD_GAP

const log = (message: string, annotations?: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

const decodeHidden = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

/** Every card plugins added, in the order they were added. */
export const railCardsAtom = Atom.make<ReadonlyArray<RegisteredRailCard>>([]).pipe(Atom.keepAlive)

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

/**
 * Adds `card` to the session rail for as long as the plugin's scope is open. Its key is
 * `<plugin name>.<card.id>`; adding the same id again, as a reload does, replaces the card in
 * place. Call it from a renderer plugin's setup.
 */
export const addRailCard = (
  ctx: PluginServices,
  card: RailCard
): Effect.Effect<void, never, Scope.Scope> => {
  const entry: RegisteredRailCard = { ...card, key: `${ctx.name}.${card.id}` }
  return Effect.acquireRelease(
    Effect.sync(() =>
      appRegistry.update(railCardsAtom, (cards) =>
        cards.some((existing) => existing.key === entry.key)
          ? cards.map((existing) => (existing.key === entry.key ? entry : existing))
          : [...cards, entry]
      )
    ).pipe(Effect.tap(() => Effect.logDebug('Added a session rail card', { key: entry.key }))),
    () =>
      Effect.sync(() =>
        appRegistry.update(railCardsAtom, (cards) => cards.filter((existing) => existing !== entry))
      ).pipe(Effect.tap(() => Effect.logDebug('Removed a session rail card', { key: entry.key })))
  )
}

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
  const shown = useAtomValue(railShownAtom)
  const hidden = useAtomValue(hiddenRailCardsAtom)
  const cards = useAtomValue(railCardsAtom)
  return shown && !hidden.includes(key) && cards.some((card) => card.key === key)
}
