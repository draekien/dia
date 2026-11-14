import { useAtomValue } from '@effect/atom-react'
import type { PaneId } from '@shared/domain/pane'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { appRegistry } from './workspace-atoms'

/** The shortest the region can be dragged to, in px. */
export const BOTTOM_PANEL_MIN_HEIGHT = 160
/** The region's height in a tab that has not been resized, in px. */
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 280
/** The shortest the transcript and composer above the region can become, in px. */
export const TRANSCRIPT_MIN_HEIGHT = 240

/** One tab's bottom panel: whether it is open, the key of the panel the user chose, and its height in px. */
export interface BottomPanelState {
  readonly open: boolean
  readonly selected: string | undefined
  readonly height: number
}

const CLOSED: BottomPanelState = {
  open: false,
  selected: undefined,
  height: BOTTOM_PANEL_DEFAULT_HEIGHT
}

const log = (message: string, annotations?: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

const bottomPanelStateAtom = Atom.family((_paneId: PaneId) =>
  Atom.make<BottomPanelState>(CLOSED).pipe(Atom.keepAlive)
)

const bottomPanelsAvailableAtom = Atom.make(false).pipe(Atom.keepAlive)

const update = (paneId: PaneId, change: Partial<BottomPanelState>): void => {
  const atom = bottomPanelStateAtom(paneId)
  appRegistry.set(atom, { ...appRegistry.get(atom), ...change })
}

/** The bottom panel state of the tab showing `paneId`; closed at the default height until changed. */
export function useBottomPanel(paneId: PaneId): BottomPanelState {
  return useAtomValue(bottomPanelStateAtom(paneId))
}

/** Whether the visible tab has any bottom panel to show, as last recorded by {@link recordBottomPanelsAvailable}. */
export function useBottomPanelsAvailable(): boolean {
  return useAtomValue(bottomPanelsAvailableAtom)
}

/**
 * Records whether the visible tab has any bottom panel, for the header toggle. Call it from the
 * component that draws the region with `true` or `false` as panels come and go, and with `false`
 * when it unmounts.
 */
export const recordBottomPanelsAvailable = (available: boolean): void => {
  if (appRegistry.get(bottomPanelsAvailableAtom) === available) return
  appRegistry.set(bottomPanelsAvailableAtom, available)
  log('The bottom panels available changed', { available })
}

/** Opens the bottom panel of the tab showing `paneId`, or closes it when open. */
export const toggleBottomPanel = (paneId: PaneId): void => {
  const open = !appRegistry.get(bottomPanelStateAtom(paneId)).open
  update(paneId, { open })
  log('Toggled the bottom panel', { paneId, open })
}

/** Shows the panel with `key` in the bottom panel of the tab showing `paneId`. */
export const selectBottomPanel = (paneId: PaneId, key: string): void => {
  update(paneId, { selected: key })
  log('Selected a bottom panel', { paneId, key })
}

/** Sets the bottom panel height of the tab showing `paneId` to `height` px. */
export const resizeBottomPanel = (paneId: PaneId, height: number): void => {
  update(paneId, { height })
  log('Resized the bottom panel', { paneId, height })
}

/**
 * The height in px to give the region when the user asks for `height` in a column `columnHeight`
 * px tall: at least {@link BOTTOM_PANEL_MIN_HEIGHT}, and no taller than leaves the transcript and
 * composer {@link TRANSCRIPT_MIN_HEIGHT}.
 */
export const fitBottomPanelHeight = (height: number, columnHeight: number): number =>
  Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.min(height, columnHeight - TRANSCRIPT_MIN_HEIGHT))
