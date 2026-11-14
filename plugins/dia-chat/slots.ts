import { type Attention, ListSlot, type PaneId, type RunAnswer, ServiceKey } from '@dia/plugin'
import type { ComponentType } from 'react'

/** A card on the session rail. The rail draws the card's frame and `title`; `component` draws its body for the visible pane. */
export interface RailCard {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly component: ComponentType<{ readonly paneId: PaneId }>
}

/** The session rail's cards, declared by the chat plugin. Add a card with `addEntry(ctx, RailCardsSlot, card)`. */
export const RailCardsSlot = ListSlot.make<RailCard>('chat.railCards')

/**
 * A panel in the right panel region beside the transcript. The region draws the header with
 * `title`; `component` draws the body for the tab's pane.
 */
export interface Panel {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly component: ComponentType<{ readonly paneId: PaneId }>
}

/**
 * The right panel region's panels, declared by the chat plugin. Every panel applies to every chat
 * tab. Add a panel with `addEntry(ctx, PanelsSlot, panel)`.
 */
export const PanelsSlot = ListSlot.make<Panel>('chat.panels')

/**
 * The bottom panel region's panels, declared by the chat plugin. The region sits under the
 * transcript and composer, draws the header with `title`, and `component` draws the body for the
 * tab's pane. Every panel applies to every chat tab. Add a panel with
 * `addEntry(ctx, BottomPanelsSlot, panel)`.
 */
export const BottomPanelsSlot = ListSlot.make<Panel>('chat.bottomPanels')

/**
 * Content shown at the end of one turn in the transcript, under the turn's last message.
 * `messageIds` are the ids of the user messages that open the turn's stretch of the transcript,
 * in transcript order: the messages sent to start it, as `PaneUserMessagesSent` carries them.
 * `component` may render nothing, as for a turn still running. A component that throws renders
 * nothing.
 */
export interface TurnFooter {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<{
    readonly paneId: PaneId
    readonly messageIds: ReadonlyArray<string>
  }>
}

/**
 * The transcript's turn footers, declared by the chat plugin. Every footer shows under every
 * turn of every chat tab, ordered by `order`. Add one with `addEntry(ctx, TurnFootersSlot, footer)`.
 */
export const TurnFootersSlot = ListSlot.make<TurnFooter>('chat.turnFooters')

/** Props of the request card: `request` is drawn as the pane draws it; `onAnswer` is called once with the user's answer. */
export interface RequestCardProps {
  readonly request: Attention.UserInputRequest
  readonly onAnswer: (answer: RunAnswer) => void
}

/**
 * The card the chat plugin draws an open permission request, clarifying question or plan review
 * with, outside a pane. Read it with `useProvided(RequestCardKey)`; it is `undefined` while the
 * chat plugin is not loaded.
 */
export const RequestCardKey = ServiceKey.make(
  'chatRequestCard',
  (value): value is ComponentType<RequestCardProps> => typeof value === 'function'
)
