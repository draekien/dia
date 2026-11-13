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
