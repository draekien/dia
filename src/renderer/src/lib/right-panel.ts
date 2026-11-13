import { useAtomValue } from '@effect/atom-react'
import type { PaneId } from '@shared/domain/pane'
import type { ListEntry } from '@shared/plugin/list-slot'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import type { ComponentType } from 'react'
import { appRegistry } from './workspace-atoms'

/**
 * A panel the right panel region draws: an entry of the chat plugin's panel list. The region draws
 * the frame and `title`; `component` draws the body for the pane it is given.
 */
export type RightPanelView = ListEntry<{
  readonly id: string
  readonly order: number
  readonly title: string
  readonly component: ComponentType<{ readonly paneId: PaneId }>
}>

/** The app-wide key of `panel`, `<plugin>.<id>`, under which a tab remembers its selected panel. */
export const rightPanelKey = (panel: RightPanelView): string =>
  `${panel.key.plugin}.${panel.key.id}`

/** The narrowest the region can be dragged to, in px. */
export const RIGHT_PANEL_MIN_WIDTH = 240
/** The region's width in a tab that has not been resized, in px. */
export const RIGHT_PANEL_DEFAULT_WIDTH = 400
/** The narrowest the transcript area beside the region can become, in px. */
export const TRANSCRIPT_MIN_WIDTH = 400

/** One tab's right panel: whether it is open, the key of the panel the user chose, and its width in px. */
export interface RightPanelState {
  readonly open: boolean
  readonly selected: string | undefined
  readonly width: number
}

const CLOSED: RightPanelState = {
  open: false,
  selected: undefined,
  width: RIGHT_PANEL_DEFAULT_WIDTH
}

const log = (message: string, annotations?: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

const rightPanelStateAtom = Atom.family((_paneId: PaneId) =>
  Atom.make<RightPanelState>(CLOSED).pipe(Atom.keepAlive)
)

const panelsAvailableAtom = Atom.make(false).pipe(Atom.keepAlive)

const update = (paneId: PaneId, change: Partial<RightPanelState>): void => {
  const atom = rightPanelStateAtom(paneId)
  appRegistry.set(atom, { ...appRegistry.get(atom), ...change })
}

/** The right panel state of the tab showing `paneId`; closed at the default width until changed. */
export function useRightPanel(paneId: PaneId): RightPanelState {
  return useAtomValue(rightPanelStateAtom(paneId))
}

/** Whether the visible tab has any panel to show, as last recorded by {@link recordPanelsAvailable}. */
export function usePanelsAvailable(): boolean {
  return useAtomValue(panelsAvailableAtom)
}

/**
 * Records whether the visible tab has any panel, for the header toggle. Call it from the component
 * that draws the region with `true` or `false` as panels come and go, and with `false` when it unmounts.
 */
export const recordPanelsAvailable = (available: boolean): void => {
  if (appRegistry.get(panelsAvailableAtom) === available) return
  appRegistry.set(panelsAvailableAtom, available)
  log('The right panels available changed', { available })
}

/** Opens the right panel of the tab showing `paneId`, or closes it when open. */
export const toggleRightPanel = (paneId: PaneId): void => {
  const open = !appRegistry.get(rightPanelStateAtom(paneId)).open
  update(paneId, { open })
  log('Toggled the right panel', { paneId, open })
}

/** Shows the panel with `key` in the right panel of the tab showing `paneId`. */
export const selectRightPanel = (paneId: PaneId, key: string): void => {
  update(paneId, { selected: key })
  log('Selected a right panel', { paneId, key })
}

/** Sets the right panel width of the tab showing `paneId` to `width` px. */
export const resizeRightPanel = (paneId: PaneId, width: number): void => update(paneId, { width })

/**
 * The panel to show among `panels` (in list order): the one whose key is `selected`, or the first
 * when `selected` is unset or names a panel that is gone; `undefined` when `panels` is empty.
 */
export const shownPanel = (
  panels: ReadonlyArray<RightPanelView>,
  selected: string | undefined
): RightPanelView | undefined =>
  panels.find((panel) => rightPanelKey(panel) === selected) ?? panels[0]

/**
 * The width in px to give the region when the user asks for `width` in a pane `paneWidth` px wide:
 * at least {@link RIGHT_PANEL_MIN_WIDTH}, and no wider than leaves the transcript
 * {@link TRANSCRIPT_MIN_WIDTH}.
 */
export const fitRightPanelWidth = (width: number, paneWidth: number): number =>
  Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(width, paneWidth - TRANSCRIPT_MIN_WIDTH))
