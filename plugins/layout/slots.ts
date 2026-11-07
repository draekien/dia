import { ListSlot } from '@dia/plugin'
import type { ComponentType } from 'react'

/** A page in the content area, listed in the sidebar. `label` is the sidebar entry's text and the header's breadcrumb; `component` draws the page body. */
export interface Page {
  readonly id: string
  readonly order: number
  readonly label: string
  readonly icon: ComponentType<{ readonly className?: string }>
  readonly component: ComponentType
}

/** The content area's pages, declared by the layout plugin. Add a page with `addEntry(ctx, PagesSlot, page)`. */
export const PagesSlot = ListSlot.make<Page>('layout.pages')
