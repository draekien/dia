import { ListSlot, type PaneId } from '@dia/plugin'
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
